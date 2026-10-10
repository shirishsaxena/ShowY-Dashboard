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

function iconLibrary(dir, quota, icons) {
  return loadLib("icons", {
    "./env": { ICON_DIR: dir, ICON_CACHE_MAX_BYTES: quota },
    "./config": { readConfig: async () => ({ servers: icons.map((icon) => ({ icon })) }) },
    "./remotes": { remoteServers: () => [] },
  });
}

const iconResponse = () => new Response(Buffer.from("\x89PNGtest", "latin1"));

test("icon quota prunes legacy files, bounds concurrent commits and supports no retention", async (t) => {
  const dir = await temporaryDirectory(t);
  await fs.promises.writeFile(path.join(dir, "a".repeat(32)), Buffer.alloc(30));
  await fs.promises.writeFile(path.join(dir, `${"b".repeat(32)}.tmp`), "stale");
  await fs.promises.writeFile(path.join(dir, "unrelated"), "keep");
  t.mock.method(globalThis, "fetch", async () => iconResponse());
  const icons = iconLibrary(dir, 16, ["one", "two", "three"]);
  assert.deepEqual(await icons.iconCacheInfo(), { count: 0, bytes: 0 });
  await Promise.all(["one", "two", "three"].map((icon) => icons.getIcon(icon)));
  assert.deepEqual(await icons.iconCacheInfo(), { count: 2, bytes: 16 });
  assert.equal(await fs.promises.readFile(path.join(dir, "unrelated"), "utf8"), "keep");
  const disabled = iconLibrary(dir, 0, ["one"]);
  assert.equal((await disabled.getIcon("one")).data.length, 8);
  assert.deepEqual(await disabled.iconCacheInfo(), { count: 0, bytes: 0 });
});

test("icon clear isolates old success/failure and does not detach a new pending job", async (t) => {
  const dir = await temporaryDirectory(t);
  const requests = [];
  t.mock.method(globalThis, "fetch", () => {
    const request = deferred();
    requests.push(request);
    return request.promise;
  });
  const icons = iconLibrary(dir, 32, ["one"]);
  const waitFor = async (count) => {
    while (requests.length < count) await new Promise((resolve) => setImmediate(resolve));
  };
  const old = icons.getIcon("one");
  await waitFor(1);
  await icons.clearIconCache();
  const current = icons.getIcon("one");
  await waitFor(2);
  requests[0].resolve(iconResponse());
  await old;
  assert.deepEqual(await icons.iconCacheInfo(), { count: 0, bytes: 0 });
  const shared = icons.getIcon("one");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(requests.length, 2);
  requests[1].resolve(iconResponse());
  await Promise.all([current, shared]);
  assert.equal((await icons.iconCacheInfo()).count, 1);
  await icons.clearIconCache();
  const staleFailure = assert.rejects(icons.getIcon("one"), /Icon unavailable/);
  await waitFor(3);
  await icons.clearIconCache();
  requests[2].reject(new Error("offline"));
  await staleFailure;
  const retry = icons.getIcon("one");
  await waitFor(4);
  requests[3].resolve(iconResponse());
  await retry;
});

test("icon failure retention expires, caps records and rejects unconfigured targets", async (t) => {
  const dir = await temporaryDirectory(t);
  const names = Array.from({ length: 1025 }, (_, i) => `icon-${i}`);
  const icons = iconLibrary(dir, 32, names);
  let calls = 0;
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  t.mock.method(globalThis, "fetch", async () => { calls++; throw new Error("offline"); });
  await assert.rejects(icons.getIcon("http://private.invalid/"), /not used/);
  assert.equal(calls, 0);
  for (const name of names) await assert.rejects(icons.getIcon(name), /Icon unavailable/);
  await assert.rejects(icons.getIcon(names[1]), /Icon unavailable/);
  assert.equal(calls, 1025); // retained failure suppresses retry
  await assert.rejects(icons.getIcon(names[0]), /Icon unavailable/);
  assert.equal(calls, 1026); // oldest failure evicted at capacity
  now += 10 * 60_000;
  await assert.rejects(icons.getIcon(names[2]), /Icon unavailable/);
  assert.equal(calls, 1027);
});

test("icon clear reports deletion failure and its disk queue recovers", async (t) => {
  const dir = await temporaryDirectory(t);
  const file = path.join(dir, "a".repeat(32));
  await fs.promises.writeFile(file, "cached");
  let broken = true;
  const icons = loadLib("icons", {
    "./env": { ICON_DIR: dir, ICON_CACHE_MAX_BYTES: 32 },
    "./config": { readConfig: async () => ({}) },
    "./remotes": { remoteServers: () => [] },
    fs: { promises: { ...fs.promises, async rm(...args) {
      if (broken) throw Object.assign(new Error("permission denied"), { code: "EACCES" });
      return fs.promises.rm(...args);
    } } },
  });
  await assert.rejects(icons.clearIconCache(), { code: "EACCES" });
  assert.equal(await fs.promises.readFile(file, "utf8"), "cached");
  broken = false;
  assert.deepEqual(await icons.clearIconCache(), { removed: 1 });
  assert.deepEqual(await icons.iconCacheInfo(), { count: 0, bytes: 0 });
});

