"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const { once } = require("node:events");

async function start(t, overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "showy-http-"));
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const child = spawn(process.execPath, ["server.js"], {
    cwd: path.resolve(__dirname, ".."),
    env: {
      ...process.env,
      PORT: String(port), DATA_DIR: dir, DASHBOARD_PASSWORD: "",
      DASHBOARD_LOCK_VIEW: "true", SHARE_TOKEN: "", REMOTE_DASHBOARDS: "",
      DOCKER_SOCKET: path.join(dir, "missing.sock"),
      ...overrides,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (data) => output += data);
  child.stderr.on("data", (data) => output += data);
  const exited = once(child, "exit");
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 8000);
    await exited;
    clearTimeout(timer);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const ready = new RegExp(`INFO \\[HTTP\\] Dashboard v\\S+ listening on port ${port}\\b`);
  for (let i = 0; i < 150 && !ready.test(output); i++) {
    if (child.exitCode !== null) throw new Error(output);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.match(output, ready);
  return {
    child, dir, port, exited,
    request: (url, options) => fetch(`http://127.0.0.1:${port}${url}`, {
      ...options, signal: AbortSignal.timeout(5000),
    }),
  };
}

test("isolated real startup serves assets, manifest, API and web edge cases", async (t) => {
  const app = await start(t);
  for (const url of ["/", "/app.css", "/js/main.js", "/favicon.svg", "/icons/icon-192.png", "/manifest.webmanifest", "/api/auth", "/api/config"]) {
    const response = await app.request(url);
    assert.equal(response.status, 200, url);
    assert.ok((await response.arrayBuffer()).byteLength > 0);
  }
  const get = await app.request("/app.css");
  const etag = get.headers.get("etag");
  await get.arrayBuffer();
  const head = await app.request("/app.css", { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("etag"), etag);
  assert.equal(await head.text(), "");
  const cached = await app.request("/app.css", { headers: { "if-none-match": etag } });
  assert.equal(cached.status, 304);
  assert.equal(await cached.text(), "");
  assert.equal((await app.request("/missing-file")).status, 404);
  assert.equal((await app.request("/%ZZ")).status, 400);
  assert.equal((await app.request("/%2e%2e%2fserver.js")).status, 404);
  assert.equal((await app.request("/", { method: "POST" })).status, 405);
});

module.exports = { start };

test("password modes preserve login, logout, view and edit policies", async (t) => {
  for (const lockView of ["true", "false"]) {
    await t.test(`view lock ${lockView}`, async (t) => {
      const app = await start(t, {
        DASHBOARD_PASSWORD: "test-password",
        DASHBOARD_LOCK_VIEW: lockView,
      });
      const json = { "content-type": "application/json" };
      const status = await (await app.request("/api/auth")).json();
      assert.deepEqual(status, {
        passwordSet: true,
        lockView: lockView === "true",
        authenticated: false,
      });
      const manifest = await (await app.request("/manifest.webmanifest")).json();
      assert.equal(manifest.name, lockView === "true" ? "Dashboard" : "Home Lab");
      const routes = require("../routes/index");
      for (const [key, route] of Object.entries(routes)) {
        if (route.access === "public") continue;
        const [method, url] = key.split(" ");
        if (lockView === "false" && route.access === "view") continue;
        const response = await app.request(url, {
          method,
          headers: json,
          ...(method !== "GET" && { body: "{}" }),
        });
        assert.equal(response.status, 401, key);
        assert.deepEqual(await response.json(), {
          error: lockView === "true" ? "Locked" : "Login required",
        });
      }
      assert.equal((await app.request("/api/config")).status, lockView === "true" ? 401 : 200);
      const wrong = await app.request("/api/login", {
        method: "POST", headers: json, body: '{"password":"wrong"}',
      });
      assert.equal(wrong.status, 401);
      const login = await app.request("/api/login", {
        method: "POST", headers: json, body: '{"password":"test-password"}',
      });
      assert.equal(login.status, 200);
      const cookie = login.headers.get("set-cookie");
      assert.match(cookie, /HttpOnly; SameSite=Strict/);
      assert.equal((await login.json()).authenticated, true);
      const headers = { ...json, cookie: cookie.split(";")[0] };
      assert.equal((await app.request("/api/config", { headers })).status, 200);
      assert.equal((await app.request("/api/clip", {
        method: "PUT", headers, body: '{"text":"authenticated"}',
      })).status, 200);
      const logout = await app.request("/api/logout", {
        method: "POST", headers, body: "{}",
      });
      assert.equal((await logout.json()).authenticated, false);
      assert.match(logout.headers.get("set-cookie"), /Max-Age=0/);
    });
  }
});

test("unlocked APIs retain response shapes, persistence and HTTP errors", async (t) => {
  const app = await start(t, { PATH: "", SHARE_TOKEN: "test-share-token-123456" });
  const json = { "content-type": "application/json" };
  const request = (url, method, body) => app.request(url, {
    method, headers: json, body: JSON.stringify(body),
  });
  const config = { settings: { title: "Refactor Test" }, servers: [] };
  assert.equal((await request("/api/config", "PUT", config)).status, 200);
  const saved = await (await app.request("/api/config")).json();
  assert.equal(saved.config.settings.title, "Refactor Test");
  assert.equal(typeof saved.version, "string");
  assert.equal(typeof saved.tunables, "object");
  assert.equal((await (await app.request("/manifest.webmanifest")).json()).name, "Refactor Test");
  for (const url of ["/api/docker", "/api/docker/stats?fresh=1", "/api/stats", "/api/health?fresh=1", "/api/storage", "/api/info", "/api/info/settings", "/api/tunables", "/api/icons", "/api/availability", "/api/remotes", "/api/remotes/settings"]) {
    const response = await app.request(url);
    assert.equal(response.status, 200, url);
    assert.ok(await response.json());
  }
  const added = await (await request("/api/clip", "PUT", { text: "persist me" })).json();
  assert.equal(added.text, "persist me");
  assert.equal((await (await request("/api/clip/entry", "DELETE", { id: added.entries[0].id })).json()).entries.length, 0);
  for (const [url, method, body] of [
    ["/api/clip/settings", "PUT", { max: 5 }],
    ["/api/clip", "DELETE", {}],
    ["/api/icons", "DELETE", {}],
    ["/api/availability/settings", "PUT", { interval: 1 }],
    ["/api/availability", "DELETE", {}],
    ["/api/info/settings", "PUT", { mode: "off" }],
    ["/api/tunables", "PUT", { values: {} }],
    ["/api/remotes/settings", "PUT", { remotes: [] }],
    ["/api/remotes/interval", "PUT", { interval: 15 }],
  ]) {
    assert.equal((await request(url, method, body)).status, 200, url);
  }
  assert.equal((await app.request("/api/peer")).status, 401);
  const peer = await app.request("/api/peer?fresh=1", {
    headers: { authorization: "Bearer test-share-token-123456" },
  });
  assert.equal(peer.status, 200);
  assert.deepEqual(Object.keys(await peer.json()).sort(), ["availability", "docker", "health", "refreshError", "servers", "stats", "title", "usage", "version"]);
  assert.equal((await app.request("/api/peer/info", {
    headers: { authorization: "Bearer test-share-token-123456" },
  })).status, 200);
  assert.equal((await app.request("/api/remotes/info?id=missing")).status, 404);
  assert.equal((await app.request("/api/icon?icon=bad%20name")).status, 400);
  assert.equal((await app.request("/api/icon?icon=unused")).status, 403);
  assert.equal((await app.request("/api/missing")).status, 404);
  assert.equal((await app.request("/api/missing", { method: "POST" })).status, 415);
  assert.equal((await app.request("/api/config", {
    method: "PUT", headers: json, body: "{",
  })).status, 400);
  assert.equal(JSON.parse(fs.readFileSync(path.join(app.dir, "config.json"))).settings.title, "Refactor Test");
});

test("cached icon responses retain binary contents, ETags and SVG sandboxing", async (t) => {
  const crypto = require("node:crypto");
  const app = await start(t);
  const icon = "http://unused.test/icon.svg";
  const json = { "content-type": "application/json" };
  for (const url of ["/api/login", "/api/logout"]) {
    const response = await app.request(url, {
      method: "POST", headers: json, body: "{}",
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).passwordSet, false);
  }
  const sharing = await app.request("/api/share", {
    method: "PUT", headers: json, body: '{"enabled":true}',
  });
  assert.equal(sharing.status, 200);
  assert.ok((await sharing.json()).shareToken.length >= 16);
  const data = '<svg xmlns="http://www.w3.org/2000/svg"></svg>';
  fs.writeFileSync(path.join(app.dir, "config.json"), JSON.stringify({
    settings: {}, servers: [{ icon, services: [] }],
  }));
  fs.mkdirSync(path.join(app.dir, "icons"));
  const filename = crypto.createHash("sha256").update(icon).digest("hex").slice(0, 32);
  fs.writeFileSync(path.join(app.dir, "icons", filename), data);
  const url = `/api/icon?icon=${encodeURIComponent(icon)}`;
  const response = await app.request(url);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "image/svg+xml");
  assert.match(response.headers.get("content-security-policy"), /sandbox/);
  assert.equal(await response.text(), data);
  const cached = await app.request(url, {
    headers: { "if-none-match": response.headers.get("etag") },
  });
  assert.equal(cached.status, 304);
  assert.equal(await cached.text(), "");
});

test("both shutdown signals exit cleanly and flush the last heartbeat", async (t) => {
  for (const signal of ["SIGTERM", "SIGINT"]) {
    await t.test(signal, async (t) => {
      const app = await start(t);
      const before = Date.now();
      app.child.kill(signal);
      assert.deepEqual(await app.exited, [0, null]);
      const data = JSON.parse(fs.readFileSync(path.join(app.dir, "availability.json")));
      assert.ok(data.lastHeartbeat >= before);
    });
  }
});

test("shutdown allows an in-flight JSON request to finish before flushing", async (t) => {
  const http = require("node:http");
  const app = await start(t);
  const response = new Promise((resolve, reject) => {
    const req = http.request({
      hostname: "127.0.0.1",
      port: app.port,
      path: "/api/clip",
      method: "PUT",
      headers: { "content-type": "application/json" },
    }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.setTimeout(5000, () => req.destroy(new Error("Request timed out")));
    req.write('{"text":');
    setTimeout(() => {
      app.child.kill("SIGTERM");
      req.end('"completed during shutdown"}');
    }, 50);
  });
  const result = await response;
  assert.equal(result.status, 200);
  assert.equal(result.body.text, "completed during shutdown");
  assert.deepEqual(await app.exited, [0, null]);
});


test("persistence API failures are scoped, redact details, and preserve stores and memory", async (t) => {
  const app = await start(t);
  const headers = { "content-type": "application/json" };
  for (const [file, url, method, body, scope] of [
    ["config.json", "/api/config", "PUT", { servers: [] }, "Dashboard configuration"],
    ["clipboard.json", "/api/clip", "DELETE", {}, "Shared clipboard"],
    ["remotes.json", "/api/share", "PUT", { enabled: true }, "Remote dashboard settings"],
    ["serverinfo.json", "/api/info/settings", "PUT", { mode: "manual", manualIp: "127.0.0.1" }, "Server info settings"],
  ]) {
    const target = path.join(app.dir, file);
    fs.writeFileSync(target, "{private-corrupt-content");
    const response = await app.request(url, { method, headers, body: JSON.stringify(body) });
    assert.equal(response.status, 500, url);
    assert.deepEqual(await response.json(), {
      error: `${scope} could not be loaded or saved. Check the backend logs.`,
    });
    assert.equal(fs.readFileSync(target, "utf8"), "{private-corrupt-content");
  }
  const before = await (await app.request("/api/availability")).json();
  const target = path.join(app.dir, "availability.json");
  fs.unlinkSync(target);
  fs.mkdirSync(target); // Rename cannot replace a directory, even when running as root.
  const response = await app.request("/api/availability/settings", {
    method: "PUT", headers, body: JSON.stringify({ enabled: !before.enabled }),
  });
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), {
    error: "Availability history could not be loaded or saved. Check the backend logs.",
  });
  assert.equal((await (await app.request("/api/availability")).json()).enabled, before.enabled);
  assert.equal((await app.request("/api/availability", { method: "DELETE", headers })).status, 500);
  const items = await (await app.request("/api/tunables")).json();
  const item = items.find((entry) => !entry.fixed);
  assert.ok(item);
  fs.mkdirSync(path.join(app.dir, "tunables.json"));
  const failedTunable = await app.request("/api/tunables", {
    method: "PUT", headers, body: JSON.stringify({ values: { [item.key]: item.min } }),
  });
  assert.equal(failedTunable.status, 500);
  assert.deepEqual(await failedTunable.json(), {
    error: "Timing settings could not be loaded or saved. Check the backend logs.",
  });
  const after = await (await app.request("/api/tunables")).json();
  assert.equal(after.find((entry) => entry.key === item.key).value, item.value);
});

