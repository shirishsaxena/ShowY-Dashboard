"use strict";

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

async function run(t, args, overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "showy-lifecycle-"));
  const child = spawn(process.execPath, args, {
    cwd: path.resolve(__dirname, ".."),
    env: {
      ...process.env,
      DATA_DIR: dir,
      DASHBOARD_PASSWORD: "",
      REMOTE_DASHBOARDS: "",
      SHARE_TOKEN: "",
      ...overrides,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (data) => { output += data; });
  child.stderr.on("data", (data) => { output += data; });
  const exited = once(child, "exit");
  const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
  t.after(() => {
    clearTimeout(timer);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const [code, signal] = await exited;
  clearTimeout(timer);
  assert.equal(signal, null, output);
  return { code, output, dir };
}

test("importing bootstrap does not listen, initialize persistence or install signal handlers", async (t) => {
  const result = await run(t, ["-e", `
    const assert = require("node:assert/strict");
    const fs = require("node:fs");
    const before = process.listenerCount("SIGTERM");
    const app = require("./server");
    assert.equal(typeof app.createServer, "function");
    assert.equal(typeof app.start, "function");
    assert.equal(process.listenerCount("SIGTERM"), before);
    assert.deepEqual(fs.readdirSync(process.env.DATA_DIR), []);
    const server = app.createServer();
    assert.equal(server.listening, false);
  `]);
  assert.equal(result.code, 0, result.output);
  assert.equal(result.output, "");
});

test("authentication initialization failure exits nonzero without accepting traffic", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "showy-unwritable-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "not-a-directory");
  fs.writeFileSync(file, "occupied");
  const result = await run(t, ["server.js"], {
    DATA_DIR: file,
    DASHBOARD_PASSWORD: "test-password",
  });
  assert.equal(result.code, 1);
  assert.match(result.output, /ERROR \[Lifecycle\] Fatal startup error/);
  assert.doesNotMatch(result.output, /listening on port/);
});

test("listen failure is reported as a fatal startup error", async (t) => {
  const listener = net.createServer();
  await new Promise((resolve) => listener.listen(0, resolve));
  t.after(() => new Promise((resolve) => listener.close(resolve)));
  const result = await run(t, ["server.js"], {
    PORT: String(listener.address().port),
  });
  assert.equal(result.code, 1);
  assert.match(result.output, /ERROR \[Lifecycle\] Fatal startup error/);
  assert.match(result.output, /EADDRINUSE/);
  assert.doesNotMatch(result.output, /listening on port/);
});