test("log writer preserves queued rotation, snapshot downloads and clear ordering", async (t) => {
  const dir = await temporaryDirectory(t);
  const logger = loadLib("logger", { "./env": {
    LOG_DIR: dir, LOG_FILE: "backend.log", LOG_MAX_BYTES: 1024, LOG_LEVEL: "INFO",
  } });
  logger.debug("read suppressed");
  logger.info("before rotation", "x".repeat(800));
  logger.info("after rotation", "y".repeat(800));
  const files = await logger.snapshot();
  assert.equal(files.length, 2);
  const clear = logger.clear();
  logger.info("after clear");
  await clear;
  await logger.close();
  const old = [];
  for (const { handle, size } of files) {
    try {
      const data = Buffer.alloc(size);
      await handle.read(data, 0, size, 0);
      old.push(data.toString());
    } finally { await handle.close(); }
  }
  assert.match(old[0], /before rotation/);
  assert.match(old[1], /Rotated active log.*\n.*after rotation/);
  assert.doesNotMatch(old.join(""), /read suppressed|after clear/);
  const active = await fs.promises.readFile(logger.filename, "utf8");
  assert.match(active, /Logs cleared.*\n.*after clear/);
  await assert.rejects(fs.promises.stat(`${logger.filename}.1`), { code: "ENOENT" });
});

test("log file failures propagate for clear and snapshots and allow recovery", async (t) => {
  const dir = await temporaryDirectory(t);
  let broken = true;
  const logger = loadLib("logger", {
    "./env": { LOG_DIR: dir, LOG_FILE: "backend.log", LOG_MAX_BYTES: 1024, LOG_LEVEL: "INFO" },
    fs: { promises: { ...fs.promises, async mkdir(...args) {
      if (broken) throw Object.assign(new Error("isolated failure"), { code: "EACCES" });
      return fs.promises.mkdir(...args);
    } } },
  });
  logger.info("console survives disk failure");
  await assert.rejects(logger.snapshot(), { code: "EACCES" });
  await assert.rejects(logger.clear(), { code: "EACCES" });
  broken = false;
  await logger.clear();
  logger.warn("disk recovered");
  await logger.close();
  assert.match(await fs.promises.readFile(logger.filename, "utf8"), /Logs cleared.*\n.*disk recovered/);
});

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

function validPeerSnapshot() {
  const window = { from: 1, observed: 100, down: 0, count: 0, longest: 0, pct: 100 };
  const availability = { enabled: true, since: 1, now: 101, count: 0, last: null,
    windows: Object.fromEntries(["day", "week", "month", "all"].map((key) => [key, { ...window }])),
    outages: [], records: 0 };
  return {
    version: "1.0", title: "Peer", refreshError: "",
    servers: [{ id: "host", name: "Host", local: true, services: [
      { id: "web", name: "Web", url: "http://web.test", container: "web" },
    ] }],
    stats: { cpu: 10, cores: 4, uptime: 100, cpuModel: "CPU", interval: 5,
      load: [0, 0, 0], mem: { used: 100, total: 1000 }, disks: [],
      net: { rx: 10, tx: 20, rxRate: 1, txRate: 2, ifaces: ["eth0"] }, temps: [], fans: [], availability },
    docker: { available: true, containers: [
      { name: "web", image: "web:latest", state: "running", status: "Up", ports: [80] },
    ] },
    usage: { interval: 10, ok: true, collectedAt: 100,
      stats: { web: { cpu: 150, mem: 100, memLimit: 1000, rx: 10, tx: 20 } } },
    health: { web: { state: "up", code: 200, ms: 5 } }, availability,
  };
}

async function snapshotFixture(t) {
  let response = validPeerSnapshot();
  const logs = [];
  t.mock.method(globalThis, "fetch", async () => {
    if (response instanceof Error) throw response;
    if (response instanceof Response) return response;
    return new Response(JSON.stringify(response));
  });
  const remotes = remoteFixture(async () => {}, {
    "./config": { writeAtomic: async () => {}, sanitizeConfig: require("../lib/config").sanitizeConfig },
    "./serverinfo": { sanitizeInfo: require("../lib/serverinfo").sanitizeInfo },
    "./logger": { warn: (...args) => logs.push(args), info: (...args) => logs.push(args) },
  });
  const saved = await remotes.saveRemotes({
    remotes: [{ name: "Peer", url: "http://peer.test", token: "private-token" }],
  });
  const id = saved.remotes[0].id;
  return { remotes, id, logs, set: (value) => { response = value; },
    read: async () => (await remotes.getRemotes({ fresh: id })).remotes[0] };
}

test("peer snapshots copy known bounded fields and support older optional fields", async (t) => {
  const fixture = await snapshotFixture(t);
  const data = validPeerSnapshot();
  data.title = "x".repeat(1000);
  data.secret = "private";
  data.docker.containers[0].secret = "private";
  data.usage.stats.web.secret = "private";
  fixture.set(data);
  const current = await fixture.read();
  assert.equal(current.refreshError, "");
  assert.ok(current.lastOk > 0);
  assert.equal(current.title.length, 100);
  assert.equal(current.secret, undefined);
  assert.equal(current.docker.containers[0].secret, undefined);
  assert.equal(current.usage.stats.web.secret, undefined);
  assert.equal(current.usage.stats.web.cpu, 150); // multi-core container CPU can exceed 100%
  assert.deepEqual(current.stats.net.ifaces, ["eth0"]);
  const older = validPeerSnapshot();
  for (const key of ["net", "temps", "fans", "availability", "interval", "cpuModel"])
    delete older.stats[key];
  for (const key of ["ok", "collectedAt", "error"]) delete older.usage[key];
  delete older.availability;
  delete older.refreshError;
  fixture.set(older);
  const result = await fixture.read();
  assert.equal(result.refreshError, "");
  assert.deepEqual(result.stats.temps, []);
  assert.equal(result.availability, null);
  assert.ok(result.lastOk >= current.lastOk);
  const nonlocal = validPeerSnapshot();
  nonlocal.servers[0].local = false;
  nonlocal.stats = null;
  nonlocal.docker = { available: false, containers: [] };
  nonlocal.usage = { interval: 0, stats: {} };
  fixture.set(nonlocal);
  assert.equal((await fixture.read()).refreshError, "");
});