test("configuration API exposes revisions and rejects concurrent stale documents", async (t) => {
  const app = await start(t);
  const initial = await (await app.request("/api/config")).json();
  assert.match(initial.revision, /^[a-f0-9]{64}$/);
  const put = (config, revision) => app.request("/api/config", {
    method: "PUT", headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...config, ...(revision === undefined ? {} : { _revision: revision }) }),
  });
  const document = (title) => ({ ...initial.config, settings: { ...initial.config.settings, title } });
  const responses = await Promise.all([
    put(document("client A"), initial.revision),
    put(document("client B"), initial.revision),
  ]);
  assert.deepEqual(responses.map((r) => r.status).sort(), [200, 409]);
  const winner = await responses.find((r) => r.status === 200).json();
  const conflict = await responses.find((r) => r.status === 409).json();
  assert.match(conflict.error, /changed elsewhere/);
  const latest = await (await app.request("/api/config")).json();
  assert.deepEqual(latest.config, winner.config);
  assert.equal(latest.revision, winner.revision);
  assert.notEqual(latest.revision, initial.revision);
  assert.equal(Object.hasOwn(latest.config, "_revision"), false);
  assert.equal((await put(document("invalid token"), null)).status, 409);
  const retry = await put(document("reviewed retry"), latest.revision);
  assert.equal(retry.status, 200);
  const legacy = await put(document("legacy client"));
  assert.equal(legacy.status, 200);
  assert.match((await legacy.json()).revision, /^[a-f0-9]{64}$/);
});
