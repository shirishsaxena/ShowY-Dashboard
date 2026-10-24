"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const { EventEmitter } = require("node:events");
const { Readable } = require("node:stream");
const { HttpError } = require("../lib/http");
const ID = "a".repeat(64);
const KEY = "request-123456789";
const flush = () => new Promise(setImmediate);

function load(file, mocks = {}, globals = {}) {
  const filename = path.join(__dirname, "..", file);
  const local = createRequire(filename);
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, "utf8"), {
    module, Buffer, URL, structuredClone, setTimeout, clearTimeout,
    require: (name) => Object.hasOwn(mocks, name) ? mocks[name] : local(name), ...globals,
  }, { filename });
  return module.exports;
}

function fixture({ env = {}, info = {}, postError, postStatus = 204, persistError = false,
  holdPost = false, holdInspect = false, unchanged = false, verifyError = false, initialState = "running", retired = [] } = {}) {
  const entries = [];
  const requests = [];
  const timers = [];
  let now = 1000;
  let mutated = false;
  const send = (request, callback) => {
    const { method } = request.options;
    if (method === "POST" && postError) return request.emit("error", postError);
    const res = new EventEmitter();
    res.statusCode = method === "POST" ? postStatus : mutated && verifyError ? 500 : 200;
    callback(res);
    if (request.destroyed) return;
    if (method === "POST") mutated = true;
    else {
      const action = requests.find((item) => item.options.method === "POST")?.options.path.split("/").pop().split("?")[0];
      res.emit("data", Buffer.from(JSON.stringify({ Id: ID, Name: "/web", Config: { Hostname: "web" },
        State: { Status: mutated ? action === "stop" ? "exited" : "running" : initialState,
          StartedAt: mutated && !unchanged ? "after" : "before" }, ...info })));
    }
    res.emit("end");
  };
  const control = load("lib/docker-control.js", {
    "./env": { DOCKER_SOCKET: "/fake", DOCKER_CONTROL: true, PASSWORD: "password", DOCKER_PROTECTED_CONTAINERS: [], ...env },
    os: { hostname: () => "dashboard" },
    "./logger": { info() {}, warn() {}, error() {} },
    "timers/promises": { setTimeout: async (ms) => { now += ms; } },
    "./activity": {
      snapshot: async () => ({ entries: structuredClone(entries), retired }),
      add: async (entry) => {
        if (persistError) throw new Error("disk failed");
        entries.push({ ...entry });
        return entry;
      },
      complete: async (id, status, message) => Object.assign(entries.find((entry) => entry.id === id), { status, message }),
    },
    http: { request(options, callback) {
      const req = new EventEmitter();
      req.options = options;
      req.destroy = () => { req.destroyed = true; };
      req.reply = () => send(req, callback);
      req.end = () => {
        if ((options.method === "POST" && holdPost) || (options.method === "GET" && holdInspect)) return;
        queueMicrotask(req.reply);
      };
      requests.push(req);
      return req;
    } },
  }, {
    Date: class extends Date { static now() { return now; } },
    setTimeout: (callback, ms) => { const timer = { callback, ms, unref() {} }; timers.push(timer); return timer; },
    clearTimeout: (timer) => { if (timer) timer.cleared = true; },
  });
  return { ...control, entries, requests, timers };
}

test("Docker control is opt-in, requires a password and validates actions before socket access", async () => {
  for (const env of [{ DOCKER_CONTROL: false }, { PASSWORD: "" }]) {
    const h = fixture({ env });
    assert.equal(h.controlState().enabled, false);
    await assert.rejects(h.submit({ id: ID, action: "restart", requestId: KEY }), { status: 403 });
    assert.equal(h.requests.length, 0);
  }
  const h = fixture();
  for (const body of [null, [], {}, { id: "web", action: "restart", requestId: KEY },
    { id: ID, action: "exec", requestId: KEY }, { id: ID, action: "stop", requestId: "bad/path" }])
    await assert.rejects(h.submit(body), { status: 400 });
  assert.equal(h.requests.length, 0);
});

test("protected containers and incompatible states never receive a mutation", async () => {
  for (const info of [
    { Name: "/showy-dashboard" }, { Name: "/showy-dashy" },
    { Config: { Hostname: "dashboard" } }, { Config: { Labels: { "showy.protected": "true" } } },
  ]) {
    const h = fixture({ info });
    await assert.rejects(h.submit({ id: ID, action: "restart", requestId: KEY }), { status: 403 });
    assert.equal(h.requests.length, 1);
    assert.equal(h.controlState().busy.length, 0);
  }
  const named = fixture({ env: { DOCKER_PROTECTED_CONTAINERS: ["web"] } });
  await assert.rejects(named.submit({ id: ID, action: "stop", requestId: KEY }), { status: 403 });
  for (const state of ["paused", "restarting", "removing", "exited"]) {
    const h = fixture({ info: { State: { Status: state } } });
    await assert.rejects(h.submit({ id: ID, action: "restart", requestId: KEY }), { status: 409 });
    assert.ok(h.requests.every((req) => req.options.method === "GET"));
  }
});