test("invalid and incomplete peer sections are render-safe and never advance lastOk", async (t) => {
  const fixture = await snapshotFixture(t);
  const good = await fixture.read();
  const cases = [
    ["servers", (d) => { delete d.servers; }],
    ["servers", (d) => { d.servers[0].services[0].url = "file:///private-secret"; }],
    ["servers", (d) => { d.servers = Array(101).fill(d.servers[0]); }],
    ["stats", (d) => { delete d.stats; }],
    ["stats", (d) => { d.stats.mem = null; }],
    ["stats", (d) => { d.stats.load = "bad"; }],
    ["stats", (d) => { d.stats.net.rxRate = -1; }],
    ["stats", (d) => { d.stats.net.ifaces = [null]; }],
    ["stats", (d) => { d.stats.temps = [null]; }],
    ["stats", (d) => { d.stats.fans = Array(129).fill({ name: "fan", rpm: 1 }); }],
    ["stats", (d) => { d.stats.disks = [{ label: "disk", used: 2, total: 1 }]; }],
    ["docker", (d) => { d.docker.containers = {}; }],
    ["docker", (d) => { d.docker.containers[0].name = {}; }],
    ["docker", (d) => { d.docker.containers[0].image = null; }],
    ["docker", (d) => { d.docker.containers[0].state = "unknown"; }],
    ["docker", (d) => { d.docker.containers[0].ports = [65536]; }],
    ["docker", (d) => { d.docker.available = "true"; }],
    ["usage", (d) => { d.usage.stats.web.mem = "100"; }],
    ["usage", (d) => { d.usage.stats = JSON.parse('{"__proto__": {}}'); }],
    ["usage", (d) => { d.usage.ok = false; }],
    ["usage", (d) => { d.usage.stats = {}; }],
    ["health", (d) => { d.health.web.state = "unknown"; }],
    ["health", (d) => { d.health = {}; }],
    ["availability", (d) => { d.availability.outages = "bad"; }],
    ["availability", (d) => { d.availability.windows.day.pct = 101; }],
    ["availability", (d) => { d.availability.last = { start: 2, end: 1 }; }],
    ["title", (d) => { d.title = {}; }],
    ["refreshError", (d) => { d.refreshError = {}; }],
  ];
  for (const [section, mutate] of cases) {
    const data = validPeerSnapshot();
    mutate(data);
    fixture.set(data);
    const result = await fixture.read();
    assert.equal(result.ok, true, section);
    assert.match(result.refreshError, new RegExp(section));
    assert.equal(result.lastOk, good.lastOk, section);
    assert.ok(Array.isArray(result.servers));
    assert.ok(Array.isArray(result.docker.containers));
    assert.equal(typeof result.usage.stats, "object");
    assert.equal(typeof result.health, "object");
    if (section === "stats") assert.equal(result.stats, null);
  }
  fixture.set({ servers: [] });
  assert.equal((await fixture.read()).lastOk, good.lastOk);
  fixture.set(validPeerSnapshot());
  const recovered = await fixture.read();
  assert.equal(recovered.refreshError, "");
  assert.ok(recovered.lastOk >= good.lastOk);
});

test("accepted peer sections execute frontend stats, status and usage consumers safely", async (t) => {
  const fixture = await snapshotFixture(t);
  let snapshot;
  const node = () => ({ append() {}, setAttribute() {}, lastChild: { setAttribute() {} } });
  const globals = {
    sourceOf: () => snapshot, h: node, svg: node,
    document: { createElementNS: node },
    fmtBytes: String, fmtUptime: String, fmtDuration: String, fmtDateTime: String,
    fmtPercent: String, plural: String, norm: (v) => v.toLowerCase(), portOf: () => 80,
  };
  const consumer = (file, names) => {
    const code = fs.readFileSync(path.join(__dirname, "../public/js", file), "utf8")
      .replace(/^import\s[\s\S]*?;\r?$/gm, "")
      .replace(/\bexport (?=(?:async )?(?:function|const|let)\b)/g, "");
    return vm.runInNewContext(`${code}\n;({ ${names.join(", ")} });`, globals);
  };
  const stats = consumer("view/stats.js", ["systemCard", "networkCard", "sensorsCard", "availabilityCard"]);
  const status = consumer("status.js", ["serviceStatus"]);
  const usage = consumer("view/usage.js", ["usageNode", "groupUsageNode"]);
  for (const mutate of [() => {}, (d) => { d.stats.net.ifaces = null; },
    (d) => { d.docker.containers[0].ports = {}; }, (d) => { d.usage.stats.web = null; },
    (d) => { d.health.web = []; }, (d) => { d.availability.outages = {}; }]) {
    const data = validPeerSnapshot();
    mutate(data);
    fixture.set(data);
    snapshot = await fixture.read();
    const server = snapshot.servers[0];
    assert.doesNotThrow(() => {
      status.serviceStatus(server.services[0], server);
      usage.usageNode(snapshot.docker.containers[0], server);
      usage.groupUsageNode(snapshot.docker.containers, server);
      if (snapshot.stats) {
        stats.systemCard(snapshot.stats);
        stats.sensorsCard(snapshot.stats);
        if (snapshot.stats.net) stats.networkCard(snapshot.stats.net, 5, [{ rx: 1, tx: 2, at: 1 }]);
        if (snapshot.stats.availability) stats.availabilityCard(snapshot.stats, server);
      }
    });
  }
});

