"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const { EventEmitter } = require("node:events");
const { Readable } = require("node:stream");

// Isolate module state and dependencies without changing global built-ins or the require cache.
function loadLib(name, mocks = {}) {
  const filename = path.join(__dirname, "..", "lib", `${name}.js`);
  const requireLocal = createRequire(filename);
  const source = fs.readFileSync(filename, "utf8");
  const wrapper = vm.runInThisContext(
    `(function(require, module, exports, __dirname, __filename) {\n${source}\n})`,
    { filename },
  );
  const module = { exports: {} };
  wrapper(
    (id) => (Object.hasOwn(mocks, id) ? mocks[id] : requireLocal(id)),
    module,
    module.exports,
    path.dirname(filename),
    filename,
  );
  return module.exports;
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

async function temporaryDirectory(t) {
  const dir = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "showy-backend-"),
  );
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
  return dir;
}

test("atomic writes use distinct temporary files and leave complete JSON", async (t) => {
  const dir = await temporaryDirectory(t);
  const target = path.join(dir, "config.json");
  const temps = [];
  const config = loadLib("config", {
    "./env": { DATA_DIR: dir },
    fs: {
      promises: {
        ...fs.promises,
        async writeFile(file, data, options) {
          temps.push(file);
          return fs.promises.writeFile(file, data, options);
        },
      },
    },
  });
  await Promise.all([
    config.writeAtomic(target, '{"value":1}'),
    config.writeAtomic(target, '{"value":2}'),
  ]);
  assert.equal(new Set(temps).size, 2);
  assert.equal(JSON.parse(await fs.promises.readFile(target, "utf8")).value, 2);
  assert.deepEqual(await fs.promises.readdir(dir), ["config.json"]);
});

test("atomic write failure cleans its temporary file and preserves the destination", async (t) => {
  const dir = await temporaryDirectory(t);
  const target = path.join(dir, "config.json");
  await fs.promises.writeFile(target, "previous");
  const failure = new Error("rename failed");
  let fail = true;
  const config = loadLib("config", {
    "./env": { DATA_DIR: dir },
    fs: {
      promises: {
        ...fs.promises,
        rename: async (...args) => {
          if (fail) throw failure;
          return fs.promises.rename(...args);
        },
      },
    },
  });
  await assert.rejects(
    config.writeAtomic(target, "next"),
    (err) => err === failure,
  );
  assert.equal(await fs.promises.readFile(target, "utf8"), "previous");
  assert.deepEqual(await fs.promises.readdir(dir), ["config.json"]);
  fail = false;
  await config.writeAtomic(target, "retry");
  assert.equal(await fs.promises.readFile(target, "utf8"), "retry");
});

test("malformed server and service entries produce HTTP 400 errors", () => {
  const { sanitizeConfig } = loadLib("config", { "./env": {} });
  for (const entry of [null, false, 5, "server", []]) {
    assert.throws(() => sanitizeConfig({ servers: [entry] }), { status: 400 });
    assert.throws(
      () => sanitizeConfig({ servers: [{ name: "Host", services: [entry] }] }),
      { status: 400 },
    );
  }
  const valid = sanitizeConfig({
    servers: [
      {
        id: "host",
        name: "Host",
        services: [{ id: "svc", name: "Service", url: "http://localhost" }],
      },
    ],
  });
  assert.equal(valid.servers[0].services[0].id, "svc");
});

test("health invalidation starts a new generation and old completion cannot replace it", async () => {
  const reads = [];
  const health = loadLib("health", {
    "./config": {
      readConfig: () => {
        const job = deferred();
        reads.push(job);
        return job.promise;
      },
    },
    "./tunables": { get: () => 60 },
  });
  const old = health.getHealth();
  health.invalidateHealth();
  const fresh = health.getHealth();
  assert.equal(reads.length, 2);
  reads[0].resolve({ servers: [] });
  const oldResult = await old;
  const joined = health.getHealth();
  assert.equal(
    reads.length,
    2,
    "old completion must not clear the new pending run",
  );
  reads[1].resolve({ servers: [] });
  const freshResult = await fresh;
  assert.equal(await joined, freshResult);
  assert.equal(await health.getHealth(), freshResult);
  assert.notEqual(freshResult, oldResult);
});

test("health checks recover after a failed collection", async () => {
  let calls = 0;
  const health = loadLib("health", {
    "./config": {
      readConfig: async () => {
        if (++calls === 1) throw new Error("read failed");
        return { servers: [] };
      },
    },
    "./tunables": { get: () => 60 },
  });
  await assert.rejects(health.getHealth(), /read failed/);
  assert.deepEqual((await health.getHealth()).results, {});
  assert.equal(calls, 2);
});