test("restart locks the container, persists intent first, verifies state and does not replay request IDs", async () => {
  const h = fixture({ holdPost: true });
  const entry = await h.submit({ id: ID, action: "restart", requestId: KEY });
  assert.equal(entry.status, "pending");
  assert.equal(h.controlState().busy.length, 1);
  assert.equal(h.requests[1].options.path, `/containers/${ID}/restart?t=10`);
  assert.equal(h.timers[1].ms, 25000);
  assert.equal(h.entries.length, 1);
  await assert.rejects(h.submit({ id: ID, action: "stop", requestId: "another-request" }), { status: 409 });
  await h.submit({ id: ID, action: "restart", requestId: KEY });
  assert.equal(h.requests.length, 2);
  h.requests[1].reply();
  await flush();
  assert.equal(h.entries[0].status, "success");
  assert.equal(h.controlState().busy.length, 0);
  await h.submit({ id: ID, action: "restart", requestId: KEY });
  assert.equal(h.requests.filter((req) => req.options.method === "POST").length, 1);
  await assert.rejects(h.submit({ id: ID, action: "stop", requestId: KEY }), { status: 409 });
  assert.ok(h.timers.every((timer) => timer.cleared));
});

test("history persistence failure prevents Docker writes", async () => {
  const h = fixture({ persistError: true });
  await assert.rejects(h.submit({ id: ID, action: "stop", requestId: KEY }), /disk failed/);
  assert.equal(h.requests.length, 1);
  assert.equal(h.controlState().busy.length, 0);
});

test("a cleared operation receipt still prevents duplicate Docker execution", async () => {
  const h = fixture({ retired: [{ id: KEY, containerId: ID, action: "restart", status: "success" }] });
  assert.equal((await h.submit({ id: ID, action: "restart", requestId: KEY })).status, "success");
  await assert.rejects(h.submit({ id: ID, action: "stop", requestId: KEY }), { status: 409 });
  assert.equal(h.requests.length, 0);
});

test("stop confirms stopped state and uses a bounded graceful timeout", async () => {
  const h = fixture();
  await h.submit({ id: ID, action: "stop", requestId: KEY });
  await flush();
  assert.equal(h.entries[0].status, "success");
  assert.equal(h.requests[1].options.path, `/containers/${ID}/stop?t=10`);
});

test("start uses the existing container and verifies it is running", async () => {
  const h = fixture({ initialState: "exited" });
  await h.submit({ id: ID, action: "start", requestId: KEY });
  await flush();
  assert.equal(h.entries[0].status, "success");
  assert.equal(h.requests[1].options.path, `/containers/${ID}/start`);
  assert.equal(h.requests.filter((req) => req.options.method === "POST").length, 1);
});

test("admission limits concurrent actions before inspection and releases failed reservations", async () => {
  const h = fixture({ holdInspect: true });
  const pending = ["a", "b", "c", "d"].map((letter) => h.submit({
    id: letter.repeat(64), action: "restart", requestId: `${KEY}-${letter}`,
  }));
  const checked = pending.map((promise) => assert.rejects(promise, { status: 504 }));
  await flush();
  assert.equal(h.controlState().busy.length, 4);
  await assert.rejects(h.submit({ id: "e".repeat(64), action: "restart", requestId: `${KEY}-e` }), { status: 429 });
  for (const timer of h.timers) timer.callback();
  await Promise.all(checked);
  assert.equal(h.controlState().busy.length, 0);
  assert.ok(h.requests.every((req) => req.options.method === "GET"));
});

test("socket timeouts and post-acceptance verification errors are uncertain, never auto-retried", async () => {
  for (const options of [{ postError: new Error("connection reset") }, { verifyError: true }, { unchanged: true }]) {
    const h = fixture(options);
    await h.submit({ id: ID, action: "restart", requestId: KEY });
    await flush();
    assert.equal(h.entries[0].status, "uncertain");
    assert.equal(h.controlState().busy.length, 0);
    assert.equal(h.requests.filter((req) => req.options.method === "POST").length, 1);
  }
  const h = fixture({ holdPost: true });
  await h.submit({ id: ID, action: "restart", requestId: KEY });
  h.timers[1].callback();
  await flush();
  assert.equal(h.entries[0].status, "uncertain");
  assert.equal(h.requests[1].destroyed, true);
  const denied = fixture({ postStatus: 403 });
  await denied.submit({ id: ID, action: "stop", requestId: KEY });
  await flush();
  assert.equal(denied.entries[0].status, "failed");
});