test("peer failure diagnostics never expose response bodies, redirects, or raw errors", async (t) => {
  const fixture = await snapshotFixture(t);
  fixture.set(null);
  const initial = await fixture.read();
  assert.equal(initial.ok, false);
  assert.equal(initial.lastOk, 0);
  fixture.set(new Response('private-token not json'));
  assert.equal((await fixture.read()).error, "Could not read peer response");
  fixture.set(new Response(null, { status: 302, headers: { location: "http://private-token.test" } }));
  assert.match((await fixture.read()).error, /redirected/);
  fixture.set(new Error("private-token payload"));
  assert.equal((await fixture.read()).error, "Could not read peer response");
  fixture.set(new Response("x".repeat(5 * 1024 * 1024 + 1)));
  assert.equal((await fixture.read()).error, "Peer response too large");
  fixture.set(validPeerSnapshot());
  const recovered = await fixture.read();
  assert.ok(recovered.lastOk > 0);
  fixture.set({ ...validPeerSnapshot(), refreshError: "private-token payload" });
  const partial = await fixture.read();
  assert.equal(partial.lastOk, recovered.lastOk);
  assert.equal(partial.refreshError, "Peer reported an incomplete refresh");
  assert.doesNotMatch(JSON.stringify(fixture.logs), /private-token|payload/);
});

test("peer server info validates before caching and preserves optional older fields", async (t) => {
  const fixture = await snapshotFixture(t);
  for (const data of [null, {}, { system: [] }, { system: {} },
    { system: { hostname: "host" }, network: { ipv4: [null] } },
    { system: { hostname: "host" }, docker: { available: "yes" } },
    { system: { hostname: "host", uptime: "bad" } }]) {
    fixture.set(data);
    await assert.rejects(fixture.remotes.getRemoteInfo(fixture.id), /Invalid peer server info/);
  }
  fixture.set({ system: { hostname: "x".repeat(1000) }, extra: "secret" });
  const info = await fixture.remotes.getRemoteInfo(fixture.id);
  assert.equal(info.system.hostname.length, 200);
  assert.equal(info.extra, undefined);
  assert.equal(await fixture.remotes.getRemoteInfo(fixture.id), info);
});

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
  assert.equal(jobs.length, 2, "per-client admission precedes derivation");
  jobs.splice(0).forEach((finish) => finish());
  assert.deepEqual(await Promise.all(attempts), [401, 401, 429]);
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

async function authSecurityFixture(env = {}) {
  const jobs = [];
  let initialized = false;
  const password = env.PASSWORD || "correct";
  const auth = loadLib("auth", {
    "./env": { PASSWORD: password, SESSION_DAYS: 30, LOGIN_MAX_FAILURES: 2,
      LOGIN_LOCKOUT: 60, ...env },
    fs: { promises: { readFile: async () => "saved-key" } },
    "./config": {},
    "./logger": { info() {}, warn() {} },
    crypto: { ...crypto, scrypt(input, salt, size, callback) {
      if (!initialized) {
        initialized = true;
        callback(null, Buffer.alloc(size, 1));
      } else jobs.push((error) => callback(error,
        Buffer.alloc(size, input === password ? 1 : 2)));
    } },
  });
  await auth.initAuth();
  function attempt(input = "wrong", ip = "client", headers = {}, encrypted = false) {
    const req = Readable.from([Buffer.from(JSON.stringify({ password: input }))]);
    req.headers = headers;
    req.socket = { remoteAddress: ip, encrypted };
    const res = { writeHead(status, responseHeaders) {
      this.status = status;
      this.headers = responseHeaders;
    }, end() {} };
    return auth.handleLogin(req, res).then(() => res);
  }
  async function finish(input = "wrong", ip = "client", headers = {}, encrypted = false) {
    const result = attempt(input, ip, headers, encrypted);
    await new Promise(setImmediate);
    jobs.splice(0).forEach((done) => done());
    return result;
  }
  return { auth, jobs, attempt, finish };
}

test("login admission bounds global work, leaves shared-IP fairness, and releases failed slots", async () => {
  const { jobs, attempt, finish } = await authSecurityFixture();
  const a = attempt("wrong", "shared");
  const b = attempt("correct", "shared");
  const rejected = await attempt("wrong", "shared");
  assert.equal(rejected.status, 429);
  const c = attempt("correct", "other");
  await new Promise(setImmediate);
  assert.equal(jobs.length, 3);
  assert.equal((await attempt("correct", "third")).status, 429);
  jobs.shift()();
  assert.equal((await a).status, 401);
  jobs.shift()();
  assert.equal((await b).status, 200);
  jobs.shift()();
  assert.equal((await c).status, 200);
  assert.equal((await finish("wrong", "shared")).status, 401,
    "admission rejection is not a failure and success resets shared-IP count");
  const broken = attempt("correct", "broken");
  const rejection = assert.rejects(broken, /derivation failed/);
  await new Promise(setImmediate);
  jobs.shift()(new Error("derivation failed"));
  await rejection;
  assert.equal((await finish("correct", "broken")).status, 200);
});

test("login validates input before derivation and preserves long UTF-8 configured passwords", async () => {
  const { jobs, attempt, finish, auth } = await authSecurityFixture({ PASSWORD: "é".repeat(700) });
  for (const input of [null, 4, {}, "é".repeat(701)]) {
    assert.equal((await attempt(input)).status, 400);
    assert.equal(jobs.length, 0);
  }
  assert.equal((await finish("é".repeat(700))).status, 200);
  const req = Readable.from([Buffer.from("invalid json")]);
  req.headers = {};
  req.socket = { remoteAddress: "client" };
  await assert.rejects(auth.handleLogin(req, {}), { status: 400 });
  assert.equal((await finish("é".repeat(700))).status, 200,
    "invalid bodies release admission slots");
});

