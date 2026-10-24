"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { once } = require("node:events");

test("authenticated lifecycle action and persistent notifications work through real HTTP and a simulated Engine socket", {
  skip: process.platform === "win32", timeout: 20000,
}, async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "syctl-"));
  const socket = path.join(directory, "engine.sock");
  const id = "a".repeat(64);
  let mutations = 0;
  let held;
  let startedAt = "before";
  const engineReads = [];
  let child;
  const engine = http.createServer((req, res) => {
    if (req.method === "GET") engineReads.push(req.url);
    const json = (value) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(value)); };
    if (req.url === "/containers/json?all=1")
      return json([{ Id: id, Names: ["/web"], Image: "web:test", State: "running", Status: "Up", Ports: [], Labels: {} }]);
    if (req.url === `/containers/${id}/json`)
      return json({ Id: id, Name: "/web", Config: { Image: "web:test", Hostname: "web-test", Tty: false, Env: ["PRIVATE=preview-secret"] },
        State: { Status: "running", StartedAt: startedAt } });
    if (req.url === `/containers/${id}/stats?stream=false`)
      return json({ cpu_stats: { cpu_usage: { total_usage: 200 }, system_cpu_usage: 2000 },
        precpu_stats: { cpu_usage: { total_usage: 100 }, system_cpu_usage: 1000 },
        memory_stats: { usage: 1024, limit: 4096, stats: { inactive_file: 256 } },
        networks: { eth0: { rx_bytes: 120, tx_bytes: 240 } }, pids_stats: { current: 3 } });
    if (req.method === "POST" && req.url === `/containers/${id}/restart?t=10`) {
      mutations++;
      held = res;
      return;
    }
    res.writeHead(404);
    res.end();
  });
  t.after(async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill();
      await exited;
    }
    held?.destroy();
    engine.closeAllConnections();
    await new Promise((resolve) => engine.close(resolve));
    await fs.rm(directory, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => engine.listen(socket, resolve).once("error", reject));

  async function boot() {
    child = spawn(process.execPath, ["-e", `
      (async () => {
        await require('./lib/auth').initAuth();
        const server = require('./server').createServer();
        server.listen(0, '127.0.0.1', () => console.log('READY ' + server.address().port));
      })().catch((error) => { console.error(error); process.exit(1); });
    `], {
      cwd: path.join(__dirname, ".."),
      env: { ...process.env, DATA_DIR: directory, LOG_DIR: path.join(directory, "logs"),
        DOCKER_SOCKET: socket, DOCKER_CONTROL: "true", DASHBOARD_PASSWORD: "test-password",
        DASHBOARD_LOCK_VIEW: "false", TRUST_PROXY: "false", DOCKER_PROTECTED_CONTAINERS: "",
        SHARE_TOKEN: "test-read-only-sharing-token", LOG_LEVEL: "ERROR", CONTAINER_STATS_INTERVAL: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const port = await new Promise((resolve, reject) => {
      let output = "";
      const timeout = setTimeout(() => reject(new Error("Dashboard boot timed out")), 5000);
      child.once("exit", () => { clearTimeout(timeout); reject(new Error("Dashboard exited before ready")); });
      child.stdout.on("data", (chunk) => {
        output += chunk;
        const match = output.match(/READY (\d+)/);
        if (match) { clearTimeout(timeout); resolve(Number(match[1])); }
      });
    });
    return `http://127.0.0.1:${port}`;
  }

  let origin = await boot();
  let cookie = "";
  const call = (url, { method = "GET", body, auth = true, source = origin } = {}) => fetch(origin + url, {
    method, headers: { ...(auth && cookie ? { cookie } : {}),
      ...(body ? { "content-type": "application/json", origin: source } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(4000),
  });
  const body = { id, action: "restart", requestId: "integration-request-123456" };
  assert.equal((await call("/api/docker/action", { method: "POST", body, auth: false })).status, 401);
  assert.equal((await call("/api/activity", { auth: false })).status, 401);
  assert.equal((await call("/api/activity", { method: "DELETE", body: {}, auth: false })).status, 401);
  const login = await call("/api/login", { method: "POST", body: { password: "test-password" } });
  assert.equal(login.status, 200);
  cookie = login.headers.get("set-cookie").split(";")[0];
  assert.equal((await call("/api/docker/action", { method: "POST", body, source: "http://other.test" })).status, 403);
  assert.equal((await call("/api/activity", { method: "DELETE", body: {}, source: "http://other.test" })).status, 403);
  assert.equal(mutations, 0);

  const beforeDetails = engineReads.length;
  const preview = await call(`/api/docker/details?id=${id}`, { auth: false });
  assert.equal(preview.status, 200); // Sanitized details share the existing view policy.
  assert.equal(preview.headers.get("cache-control"), "no-store");
  const details = await preview.json();
  assert.equal(details.usage.cpu, 10);
  assert.equal(details.usage.mem, 768);
  assert.equal(details.container.image, "web:test");
  assert.doesNotMatch(JSON.stringify(details), /PRIVATE|preview-secret/);
  assert.deepEqual(engineReads.slice(beforeDetails), [`/containers/${id}/json`, `/containers/${id}/stats?stream=false`]);

  const accepted = await call("/api/docker/action", { method: "POST", body });
  assert.equal(accepted.status, 202);
  const entry = (await accepted.json()).entry;
  assert.equal(entry.status, "pending");
  // Acceptance is returned independently of the held Engine operation.
  const busy = await (await call("/api/docker")).json();
  assert.equal(busy.control.busy[0].id, id);
  const clearingBusy = await (await call("/api/activity", { method: "DELETE", body: {} })).json();
  assert.equal(clearingBusy.entries[0].id, entry.id);
  assert.equal(clearingBusy.entries[0].status, "pending");
  assert.equal((await call("/api/docker/action", { method: "POST", body: { ...body, requestId: "another-request-123456" } })).status, 409);
  assert.equal((await call("/api/docker/action", { method: "POST", body })).status, 202);
  for (let i = 0; !held && i < 100; i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(held);
  assert.equal(mutations, 1);
  startedAt = "after";
  held.writeHead(204);
  held.end();
  let history;
  for (let i = 0; i < 100; i++) {
    const response = await call("/api/activity");
    assert.equal(response.headers.get("cache-control"), "no-store");
    history = await response.json();
    if (history.entries.find((item) => item.id === entry.id)?.status === "success") break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(history.entries.find((item) => item.id === entry.id).status, "success");
  assert.equal(history.control.busy.length, 0);

  const config = await (await call("/api/config")).json();
  config.config.settings.title = "Integration dashboard";
  assert.equal((await call("/api/config", { method: "PUT", body: { ...config.config, _revision: config.revision } })).status, 200);
  history = await (await call("/api/activity")).json();
  assert.ok(history.entries.some((item) => item.title === "Dashboard configuration updated"));
  assert.doesNotMatch(JSON.stringify(history), /test-password|test-read-only-sharing-token/);

  const cleared = await (await call("/api/activity", { method: "DELETE", body: {} })).json();
  assert.equal(cleared.entries.length, 0);
  assert.equal(cleared.retired[0].id, entry.id);
  assert.equal((await call("/api/docker/action", { method: "POST", body })).status, 200);
  assert.equal(mutations, 1);

  const exited = once(child, "exit");
  child.kill();
  await exited;
  origin = await boot();
  // The persisted session key and history both survive the process restart.
  const restored = await (await call("/api/activity")).json();
  assert.equal(restored.entries.length, 0);
  assert.equal(restored.retired.find((item) => item.id === entry.id).status, "success");
  assert.equal((await call("/api/docker/action", { method: "POST", body })).status, 200);
  assert.equal(mutations, 1);
});
