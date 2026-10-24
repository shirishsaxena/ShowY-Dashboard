"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const { EventEmitter } = require("node:events");

const ID = "a".repeat(64);
const metadata = (tty = false) => ({
  body: JSON.stringify({ Config: { Tty: tty, Env: ["SECRET=hidden"] } }),
});

function load(file, mocks = {}, globals = {}) {
  const filename = path.join(__dirname, "..", file);
  const local = createRequire(filename);
  const module = { exports: {} };
  vm.runInNewContext(
    fs.readFileSync(filename, "utf8"),
    {
      module,
      exports: module.exports,
      Buffer,
      setTimeout,
      clearTimeout,
      AbortController,
      require: (id) => (Object.hasOwn(mocks, id) ? mocks[id] : local(id)),
      ...globals,
    },
    { filename },
  );
  return module.exports;
}

function fixture(replies = [], globals = {}) {
  const requests = [];
  const docker = load(
    "lib/docker-logs.js",
    {
      "./env": { DOCKER_SOCKET: "/test/docker.sock" },
      http: {
        request(options, callback) {
          const req = new EventEmitter();
          req.options = options;
          req.destroy = () => {
            req.destroyed = true;
          };
          req.end = () => {
            const reply = replies.shift();
            if (!reply) return;
            queueMicrotask(() => {
              if (req.destroyed) return;
              if (reply.error) return req.emit("error", reply.error);
              const res = new EventEmitter();
              res.statusCode = reply.status || 200;
              callback(res);
              for (const chunk of reply.chunks || [
                Buffer.from(reply.body || ""),
              ]) {
                if (req.destroyed) return;
                res.emit("data", chunk);
              }
              if (reply.aborted) res.emit("aborted");
              else if (!req.destroyed) res.emit("end");
            });
          };
          requests.push(req);
          return req;
        },
      },
    },
    globals,
  );
  return { ...docker, requests };
}

function frame(text, stream = 1) {
  const body = Buffer.isBuffer(text) ? text : Buffer.from(text);
  const header = Buffer.alloc(8);
  header[0] = stream;
  header.writeUInt32BE(body.length, 4);
  return Buffer.concat([header, body]);
}

test("snapshot reads only GET endpoints, decodes fragmented stdout/stderr and strips terminal escapes", async () => {
  const body = Buffer.concat([
    frame("2026 hello 🌍\n"),
    frame("\x1b[31merror\x1b[0m\n", 2),
  ]);
  const h = fixture([
    metadata(),
    { chunks: [body.subarray(0, 3), body.subarray(3, 24), body.subarray(24)] },
  ]);
  const result = await h.getContainerLogs(ID);
  assert.equal(result.text, "2026 hello 🌍\nerror");
  assert.equal(result.tail, 250);
  assert.equal(result.truncated, false);
  assert.ok(result.fetchedAt > 0);
  assert.equal(result.id, ID);
  assert.ok(!JSON.stringify(result).includes("SECRET"));
  assert.equal(h.requests.length, 2);
  assert.equal(h.requests[0].options.path, `/containers/${ID}/json`);
  assert.equal(
    h.requests[1].options.path,
    `/containers/${ID}/logs?stdout=1&stderr=1&timestamps=1&follow=0&tail=250`,
  );
  assert.ok(
    h.requests.every((req) => req.options.method === "GET" && req.destroyed),
  );
});

test("TTY, empty logs and combined line counts are supported", async () => {
  const text =
    Array.from({ length: 130 }, (_, i) => `line ${i}`).join("\n") + "\n";
  const h = fixture([metadata(true), { body: text }, metadata(), { body: "" }]);
  const result = await h.getContainerLogs(ID, { tail: 100 });
  assert.equal(result.text.split("\n").length, 100);
  assert.ok(result.text.startsWith("line 30\n"));
  assert.equal((await h.getContainerLogs(ID, { tail: 500 })).text, "");
});

test("invalid targets and line limits cannot make Docker requests", async () => {
  const h = fixture();
  for (const id of [
    null,
    "",
    "app",
    "--all",
    "a".repeat(12),
    "../info",
    `${ID}?tail=all`,
  ])
    await assert.rejects(h.getContainerLogs(id), { status: 400 });
  for (const tail of [0, 101, 1000, Infinity, NaN, "100", -1])
    await assert.rejects(h.getContainerLogs(ID, { tail }), { status: 400 });
  assert.equal(h.requests.length, 0);
});

test("oversized TTY and framed snapshots are capped and marked, including a partial frame", async () => {
  for (const tty of [true, false]) {
    const huge = Buffer.alloc(1024 * 1024 + 100, 120);
    const body = tty ? huge : frame(huge);
    const h = fixture([
      metadata(tty),
      { chunks: [body.subarray(0, 512000), body.subarray(512000)] },
    ]);
    const result = await h.getContainerLogs(ID);
    assert.equal(result.truncated, true);
    assert.ok(Buffer.byteLength(result.text) <= 1024 * 1024);
    assert.ok(result.text.length > 1000000);
    assert.equal(h.requests[1].destroyed, true);
  }
});