test("failure records expire, are capped without evicting protections, and recover capacity", async (t) => {
  let now = 1_000_000;
  t.mock.method(Date, "now", () => now);
  const { finish, attempt, jobs } = await authSecurityFixture();
  for (let i = 0; i < 4096; i++) {
    assert.equal((await finish("wrong", `client-${i}`)).status, 401);
  }
  assert.equal((await attempt("correct", "new")).status, 429);
  assert.equal(jobs.length, 0);
  const success = attempt("correct", "client-1");
  const pendingFailure = attempt("wrong", "client-1");
  await new Promise(setImmediate);
  jobs.shift()();
  assert.equal((await success).status, 200);
  assert.equal((await attempt("correct", "new")).status, 429,
    "success retains capacity reservation while a same-IP request is pending");
  jobs.shift()();
  assert.equal((await pendingFailure).status, 401);
  assert.equal((await finish("wrong", "client-0")).status, 401);
  assert.equal((await attempt("correct", "client-0")).status, 429);
  now += 15 * 60 * 1000 + 1;
  assert.equal((await finish("correct", "new")).status, 200);
  assert.equal((await finish("wrong", "client-0")).status, 401);
  assert.equal((await finish("wrong", "client-0")).status, 401,
    "expired partial failures do not carry forward");
  assert.equal((await attempt("wrong", "client-0")).status, 429);
});

test("long lockouts outlive failure TTL and concurrent success does not lose later failures", async (t) => {
  let now = 1_000_000;
  t.mock.method(Date, "now", () => now);
  const { finish, attempt, jobs } = await authSecurityFixture({ LOGIN_LOCKOUT: 3600 });
  const success = attempt("correct");
  const failure = attempt("wrong");
  await new Promise(setImmediate);
  jobs.shift()();
  assert.equal((await success).status, 200);
  jobs.shift()();
  assert.equal((await failure).status, 401);
  assert.equal((await finish()).status, 401);
  now += 15 * 60 * 1000 + 1;
  assert.equal((await attempt()).status, 429);
  now += 3600 * 1000;
  assert.equal((await finish("correct")).status, 200);
});

