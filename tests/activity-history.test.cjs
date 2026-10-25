"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// This file has its own runner process. All real stores stay in disposable data.
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "showy-activity-"));
Object.assign(process.env, {
  DATA_DIR: directory,
  LOG_DIR: path.join(directory, "logs"),
  LOG_LEVEL: "ERROR",
  DASHBOARD_PASSWORD: "",
  SHARE_TOKEN: "",
  REMOTE_DASHBOARDS: "",
  REMOTE_REFRESH_INTERVAL: "",
  DOCKER_CONTROL: "false",
  TRUST_PROXY: "false",
});
delete process.env.HEALTH_TIMEOUT;
const { createServer } = require("../server");
const configStore = require("../lib/config");
const activity = require("../lib/activity");
const logger = require("../lib/logger");
let server;
let origin;

test.before(async () => {
  server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  origin = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  if (server) {
    const closed = new Promise((resolve) => server.close(resolve));
    server.closeIdleConnections();
    await closed;
  }
  await logger.close();
  fs.rmSync(directory, { recursive: true, force: true });
});

async function call(url, method = "GET", body) {
  const response = await fetch(origin + url, {
    method,
    headers: {
      Origin: origin,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, data: await response.json() };
}
const history = async () => (await call("/api/activity")).data.entries;
const clear = () => call("/api/activity", "DELETE", {});
const base = () => ({
  settings: {
    title: "Home Lab",
    favorites: [],
    hiddenContainers: [],
    links: [],
  },
  servers: [
    {
      id: "nas",
      name: "NAS",
      groups: ["Media"],
      services: [
        {
          id: "plex",
          name: "Plex",
          type: "web",
          group: "Media",
          urls: [{ label: "LAN", url: "http://old.example.test/" }],
          notes: "",
        },
      ],
    },
  ],
});

test("service edits record the exact entity and field labels without private contents", async () => {
  const created = await call("/api/config", "PUT", base());
  assert.equal(created.status, 200);
  await clear();
  const cfg = structuredClone(created.data.config);
  Object.assign(cfg.servers[0].services[0], {
    urls: [
      {
        label: "secret-label-sentinel",
        url: "https://user:password-sentinel@example.test/?token=url-token-sentinel",
      },
    ],
    notes: "private-notes-sentinel",
    description: "private-description-sentinel",
    icon: "plex",
  });
  const saved = await call("/api/config", "PUT", {
    ...cfg,
    _revision: created.data.revision,
    _activity: { title: "client-forged-title-sentinel" },
  });
  assert.equal(saved.status, 200);
  const entries = await history();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].title, "Service updated: “Plex”");
  assert.match(entries[0].message, /Server: “NAS”/);
  for (const field of ["URLs", "notes", "description", "icon"])
    assert.ok(entries[0].message.includes(field));
  assert.equal(entries[0].status, "success");
  assert.doesNotMatch(
    JSON.stringify(entries),
    /sentinel|https?:|example\.test/,
  );
  const persisted = JSON.parse(
    fs.readFileSync(path.join(directory, "activity.json"), "utf8"),
  );
  assert.doesNotMatch(
    JSON.stringify(persisted),
    /sentinel|https?:|example\.test/,
  );
});

test("unchanged committed configuration does not create a misleading update entry", async () => {
  const current = (await call("/api/config")).data;
  await clear();
  const result = await call("/api/config", "PUT", {
    ...current.config,
    _revision: current.revision,
  });
  assert.equal(result.status, 200);
  assert.equal((await history()).length, 0);
});

test("a rejected revision records failure without claiming the attempted rename succeeded", async () => {
  const current = (await call("/api/config")).data;
  await clear();
  current.config.servers[0].services[0].name = "uncommitted-name-sentinel";
  const result = await call("/api/config", "PUT", {
    ...current.config,
    _revision: "stale-revision",
  });
  assert.equal(result.status, 409);
  const entries = await history();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].status, "failed");
  assert.equal(entries[0].message, "Request failed (HTTP 409).");
  assert.doesNotMatch(
    JSON.stringify(entries),
    /uncommitted-name-sentinel|Service renamed/,
  );
  assert.equal(
    (await call("/api/config")).data.config.servers[0].services[0].name,
    "Plex",
  );
});