test("clipboard keeps committed state after failure and allows the same text to be retried", async () => {
  let writes = 0;
  let persisted;
  const clip = loadLib("clip", {
    "./env": {},
    fs: { promises: { readFile: async () => '{"max":10,"entries":[]}' } },
    "./config": {
      writeAtomic: async (file, data) => {
        if (++writes === 1) throw new Error("disk full");
        persisted = JSON.parse(data);
      },
    },
  });
  await assert.rejects(clip.writeClip({ text: "keep me" }), /disk full/);
  assert.equal((await clip.readClip()).text, "");
  assert.equal((await clip.writeClip({ text: "keep me" })).text, "keep me");
  assert.equal(persisted.entries[0].text, "keep me");
  await clip.writeClip({ text: "keep me" });
  assert.equal(writes, 2, "committed duplicates remain no-ops");
});

test("clipboard cold reads share loading and never expose an uncommitted update", async () => {
  const read = deferred();
  const save = deferred();
  const saving = deferred();
  let reads = 0;
  const clip = loadLib("clip", {
    "./env": {},
    fs: {
      promises: {
        readFile: () => {
          reads++;
          return read.promise;
        },
      },
    },
    "./config": {
      writeAtomic: () => {
        saving.resolve();
        return save.promise;
      },
    },
  });
  const first = clip.readClip();
  const second = clip.readClip();
  read.resolve('{"entries":[]}');
  await Promise.all([first, second]);
  assert.equal(reads, 1);
  const update = clip.writeClip({ text: "new" });
  await saving.promise;
  assert.equal((await clip.readClip()).text, "");
  save.resolve();
  await update;
  assert.equal((await clip.readClip()).text, "new");
});

test("tunables serialize partial updates and recover after persistence failure", async () => {
  const writes = [];
  let fail = false;
  const tunables = loadLib("tunables", {
    "./env": {},
    fs: { readFileSync: () => "{}" },
    "./config": {
      writeAtomic: async (file, data) => {
        if (fail) throw new Error("disk full");
        writes.push(JSON.parse(data));
      },
    },
  });
  const available = tunables.list().filter((item) => !item.fixed);
  assert.ok(
    available.length >= 2,
    "test needs two tunables without environment overrides",
  );
  const [a, b] = available;
  await Promise.all([
    tunables.save({ [a.key]: a.min }),
    tunables.save({ [b.key]: b.min }),
  ]);
  assert.equal(writes.at(-1)[a.key], a.min);
  assert.equal(writes.at(-1)[b.key], b.min);
  fail = true;
  await assert.rejects(tunables.save({ [a.key]: a.max }), /disk full/);
  assert.equal(tunables.get(a.key), a.min);
  fail = false;
  await tunables.save({ [a.key]: a.max });
  assert.equal(tunables.get(a.key), a.max);
  assert.equal(tunables.get(b.key), b.min);
});

function remoteFixture(writeAtomic, extra = {}) {
  return loadLib("remotes", {
    "./env": {
      SHARE_TOKEN: "",
      REMOTE_DASHBOARDS: "",
      REMOTE_REFRESH_INTERVAL: 0,
    },
    fs: { promises: { readFile: async () => "{}" } },
    "./config": { writeAtomic, sanitizeConfig: (data) => data },
    "./system": {},
    "./docker": {},
    "./health": {},
    "./availability": {},
    "./serverinfo": { sanitizeInfo: (data) => data },
    "./tunables": { get: () => 8 },
    ...extra,
  });
}

test("remote partial updates preserve each other and a failed save does not poison the queue", async () => {
  let persisted;
  let fail = false;
  const remotes = remoteFixture(async (file, data) => {
    if (fail) throw new Error("disk full");
    persisted = JSON.parse(data);
  });
  await Promise.all([
    remotes.setSharing(true),
    remotes.setRefreshInterval({ interval: 30 }),
    remotes.saveRemotes({
      remotes: [{ name: "Remote", url: "http://old.test", token: "secret" }],
    }),
  ]);
  assert.ok(persisted.shareToken);
  assert.equal(persisted.refreshInterval, 30);
  assert.equal(persisted.remotes.length, 1);
  fail = true;
  await assert.rejects(
    remotes.setRefreshInterval({ interval: 60 }),
    /disk full/,
  );
  assert.equal((await remotes.remoteSettings()).refreshInterval, 30);
  fail = false;
  await remotes.setRefreshInterval({ interval: 15 });
  assert.equal(persisted.refreshInterval, 15);
  assert.ok(persisted.shareToken);
});

test("remote settings invalidate server info including an older in-flight response", async (t) => {
  const calls = [];
  t.mock.method(globalThis, "fetch", (url) => {
    const response = deferred();
    calls.push({ url, response });
    return response.promise;
  });
  const remotes = remoteFixture(async () => {});
  const saved = await remotes.saveRemotes({
    remotes: [{ name: "Remote", url: "http://old.test", token: "secret" }],
  });
  const id = saved.remotes[0].id;
  const old = remotes.getRemoteInfo(id);
  await new Promise(setImmediate);
  await remotes.saveRemotes({
    remotes: [{ id, name: "Remote", url: "http://new.test", token: "" }],
  });
  const fresh = remotes.getRemoteInfo(id);
  await new Promise(setImmediate);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].url, "http://new.test/api/peer/info");
  calls[1].response.resolve(
    new Response(JSON.stringify({ system: { hostname: "new" } })),
  );
  const result = await fresh;
  calls[0].response.resolve(
    new Response(JSON.stringify({ system: { hostname: "old" } })),
  );
  await old;
  assert.equal(await remotes.getRemoteInfo(id), result);
  assert.equal(result.system.hostname, "new");
  assert.equal(calls.length, 2);
});