test("forwarded IP and secure login/logout cookies require explicit proxy trust", async () => {
  for (const trusted of [false, true]) {
    const { auth, finish, attempt } = await authSecurityFixture({ TRUST_PROXY: trusted });
    const headers = { "x-forwarded-for": "spoof, visitor-a", "x-forwarded-proto": "https" };
    const login = await finish("correct", "proxy", headers);
    assert.equal(login.headers["Set-Cookie"].includes("; Secure"), trusted);
    const res = { writeHead(status, responseHeaders) { this.headers = responseHeaders; }, end() {} };
    auth.handleLogout({ headers, socket: {} }, res);
    assert.equal(res.headers["Set-Cookie"].includes("; Secure"), trusted);
    const tls = await finish("correct", "tls", {}, true);
    assert.ok(tls.headers["Set-Cookie"].includes("; Secure"));
    await finish("wrong", "proxy", headers);
    await finish("wrong", "proxy", headers);
    const changed = { ...headers, "x-forwarded-for": "visitor-a, visitor-b" };
    if (trusted) assert.equal((await finish("correct", "proxy", changed)).status, 200);
    else assert.equal((await attempt("correct", "proxy", changed)).status, 429);
  }
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

test("health pool deadlines release workers and completion survives a departed consumer", async () => {
  const requests = [];
  const timers = [];
  const health = loadLib("health", {
    "./config": { readConfig: async () => ({ servers: [{ services:
      [1, 2, 3].map((id) => ({ id: String(id), url: `http://service${id}.test` })) }] }) },
    "./tunables": { get: (key) => ({ healthParallel: 2, healthTimeout: 6,
      healthCache: 45, refreshGap: 5 })[key] },
    "./logger": { info() {}, warn() {} },
    timers: {
      setTimeout(fn, ms) { const timer = { fn, ms, cleared: false }; timers.push(timer); return timer; },
      clearTimeout(timer) { timer.cleared = true; },
    },
    http: { request(url, options, callback) {
      const req = new EventEmitter();
      req.end = () => {};
      req.destroy = (err) => req.emit("error", err);
      requests.push({ req, callback });
      return req;
    } },
  });
  const collection = health.getHealth();
  await new Promise(setImmediate);
  assert.equal(requests.length, 2);
  assert.equal(timers[0].ms, 6000);
  // A consumer cancels its wait, without attaching cancellation to shared work.
  const consumer = new AbortController();
  const departed = Promise.race([collection, new Promise((resolve, reject) => {
    consumer.signal.addEventListener("abort", () => reject(new Error("consumer aborted")), { once: true });
  })]);
  consumer.abort();
  await assert.rejects(departed, /consumer aborted/);
  const joined = health.getHealth({ fresh: true });
  timers[0].fn(); // No socket timeout event: absolute deadline alone releases the worker.
  await new Promise(setImmediate);
  assert.equal(requests.length, 3);
  for (const request of requests.slice(1)) request.callback({ statusCode: 200, destroy() {} });
  const result = await collection;
  assert.equal(await joined, result);
  assert.equal(result.results["1"].state, "down");
  assert.equal(result.results["3"].state, "up");
  assert.ok(timers.every((timer) => timer.cleared));
  assert.equal(await health.getHealth({ fresh: true }), result); // Forced-refresh minimum gap.
  assert.equal(requests.length, 3);
});

test("Docker usage bounds full responses, retains successful samples on timeout, and retries fresh", async () => {
  const requests = [];
  const timers = [];
  const docker = loadLib("docker", {
    "./env": { CONTAINER_STATS_INTERVAL: 30 },
    "./tunables": { get: (key) => ({ dockerParallel: 2, refreshGap: 0 })[key] },
    timers: {
      setTimeout(fn, ms) { const timer = { fn, ms, cleared: false }; timers.push(timer); return timer; },
      clearTimeout(timer) { timer.cleared = true; },
    },
    http: { request(options, callback) {
      const req = new EventEmitter();
      req.end = () => {};
      req.destroy = (err) => req.emit("error", err);
      requests.push({ req, callback, options });
      return req;
    } },
  });
  const reply = (index, data) => {
    const res = new EventEmitter();
    res.statusCode = 200;
    res.setEncoding = () => {};
    requests[index].callback(res);
    res.emit("data", JSON.stringify(data));
    res.emit("end");
  };
  const first = docker.getContainerStats();
  reply(0, [{ Names: ["/one"] }]);
  await new Promise(setImmediate);
  reply(1, { memory_stats: { usage: 123, limit: 456 } });
  const good = await first;
  assert.equal(good.ok, true);
  assert.equal(good.stats.one.mem, 123);
  assert.equal(timers[0].ms, 5000);
  assert.equal(timers[1].ms, 8000);
  const fresh = docker.getContainerStats({ fresh: true });
  const joined = docker.getContainerStats({ fresh: true });
  reply(2, [{ Names: ["/one"] }, { Names: ["/two"] }, { Names: ["/three"] }]);
  await new Promise(setImmediate);
  assert.equal(requests.length, 5); // Two pool workers.
  const trickling = new EventEmitter();
  trickling.statusCode = 200;
  trickling.setEncoding = () => {};
  requests[3].callback(trickling);
  trickling.emit("data", "{"); // Activity must not extend the absolute deadline.
  timers[3].fn();
  await new Promise(setImmediate);
  assert.equal(requests.length, 6);
  reply(4, {});
  reply(5, {});
  const failed = await fresh;
  assert.deepEqual(await joined, failed);
  assert.equal(failed.ok, false);
  assert.equal(failed.collectedAt, good.collectedAt);
  assert.equal(failed.stats, good.stats);
  assert.ok(timers.every((timer) => timer.cleared));
  const retry = docker.getContainerStats({ fresh: true });
  reply(6, []);
  assert.equal((await retry).ok, true);
});

test("disabled container monitoring never starts collection, including forced refresh", async () => {
  const docker = loadLib("docker", {
    "./env": { CONTAINER_STATS_INTERVAL: 0 },
    http: { request() { assert.fail("disabled collection must not contact Docker"); } },
  });
  assert.deepEqual(await docker.getContainerStats(), { interval: 0, stats: {} });
  assert.deepEqual(await docker.getContainerStats({ fresh: true }), { interval: 0, stats: {} });
});

test("collection timeout defaults and saved legacy values reach the browser", () => {
  for (const [saved, remote, browser] of [[{}, 60, 75], [{ remoteTimeout: 8, loadTimeout: 15 }, 8, 15]]) {
    const tunables = loadLib("tunables", {
      fs: { readFileSync: () => JSON.stringify(saved) },
    });
    assert.equal(tunables.get("remoteTimeout"), remote);
    assert.equal(tunables.clientValues().remoteTimeout, remote);
    assert.equal(tunables.clientValues().loadTimeout, browser);
  }
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


test("persisted loaders reject corrupt and inaccessible stores without writing", async () => {
  for (const failure of [new SyntaxError("private parse details"),
    Object.assign(new Error("private path"), { code: "EACCES" })]) {
    let writes = 0;
    const config = { writeAtomic: async () => { writes++; } };
    const disk = { promises: { readFile: async () => { throw failure; } } };
    const clip = loadLib("clip", { fs: disk, "./env": {}, "./config": config });
    await assert.rejects(clip.readClip(), (err) => err === failure);
    await assert.rejects(clip.writeClip({ text: "replacement" }), (err) => err === failure);
    const remotes = remoteFixture(config.writeAtomic, { fs: disk });
    await assert.rejects(remotes.setSharing(true), (err) => err === failure);
    const info = loadLib("serverinfo", { fs: { ...fs, ...disk }, "./config": config });
    // A valid manual address must not bypass loading the existing store.
    await assert.rejects(info.saveSettings({ mode: "manual", manualIp: "127.0.0.1" }),
      (err) => err === failure);
    const availability = loadLib("availability", {
      fs: disk, "./env": {}, "./config": config,
    });
    await assert.rejects(availability.init(), (err) => err === failure);
    await assert.rejects(availability.clearHistory(), (err) => err === failure);
    const tunables = loadLib("tunables", {
      fs: { readFileSync: () => { throw failure; } }, "./env": {}, "./config": config,
    });
    assert.throws(() => tunables.list(), (err) => err === failure);
    await assert.rejects(tunables.save({}), (err) => err === failure);
    assert.equal(writes, 0);
  }
});

test("missing stores retain first-run defaults", async () => {
  const missing = Object.assign(new Error("missing"), { code: "ENOENT" });
  const disk = { promises: { readFile: async () => { throw missing; } } };
  const config = { writeAtomic: async () => {} };
  const clip = loadLib("clip", { fs: disk, "./env": {}, "./config": config });
  assert.equal((await clip.readClip()).text, "");
  const remotes = remoteFixture(config.writeAtomic, { fs: disk });
  assert.equal((await remotes.remoteSettings()).refreshInterval, 10);
  const info = loadLib("serverinfo", { fs: { ...fs, ...disk }, "./config": config });
  assert.equal((await info.getSettings()).mode, "off");
  const availability = loadLib("availability", { fs: disk, "./env": {}, "./config": config });
  await availability.init();
  await availability.saveSettings({ enabled: false });
  assert.equal((await availability.getAvailability()).enabled, false);
  const tunables = loadLib("tunables", {
    fs: { readFileSync: () => { throw missing; } }, "./env": {}, "./config": config,
  });
  assert.ok(tunables.list().length);
});

test("availability settings and clear commit only after successful persistence and retry", async () => {
  let fail = false;
  let persisted;
  const availability = loadLib("availability", {
    "./env": {},
    fs: { promises: { readFile: async () => JSON.stringify({
      since: 1, settings: { enabled: false }, outages: [{ start: 1, end: 2 }],
    }) } },
    "./config": { writeAtomic: async (file, text) => {
      if (fail) throw new Error("disk full");
      persisted = JSON.parse(text);
    } },
  });
  await availability.init();
  fail = true;
  await assert.rejects(availability.saveSettings({ interval: 10 }), /disk full/);
  assert.equal((await availability.getAvailability()).interval, 5);
  await assert.rejects(availability.clearHistory(), /disk full/);
  assert.equal((await availability.getAvailability()).records, 1);
  fail = false;
  await availability.saveSettings({ interval: 10 });
  await availability.clearHistory();
  assert.equal(persisted.settings.interval, 10);
  assert.equal(persisted.outages.length, 0);
});

test("availability migration preserves legacy records without claiming unknowable history", async () => {
  let persisted;
  const original = { since: 1, settings: { enabled: false }, outages: [{ start: 10, end: 20 }] };
  const availability = loadLib("availability", {
    "./env": {}, fs: { promises: { readFile: async () => JSON.stringify(original) } },
    "./config": { writeAtomic: async (_, text) => { persisted = JSON.parse(text); } },
  });
  const a = await availability.getAvailability({ outages: 500 });
  assert.deepEqual(a.outages, original.outages);
  assert.equal(a.since, 1);
  assert.equal(a.legacyHistory, true);
  assert.ok(a.coverageSince > 20);
  assert.equal(a.windows.all.limited, true);
  assert.equal(a.windows.all.observed, 0);
  assert.equal(a.windows.all.pct, null);
  assert.equal(persisted.coverageSince, a.coverageSince);
  const reloaded = loadLib("availability", {
    "./env": {}, fs: { promises: { readFile: async () => JSON.stringify(persisted) } },
    "./config": { writeAtomic: async () => {} },
  });
  assert.equal((await reloaded.getAvailability()).coverageSince, a.coverageSince);
});

test("availability caps advance coverage for both outages and pauses and clip rolling metrics", async () => {
  const now = Date.now();
  const day = 86400000;
  let persisted;
  const outages = Array.from({ length: 501 }, (_, i) => ({ start: now - 2 * day + i * 1000, end: now - 2 * day + i * 1000 + 500 }));
  const paused = Array.from({ length: 101 }, (_, i) => ({ start: now - day + i * 1000, end: now - day + i * 1000 + 500 }));
  const availability = loadLib("availability", {
    "./env": {}, fs: { promises: { readFile: async () => JSON.stringify({
      since: now - 40 * day, coverageSince: now - 40 * day, settings: { enabled: true },
      lastHeartbeat: now, outages, paused,
    }) } },
    "./config": { writeAtomic: async (_, text) => { persisted = JSON.parse(text); } },
  });
  const a = await availability.getAvailability();
  assert.equal(persisted.outages.length, 500);
  assert.equal(persisted.paused.length, 100);
  assert.equal(a.coverageSince, paused[0].end);
  assert.equal(a.windows.all.from, a.coverageSince);
  assert.equal(a.windows.week.limited, true);
  assert.equal(a.windows.all.down, 0);
  assert.equal(a.windows.all.observed, a.now - a.coverageSince - 100 * 500);
  const cleared = await availability.clearHistory();
  assert.ok(cleared.coverageSince >= a.coverageSince);
  assert.equal(cleared.records, 0);
  assert.equal(persisted.paused.length, 0);
  assert.equal(persisted.lastHeartbeat, cleared.coverageSince);
});

test("availability rolling windows count only retained intersecting downtime", async () => {
  const now = Date.now();
  const day = 86400000;
  const availability = loadLib("availability", {
    "./env": {}, fs: { promises: { readFile: async () => JSON.stringify({
      since: now - 40 * day, coverageSince: now - 10 * day, lastHeartbeat: now,
      outages: [{ start: now - 2 * day, end: now - day / 2 }], paused: [],
    }) } }, "./config": { writeAtomic: async () => {} },
  });
  const a = await availability.getAvailability();
  assert.equal(a.windows.day.limited, false);
  assert.equal(a.windows.month.limited, true);
  assert.equal(a.windows.day.down, now - day / 2 - a.windows.day.from);
  assert.equal(a.windows.day.longest, a.windows.day.down);
  assert.equal(a.windows.week.down, 1.5 * day);
  assert.ok(a.windows.day.pct < 100);
});

test("availability live pruning and disabled clear never restore discarded coverage", async () => {
  const now = Date.now();
  const outages = Array.from({ length: 500 }, (_, i) => ({ start: now - 2000000 + i * 1000, end: now - 2000000 + i * 1000 + 500 }));
  const paused = Array.from({ length: 100 }, (_, i) => ({ start: now - 1000000 + i * 1000, end: now - 1000000 + i * 1000 + 500 }));
  let persisted;
  const availability = loadLib("availability", {
    "./env": {}, os: { uptime: () => 1000000 },
    fs: { promises: { readFile: async () => JSON.stringify({
      since: now - 3000000, coverageSince: now - 3000000,
      lastHeartbeat: now - 700000, outages, paused,
    }) } }, "./config": { writeAtomic: async (_, text) => { persisted = JSON.parse(text); } },
  });
  const started = await availability.getAvailability();
  assert.equal(started.records, 500);
  assert.equal(started.coverageSince, outages[0].end);
  assert.equal(persisted.outages.at(-1).kind, "app");
  const disabled = await availability.saveSettings({ enabled: false });
  assert.equal(disabled.coverageSince, paused[0].end);
  const cleared = await availability.clearHistory();
  assert.equal(cleared.windows.all.observed, 0);
  assert.equal(cleared.windows.all.pct, null);
  assert.deepEqual(persisted.paused, [{ start: cleared.coverageSince, end: null }]);
  const enabled = await availability.saveSettings({ enabled: true });
  assert.equal(enabled.coverageSince, cleared.coverageSince);
  assert.ok(persisted.paused[0].end >= cleared.coverageSince);
});

test("peer availability coverage is preserved and inconsistent metadata rejected", async (t) => {
  const fixture = await snapshotFixture(t);
  const data = validPeerSnapshot();
  for (const a of [data.availability, data.stats.availability]) {
    a.coverageSince = 51;
    a.legacyHistory = true;
    for (const w of Object.values(a.windows)) Object.assign(w, { from: 51, requestedFrom: 1, limited: true, observed: 50 });
  }
  fixture.set(data);
  const good = await fixture.read();
  assert.equal(good.availability.coverageSince, 51);
  assert.equal(good.availability.windows.day.limited, true);
  data.availability.windows.day.limited = false;
  fixture.set(data);
  assert.match((await fixture.read()).refreshError, /availability/);
});

test("configuration protects corrupt files and requires a successful backup", async (t) => {
  const dir = await temporaryDirectory(t);
  const target = path.join(dir, "config.json");
  const failure = Object.assign(new Error("backup denied"), { code: "EACCES" });
  let denyBackup = false;
  const config = loadLib("config", {
    "./env": { DATA_DIR: dir, CONFIG_FILE: target },
    fs: { promises: { ...fs.promises, copyFile: async (...args) => {
      if (denyBackup) throw failure;
      return fs.promises.copyFile(...args);
    } } },
  });
  await config.writeConfig({ servers: [] }); // Missing source is a normal first save.
  const original = await fs.promises.readFile(target, "utf8");
  denyBackup = true;
  await assert.rejects(config.writeConfig({ servers: [{ name: "new" }] }), (err) => err === failure);
  assert.equal(await fs.promises.readFile(target, "utf8"), original);
  denyBackup = false;
  await config.writeConfig({ servers: [{ name: "retry" }] });
  assert.equal(await fs.promises.readFile(`${target}.bak`, "utf8"), original);
  await fs.promises.writeFile(target, "{damaged");
  await assert.rejects(config.writeConfig({ servers: [] }), SyntaxError);
  assert.equal(await fs.promises.readFile(target, "utf8"), "{damaged");
  assert.equal(await fs.promises.readFile(`${target}.bak`, "utf8"), original);
});

test("configuration revision compare-and-write shares the write queue", async (t) => {
  const dir = await temporaryDirectory(t);
  const target = path.join(dir, "config.json");
  const store = loadLib("config", { "./env": { DATA_DIR: dir, CONFIG_FILE: target } });
  const base = { settings: { title: "base" }, servers: [] };
  const revision = await store.writeConfig(base);
  assert.equal(revision, store.configRevision(await store.readConfig()));
  const first = { ...base, settings: { title: "first" } };
  const second = { ...base, settings: { title: "second" } };
  const results = await Promise.allSettled([
    store.writeConfig(first, revision), store.writeConfig(second, revision),
  ]);
  assert.equal(results[0].status, "fulfilled");
  assert.equal(results[1].status, "rejected");
  assert.equal(results[1].reason.status, 409);
  assert.deepEqual(await store.readConfig(), first);
  assert.deepEqual(JSON.parse(await fs.promises.readFile(`${target}.bak`, "utf8")), base);
  const latest = store.configRevision(first);
  await assert.rejects(store.writeConfig(second, null), { status: 409 });
  await store.writeConfig(second, latest); // A rejected conflict does not poison the queue.
  await store.writeConfig(base); // Legacy callers retain their whole-document contract.
  assert.deepEqual(await store.readConfig(), base);
});

test("failed configuration persistence does not advance the revision", async (t) => {
  const dir = await temporaryDirectory(t);
  const target = path.join(dir, "config.json");
  let fail = false;
  const store = loadLib("config", {
    "./env": { DATA_DIR: dir, CONFIG_FILE: target },
    fs: { promises: { ...fs.promises, rename: async (...args) => {
      if (fail) throw new Error("disk failure");
      return fs.promises.rename(...args);
    } } },
  });
  const base = { servers: [] };
  const revision = await store.writeConfig(base);
  fail = true;
  await assert.rejects(store.writeConfig({ servers: [{ name: "new" }] }, revision), /disk failure/);
  assert.equal(store.configRevision(await store.readConfig()), revision);
  fail = false;
  await store.writeConfig({ servers: [{ name: "retry" }] }, revision);
});