test("serialized writes expose their actual committed predecessor without changing legacy return values", async () => {
  const initial = configStore.sanitizeConfig(base());
  const revision = await configStore.writeConfig(initial);
  assert.equal(typeof revision, "string");
  const one = structuredClone(initial);
  const two = structuredClone(initial);
  one.servers[0].services[0].name = "First";
  two.servers[0].services[0].name = "Second";
  const [first, second] = await Promise.all([
    configStore.writeConfig(one, undefined, { includePrevious: true }),
    configStore.writeConfig(two, undefined, { includePrevious: true }),
  ]);
  assert.deepEqual(first.previous, initial);
  assert.deepEqual(second.previous, one);
  assert.equal(first.revision, configStore.configRevision(one));
  assert.equal(second.revision, configStore.configRevision(two));
  assert.deepEqual(await configStore.readConfig(), two);
});

test("history description failures are best effort and failures never invoke success descriptions", async () => {
  await clear();
  await activity.recordRequest("PUT /api/config", 200, () => {
    throw new Error("private-error-sentinel");
  });
  await activity.recordRequest("PUT /api/config", 503, () => {
    throw new Error("must-not-run");
  });
  await activity.recordRequest("POST /api/login", 200, {
    title: "ignored-sentinel",
  });
  const entries = await history();
  assert.equal(entries.length, 2);
  assert.equal(entries.filter((entry) => entry.status === "success").length, 1);
  assert.equal(entries.filter((entry) => entry.status === "failed").length, 1);
  assert.doesNotMatch(JSON.stringify(entries), /sentinel|must-not-run/);
});

test("settings history records useful approved values but excludes addresses and sharing tokens", async () => {
  await clear();
  const updates = [
    ["/api/tunables", { values: { healthTimeout: 8 } }],
    ["/api/clip/settings", { max: 25 }],
    [
      "/api/availability/settings",
      { enabled: false, interval: 5, threshold: 10 },
    ],
    ["/api/info/settings", { mode: "manual", manualIp: "203.0.113.42" }],
    ["/api/remotes/interval", { interval: 30 }],
    [
      "/api/remotes/settings",
      {
        remotes: [
          {
            name: "Peer",
            url: "https://remote-private-sentinel.example",
            token: "private-token-sentinel",
          },
        ],
      },
    ],
    ["/api/share", { enabled: true }],
  ];
  let shareToken;
  for (const [url, body] of updates) {
    const result = await call(url, "PUT", body);
    assert.equal(result.status, 200, `${url}: ${JSON.stringify(result.data)}`);
    if (url === "/api/share") shareToken = result.data.shareToken;
  }
  const entries = await history();
  assert.equal(entries.length, updates.length);
  assert.ok(entries.some((entry) => entry.message.includes("8 seconds")));
  assert.ok(entries.some((entry) => entry.message === "Keep up to 25 items."));
  assert.ok(
    entries.some((entry) => entry.title === "Availability monitoring paused"),
  );
  assert.ok(
    entries.some((entry) => entry.message.includes("every 30 seconds")),
  );
  assert.ok(
    entries.some((entry) => entry.message.includes("1 dashboard connections")),
  );
  assert.ok(entries.some((entry) => entry.title === "Remote sharing enabled"));
  const serialized = JSON.stringify(entries);
  assert.doesNotMatch(serialized, /203\.0\.113\.42|sentinel/);
  assert.ok(shareToken);
  assert.ok(!serialized.includes(shareToken));
  assert.equal(
    (await call("/api/share", "PUT", { enabled: false })).status,
    200,
  );
  assert.equal((await history())[0].title, "Remote sharing disabled");
});

test("history persistence failure does not turn a committed service edit into an API failure", async (t) => {
  await clear();
  const file = path.join(directory, "activity.json");
  const backup = `${file}.test-backup`;
  fs.renameSync(file, backup);
  fs.mkdirSync(file);
  const restore = () => {
    if (!fs.existsSync(backup)) return;
    fs.rmdirSync(file);
    fs.renameSync(backup, file);
  };
  t.after(restore);
  const current = (await call("/api/config")).data;
  current.config.servers[0].services[0].name =
    "Committed despite journal failure";
  const saved = await call("/api/config", "PUT", {
    ...current.config,
    _revision: current.revision,
  });
  assert.equal(saved.status, 200);
  assert.equal(
    saved.data.config.servers[0].services[0].name,
    "Committed despite journal failure",
  );
  const snapshot = (await call("/api/activity")).data;
  assert.equal(snapshot.persistenceError, true);
  assert.equal(snapshot.entries[0].status, "success");
  assert.match(snapshot.entries[0].title, /Service renamed/);
  restore();
  await activity.recordRequest("PUT /api/share", 200);
  assert.equal((await call("/api/activity")).data.persistenceError, false);
});