test("same-origin enforcement rejects cross-site, missing-origin, and bad-proxy requests", async () => {
  const submitted = [];
  const routes = load("routes/activity.js", {
    "../lib/env": { TRUST_PROXY: false },
    "../lib/activity": { snapshot: async () => ({ entries: [] }) },
    "../lib/docker-control": { controlState: () => ({}), submit: async (body) => {
      submitted.push(body); return { status: "pending" };
    } },
  });
  const call = async (headers, encrypted = false) => {
    const req = Readable.from([Buffer.from(JSON.stringify({ id: ID, action: "stop", requestId: KEY }))]);
    req.headers = { host: "dash.test", ...headers };
    req.socket = { encrypted };
    const res = { writeHead(status) { this.status = status; }, end() {} };
    await routes["POST /api/docker/action"].handler(req, res);
    return res.status;
  };
  for (const headers of [{}, { origin: "null" }, { origin: "http://evil.test" },
    { origin: "http://dash.test", "sec-fetch-site": "cross-site" },
    { origin: "https://dash.test", "x-forwarded-proto": "https" }])
    await assert.rejects(call(headers), { status: 403 });
  assert.equal(submitted.length, 0);
  assert.equal(await call({ origin: "http://dash.test", "sec-fetch-site": "same-origin" }), 202);
  assert.equal(await call({ origin: "https://dash.test" }, true), 202);
});

test("history is bounded, redacts request details, preserves pending jobs and recovers interrupted work", async () => {
  let stored;
  let fail = false;
  const mocks = {
    "./env": { ACTIVITY_FILE: "activity.json" },
    fs: { promises: { readFile: async () => {
      if (stored === undefined) throw Object.assign(new Error("missing"), { code: "ENOENT" });
      return stored;
    } } },
    "./config": { writeAtomic: async (_file, data) => { if (fail) throw new Error("disk full"); stored = data; } },
    "./logger": { error() {} },
  };
  const activity = load("lib/activity.js", mocks);
  await activity.add({ id: KEY, title: "Restart container", containerId: ID, action: "restart", status: "pending" });
  for (let i = 0; i < 205; i++) await activity.recordRequest("PUT /api/config", 200);
  let snapshot = await activity.snapshot();
  assert.equal(snapshot.entries.length, 200);
  assert.ok(snapshot.entries.some((entry) => entry.id === KEY));
  await activity.recordRequest("POST /api/login", 200);
  await activity.recordRequest("GET /api/docker/logs", 200);
  assert.equal((await activity.snapshot()).entries.length, 200);
  const recovered = load("lib/activity.js", mocks);
  snapshot = await recovered.snapshot();
  assert.equal(snapshot.entries.find((entry) => entry.id === KEY).status, "uncertain");
  assert.match(stored, /Dashboard restarted/);
  fail = true;
  await assert.rejects(recovered.add({ title: "Must persist", status: "pending" }), /disk full/);
  await recovered.complete(KEY, "success", "Container running");
  assert.equal((await recovered.snapshot()).entries.find((entry) => entry.id === KEY).status, "success");
  assert.equal((await recovered.snapshot()).persistenceError, true);
  fail = false;
  await recovered.recordRequest("PUT /api/share", 500);
  assert.equal((await recovered.snapshot()).persistenceError, false);
  assert.match(stored, /Request failed \(HTTP 500\)/);
});

test("corrupt history is not overwritten", async () => {
  let writes = 0;
  const activity = load("lib/activity.js", {
    "./env": { ACTIVITY_FILE: "activity.json" },
    fs: { promises: { readFile: async () => "{broken" } },
    "./config": { writeAtomic: async () => { writes++; } },
    "./logger": { error() {} },
  });
  await assert.rejects(activity.snapshot());
  await assert.rejects(activity.add({ title: "Restart", status: "pending" }));
  assert.equal(writes, 0);
});

test("clearing history preserves pending actions and minimal replay receipts across restart, and fails atomically", async () => {
  let stored = "[]";
  let fail = false;
  const mocks = {
    "./env": { ACTIVITY_FILE: "activity.json" },
    fs: { promises: { readFile: async () => stored } },
    "./config": { writeAtomic: async (_file, data) => { if (fail) throw new Error("disk full"); stored = data; } },
    "./logger": { error() {} },
  };
  const activity = load("lib/activity.js", mocks);
  await activity.add({ id: KEY, title: "Private container name", message: "Private outcome", containerId: ID, action: "restart", status: "success" });
  await activity.add({ id: "pending-request", title: "Running job", containerId: "b".repeat(64), action: "stop", status: "pending" });
  await activity.add({ title: "Configuration update" });
  fail = true;
  await assert.rejects(activity.clear(), /disk full/);
  assert.equal((await activity.snapshot()).entries.length, 3);
  assert.equal((await activity.snapshot()).retired.length, 0);
  fail = false;
  const cleared = await activity.clear();
  assert.equal(cleared.removed, 2);
  assert.equal(cleared.entries.length, 1);
  assert.equal(cleared.entries[0].status, "pending");
  assert.equal(cleared.retired.length, 1);
  assert.equal(cleared.retired[0].id, KEY);
  assert.doesNotMatch(stored, /Private container name|Private outcome|Configuration update/);
  await activity.complete("pending-request", "success", "Stopped");
  assert.equal((await activity.snapshot()).entries[0].message, "Stopped");
  const restarted = load("lib/activity.js", mocks);
  assert.equal((await restarted.snapshot()).retired[0].id, KEY);
  await assert.rejects(restarted.add({ id: KEY, title: "Duplicate", containerId: ID, action: "restart" }), { status: 409 });
  assert.equal((await restarted.clear()).entries.length, 0);
  assert.equal((await restarted.snapshot()).retired.length, 2);
});
