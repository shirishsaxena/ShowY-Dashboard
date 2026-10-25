"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  PEER_OUTAGES,
  peerError,
  peerInfo,
  sanitizePeer,
} = require("../lib/peer-validation");

function availability() {
  return {
    enabled: true,
    since: 1,
    now: 101,
    coverageSince: 20,
    legacyHistory: true,
    count: 0,
    last: null,
    windows: Object.fromEntries(
      ["day", "week", "month", "all"].map((key) => [
        key,
        {
          from: 20,
          requestedFrom: 1,
          limited: true,
          observed: 81,
          down: 0,
          count: 0,
          longest: 0,
          pct: 100,
        },
      ]),
    ),
    outages: [],
  };
}

function snapshot() {
  return {
    version: "1.0",
    title: "Peer",
    servers: [
      {
        id: "host",
        name: "Host",
        local: true,
        services: [
          {
            id: "web",
            name: "Web",
            type: "web",
            urls: [{ label: "LAN", url: "http://web.test/" }],
          },
        ],
      },
    ],
    stats: {
      cpu: 10,
      cores: 4,
      uptime: 100,
      load: [0, 0, 0],
      mem: { used: 10, total: 100 },
      disks: [{ label: "System", used: 20, total: 100 }],
    },
    docker: {
      available: true,
      containers: [
        {
          name: "web",
          image: "web:latest",
          state: "running",
          status: "Up",
          ports: [80],
        },
      ],
    },
    usage: {
      interval: 10,
      stats: { web: { cpu: 150, mem: 10, memLimit: 100, rx: 1, tx: 2 } },
    },
    health: { web: { state: "up", code: 200, ms: 1 } },
    availability: availability(),
  };
}