test("malformed frames, oversized metadata and interrupted responses fail safely", async () => {
  for (const replies of [
    [metadata(), { body: "bad" }],
    [metadata(), { body: "not a Docker frame" }],
    [{ body: "{" }],
    [{ body: "{}" }],
    [{ body: "x".repeat(1024 * 1024 + 1) }],
  ]) {
    const h = fixture(replies);
    await assert.rejects(h.getContainerLogs(ID), { status: 502 });
  }
  await assert.rejects(
    fixture([metadata(), { aborted: true }]).getContainerLogs(ID),
    { status: 503 },
  );
});

test("Docker errors are actionable and do not expose daemon response bodies", async () => {
  for (const [status, expected, message] of [
    [404, 404, /no longer exists/],
    [403, 403, /denied/],
    [500, 502, /logging driver/],
  ]) {
    await assert.rejects(
      fixture([
        metadata(),
        { status, body: "secret daemon details" },
      ]).getContainerLogs(ID),
      (err) =>
        err.status === expected &&
        message.test(err.message) &&
        !err.message.includes("secret"),
    );
  }
  await assert.rejects(
    fixture([{ error: new Error("private socket path") }]).getContainerLogs(ID),
    (err) =>
      err.status === 503 &&
      /socket/.test(err.message) &&
      !err.message.includes("private"),
  );
});

test("cancellation and absolute deadlines destroy requests and release concurrency slots", async () => {
  const timers = [];
  const h = fixture([], {
    setTimeout: (callback, ms) => {
      const timer = { callback, ms, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimeout: (timer) => {
      if (timer) timer.cleared = true;
    },
  });
  const controllers = Array.from({ length: 4 }, () => new AbortController());
  const pending = controllers.map((controller) =>
    h.getContainerLogs(ID, { signal: controller.signal }),
  );
  const checked = pending.map((promise) =>
    assert.rejects(promise, (err) => [499, 504].includes(err.status)),
  );
  await assert.rejects(h.getContainerLogs(ID), { status: 429 });
  controllers[0].abort();
  assert.equal(timers[1].ms, 8000);
  timers[1].callback();
  controllers[2].abort();
  controllers[3].abort();
  await Promise.all(checked);
  assert.ok(h.requests.every((req) => req.destroyed));
  assert.ok(timers.every((timer) => timer.cleared));
  const stopped = new AbortController();
  stopped.abort();
  await assert.rejects(h.getContainerLogs(ID, { signal: stopped.signal }), {
    status: 499,
  });
  assert.equal(h.requests.length, 4);
  const retry = h.getContainerLogs(ID);
  const rejected = assert.rejects(retry, { status: 504 });
  timers.at(-1).callback();
  await rejected;
});

test("log route requires edit access, sends no-store, forwards limits and cancels disconnected readers", async () => {
  const calls = [];
  let edit = false;
  let view = true;
  let wait = null;
  const routes = load("routes/system.js", {
    "../lib/docker": {},
    "../lib/health": {},
    "../lib/storage": {},
    "../lib/system": {},
    "../lib/serverinfo": {},
    "../lib/docker-logs": {
      getContainerLogs: async (id, options) => {
        calls.push({ id, ...options });
        if (wait) await wait;
        return { text: "hello" };
      },
    },
  });
  const router = load("http/router.js", {
    "../routes/index": routes,
    "../lib/auth": { canView: () => view, isAuthenticated: () => edit },
    "../lib/logger": { debug() {} },
  });
  const response = () =>
    Object.assign(new EventEmitter(), {
      writeHead(status, headers) {
        this.status = status;
        this.headers = headers;
        this.headersSent = true;
      },
      end(body) {
        this.body = JSON.parse(body);
      },
    });
  const request = (res) =>
    router.handleApi({
      req: { method: "GET", headers: {} },
      res,
      pathname: "/api/docker/logs",
      query: new URLSearchParams({ id: ID, tail: "500" }),
    });
  const denied = response();
  await request(denied);
  assert.equal(denied.status, 401);
  assert.equal(calls.length, 0);
  view = false;
  edit = true;
  const locked = response();
  await request(locked);
  assert.equal(locked.status, 401);
  view = true;
  const ok = response();
  await request(ok);
  assert.equal(ok.status, 200);
  assert.equal(ok.headers["Cache-Control"], "no-store");
  assert.equal(calls[0].id, ID);
  assert.equal(calls[0].tail, 500);
  assert.equal(ok.listenerCount("close"), 0);
  let finish;
  wait = new Promise((resolve) => {
    finish = resolve;
  });
  const closed = response();
  const pending = request(closed);
  closed.emit("close");
  assert.equal(calls[1].signal.aborted, true);
  finish();
  await pending;
  assert.equal(closed.listenerCount("close"), 0);
});