test("concurrent failed logins count independently and cannot erase an active lockout", async (t) => {
  let now = 1_000_000;
  t.mock.method(Date, "now", () => now);
  const jobs = [];
  let initialized = false;
  const auth = loadLib("auth", {
    "./env": {
      PASSWORD: "correct",
      SESSION_DAYS: 30,
      LOGIN_MAX_FAILURES: 2,
      LOGIN_LOCKOUT: 60,
    },
    fs: { promises: { readFile: async () => "saved-key" } },
    "./config": {},
    crypto: {
      ...crypto,
      scrypt(password, salt, size, callback) {
        if (!initialized) {
          initialized = true;
          callback(null, Buffer.alloc(size, 1));
        } else {
          jobs.push(() =>
            callback(null, Buffer.alloc(size, password === "correct" ? 1 : 2)),
          );
        }
      },
    },
  });
  await auth.initAuth();
  function attempt(password = "wrong", ip = "client") {
    const req = Readable.from([Buffer.from(JSON.stringify({ password }))]);
    req.headers = {};
    req.socket = { remoteAddress: ip };
    const res = {
      writeHead(status) {
        this.status = status;
      },
      end() {},
    };
    return auth.handleLogin(req, res).then(() => res.status);
  }
  const attempts = [attempt(), attempt(), attempt()];
  await new Promise(setImmediate);
  assert.equal(jobs.length, 3);
  jobs.splice(0).forEach((finish) => finish());
  assert.deepEqual(await Promise.all(attempts), [401, 401, 401]);
  assert.equal(await attempt(), 429);
  const success = attempt("correct", "other-client");
  await new Promise(setImmediate);
  jobs.splice(0).forEach((finish) => finish());
  assert.equal(await success, 200);
  now += 60_001;
  async function finishAttempt(password) {
    const result = attempt(password);
    await new Promise(setImmediate);
    jobs.splice(0).forEach((finish) => finish());
    return result;
  }
  assert.equal(
    await finishAttempt("wrong"),
    401,
    "expired locks allow another attempt",
  );
  assert.equal(await finishAttempt("correct"), 200);
  assert.equal(await finishAttempt("wrong"), 401);
  assert.equal(
    await finishAttempt("wrong"),
    401,
    "successful login resets the failure count",
  );
  assert.equal(await attempt(), 429);
});

test("container lists share only in-flight work and retry after failed collection", async () => {
  const requests = [];
  const docker = loadLib("docker", {
    "./env": {},
    "./tunables": {},
    child_process: {
      execFile: (command, args, options, callback) =>
        callback(new Error("CLI unavailable")),
    },
    http: {
      request(options, callback) {
        const req = new EventEmitter();
        req.end = () => {};
        requests.push({ req, callback });
        return req;
      },
    },
  });
  const first = docker.getContainers();
  assert.equal(docker.getContainers(), first);
  assert.equal(requests.length, 1);
  requests[0].req.emit("error", new Error("socket unavailable"));
  assert.equal((await first).available, false);
  const second = docker.getContainers();
  assert.equal(requests.length, 2);
  const res = new EventEmitter();
  res.statusCode = 200;
  res.setEncoding = () => {};
  requests[1].callback(res);
  res.emit("data", "[]");
  res.emit("end");
  assert.deepEqual(await second, {
    available: true,
    source: "socket",
    containers: [],
  });
});

test("host stats share in-flight collection and refresh on the next request", async () => {
  const collections = [];
  const system = loadLib("system", {
    "./env": {
      HOST_PROC: "/host/proc",
      DISKS_DIR: "/disks",
      HOST_STATS_INTERVAL: 5,
    },
    fs: {
      existsSync: () => false,
      promises: {
        readFile: async () => "",
        readdir: async () => [],
        statfs: async () => ({ blocks: 10, bsize: 100, bavail: 5 }),
      },
    },
    "./availability": {
      getAvailability: () => {
        const job = deferred();
        collections.push(job);
        return job.promise;
      },
    },
  });
  const first = system.getStats();
  assert.equal(system.getStats(), first);
  assert.equal(collections.length, 1);
  collections[0].reject(new Error("unavailable"));
  await assert.rejects(first, /unavailable/);
  const next = system.getStats();
  assert.equal(collections.length, 2);
  collections[1].resolve({ now: 123 });
  assert.equal((await next).availability.now, 123);
  const fresh = system.getStats();
  assert.equal(collections.length, 3);
  collections[2].resolve({ now: 456 });
  assert.equal((await fresh).availability.now, 456);
});