function freeze(value) {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

test("peer validator directly normalizes known fields without mutating or aliasing input", () => {
  const input = snapshot();
  input.secret = "private";
  input.servers[0].secret = "private";
  input.servers[0].services[0].url = "javascript:stale-shadow";
  input.docker.containers[0].secret = "private";
  input.usage.stats.web.secret = "private";
  const original = structuredClone(input);
  const result = sanitizePeer(freeze(input));
  assert.equal(result.refreshError, "");
  assert.equal(result.servers[0].services[0].url, "http://web.test/");
  assert.equal(result.usage.stats.web.cpu, 150);
  assert.equal(result.stats.cpuModel, "");
  assert.deepEqual(result.stats.temps, []);
  assert.deepEqual(result.stats.fans, []);
  assert.equal(result.stats.interval, 0);
  assert.doesNotMatch(JSON.stringify(result), /private|stale-shadow/);
  result.servers[0].services[0].urls[0].label = "Changed";
  result.stats.mem.used = 99;
  result.availability.windows.day.pct = 1;
  assert.deepEqual(input, original);
  assert.equal(sanitizePeer(input).servers[0].services[0].urls[0].label, "LAN");
  assert.equal(sanitizePeer(input).stats.mem.used, 10);
  assert.equal(sanitizePeer(input).availability.windows.day.pct, 100);
});

test("peer validator rejects non-record snapshots with the safe error contract", () => {
  for (const input of [null, undefined, [], "private payload", 1, true]) {
    assert.throws(
      () => sanitizePeer(input),
      (error) =>
        error instanceof Error &&
        error.peerSafe === true &&
        error.message === "Invalid peer snapshot",
    );
  }
  const error = peerError("Peer response too large");
  assert.ok(error instanceof Error);
  assert.equal(error.peerSafe, true);
  assert.equal(error.message, "Peer response too large");
});

test("peer validator isolates malformed metrics instead of inventing zero success", () => {
  for (const mutate of [
    (data) => (data.stats.cpu = 101),
    (data) => (data.stats.cpu = NaN),
    (data) => (data.stats.cpu = "10"),
    (data) => (data.stats.mem.used = 101),
    (data) => (data.stats.disks[0].used = 101),
    (data) => (data.stats.cores = Infinity),
  ]) {
    const data = snapshot();
    mutate(data);
    const result = sanitizePeer(data);
    assert.equal(result.stats, null);
    assert.equal(
      result.refreshError,
      "Invalid or incomplete peer snapshot: stats",
    );
    assert.equal(result.docker.available, true);
    assert.equal(result.health.web.state, "up");
    assert.equal(result.servers[0].id, "host");
  }
});

test("peer validator preserves deterministic issue order and safe fallback shapes", () => {
  const data = snapshot();
  data.stats = null;
  data.docker = null;
  data.version = {};
  data.title = {};
  const result = sanitizePeer(data);
  assert.deepEqual(result.docker, {
    available: false,
    error: "Invalid Docker snapshot",
    containers: [],
  });
  assert.equal(result.version, "");
  assert.equal(result.title, "");
  assert.equal(
    result.refreshError,
    "Invalid or incomplete peer snapshot: stats, docker, version, title, docker unavailable",
  );
});

test("peer validator retains older optional fields and nonlocal empty snapshots", () => {
  const result = sanitizePeer({
    servers: [{ id: "remote", name: "Remote", services: [] }],
    stats: null,
    docker: { available: false, containers: [] },
    usage: { interval: 0, stats: {} },
    health: {},
  });
  assert.equal(result.refreshError, "");
  assert.equal(result.stats, null);
  assert.equal(result.availability, null);
  assert.equal(result.version, "");
  assert.equal(result.title, "");
  assert.deepEqual(result.servers[0].groups, []);
  assert.deepEqual(result.usage, { interval: 0, stats: {} });
});

test("peer validator requires monitored health but excludes bookmarks and empty canonical URLs", () => {
  const data = snapshot();
  data.health = {};
  assert.equal(
    sanitizePeer(data).refreshError,
    "Invalid or incomplete peer snapshot: health",
  );
  data.servers[0].services[0].type = "bookmark";
  assert.equal(sanitizePeer(data).refreshError, "");
  data.servers[0].services[0].type = "docker";
  data.servers[0].services[0].container = "web";
  data.servers[0].services[0].urls = [];
  data.servers[0].services[0].url = "http://stale-shadow.test/";
  assert.equal(sanitizePeer(data).refreshError, "");
});

test("peer validator bounds collections and rejects dangerous or invalid map keys", () => {
  for (const key of [
    "__proto__",
    "constructor",
    "prototype",
    "",
    "x".repeat(201),
  ]) {
    const data = snapshot();
    data.usage.stats = Object.fromEntries([[key, data.usage.stats.web]]);
    const result = sanitizePeer(data);
    assert.deepEqual(result.usage, { interval: 0, stats: {} });
    assert.equal(
      result.refreshError,
      "Invalid or incomplete peer snapshot: usage",
    );
  }
  for (const [section, mutate] of [
    ["servers", (data) => (data.servers = Array(101).fill(data.servers[0]))],
    [
      "stats",
      (data) => (data.stats.disks = Array(129).fill(data.stats.disks[0])),
    ],
    ["docker", (data) => (data.docker.containers[0].ports = [0])],
    [
      "usage",
      (data) => {
        data.usage.stats = Object.fromEntries(
          Array.from({ length: 2001 }, (_, i) => [
            `container-${i}`,
            data.usage.stats.web,
          ]),
        );
      },
    ],
  ]) {
    const data = snapshot();
    mutate(data);
    assert.match(sanitizePeer(data).refreshError, new RegExp(section));
  }
  assert.equal(Object.hasOwn(Object.prototype, "mem"), false);
});

test("peer validator shares the outgoing outage bound and preserves coverage invariants", () => {
  assert.equal(PEER_OUTAGES, 100);
  const data = snapshot();
  data.availability.outages = Array.from({ length: PEER_OUTAGES }, () => ({
    start: 20,
    end: 21,
    kind: "app",
  }));
  const result = sanitizePeer(data);
  assert.equal(result.refreshError, "");
  assert.deepEqual(result.availability, data.availability);
  data.availability.outages.push({ start: 20, end: 21 });
  assert.equal(sanitizePeer(data).availability, null);
  data.availability = availability();
  data.availability.windows.day.limited = false;
  assert.equal(sanitizePeer(data).availability, null);
  data.availability = availability();
  data.availability.windows.day.observed = 82;
  assert.equal(sanitizePeer(data).availability, null);
});

test("peer validator masks reported refresh details and detects incomplete container usage", () => {
  const data = snapshot();
  data.refreshError = "private token and response body";
  assert.equal(
    sanitizePeer(data).refreshError,
    "Peer reported an incomplete refresh",
  );
  data.usage.stats = {};
  assert.equal(
    sanitizePeer(data).refreshError,
    "Invalid or incomplete peer snapshot: usage incomplete",
  );
  data.usage.ok = false;
  assert.equal(
    sanitizePeer(data).refreshError,
    "Invalid or incomplete peer snapshot: usage unavailable, usage incomplete",
  );
});

test("peer info validates then projects bounded fields without leaking unknown metadata", () => {
  const input = {
    at: 123,
    system: { hostname: "h".repeat(300), cpuCores: 4, secret: "private" },
    network: {
      ipv4: [{ address: "10.0.0.1", iface: "eth0", mac: "private" }],
      interfaces: ["eth0"],
    },
    docker: { available: true, version: "v".repeat(100), paths: "private" },
    token: "private",
  };
  const original = structuredClone(input);
  const result = peerInfo(freeze(input));
  assert.equal(result.system.hostname.length, 200);
  assert.equal(result.system.cpuCores, 4);
  assert.equal(result.system.uptime, null);
  assert.equal(result.docker.version.length, 40);
  assert.equal(result.at, 123);
  assert.deepEqual(result.network.ipv4, [
    { address: "10.0.0.1", iface: "eth0" },
  ]);
  assert.doesNotMatch(JSON.stringify(result), /private/);
  result.network.ipv4[0].address = "changed";
  assert.deepEqual(input, original);
  assert.equal(
    peerInfo({ system: { hostname: "old" } }).system.hostname,
    "old",
  );
});

test("peer info rejects malformed sections with only a safe protocol diagnostic", () => {
  for (const input of [
    { system: { hostname: "" } },
    { system: { hostname: "host", uptime: -1 } },
    { system: { hostname: "host" }, network: { ipv4: [null] } },
    {
      system: { hostname: "host" },
      network: { interfaces: Array(33).fill("eth0") },
    },
    { system: { hostname: "host" }, docker: { available: "private" } },
  ]) {
    assert.throws(
      () => peerInfo(input),
      (error) =>
        error.peerSafe === true && error.message === "Invalid peer server info",
    );
  }
});
