"use strict";
const logger = require("./logger");
// Remote dashboards: share this dashboard read-only with a token, and show the
// servers of other dashboards (fetched here, so their tokens never reach a browser).

const fsp = require("fs").promises;
const crypto = require("crypto");
const {
  VERSION,
  REMOTES_FILE,
  SHARE_TOKEN,
  REMOTE_DASHBOARDS,
  REMOTE_REFRESH_INTERVAL,
} = require("./env");
const { readConfig, writeAtomic, sanitizeConfig } = require("./config");
const { badRequest, HttpError } = require("./http");
const { getStats } = require("./system");
const { getContainers, getContainerStats } = require("./docker");
const { getHealth } = require("./health");
const { getAvailability } = require("./availability");
const { sanitizeInfo } = require("./serverinfo");
const { get } = require("./tunables");

const MAX_REMOTES = 20;
const PEER_OUTAGES = 100;
const INTERVALS = [5, 10, 15, 30, 60]; // seconds, the choices in Settings
const DEFAULT_INTERVAL = 10;
const cleanInterval = (n) =>
  INTERVALS.includes(Number(n)) ? Number(n) : DEFAULT_INTERVAL;
// Remote data is cached a little shorter than the browsers' polling interval, so every poll gets a fresh copy.
const cacheMs = (seconds) => Math.max(1000, seconds * 800);
const MAX_BYTES = 5 * 1024 * 1024;
const MIN_TOKEN = 16;

// ---------- Store: { shareToken, refreshInterval, remotes: [{ id, name, url, token }] } ----------

let store = null;
let loading = null;
let queue = Promise.resolve();

async function getStore() {
  if (store) return store;
  loading ||= (async () => {
    try {
      const data = JSON.parse(await fsp.readFile(REMOTES_FILE, "utf8"));
      if (!data || typeof data !== "object" || Array.isArray(data))
        throw new Error("Invalid remotes store");
      store = {
        shareToken: String(data.shareToken || ""),
        refreshInterval: cleanInterval(data.refreshInterval),
        remotes: Array.isArray(data.remotes) ? data.remotes : [],
      };
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
      store = {
        shareToken: "",
        refreshInterval: DEFAULT_INTERVAL,
        remotes: [],
      };
    }
    return store;
  })().finally(() => (loading = null));
  return loading;
}

function updateStore(change) {
  const run = queue.then(async () => {
    const next = change(await getStore());
    await writeAtomic(REMOTES_FILE, JSON.stringify(next, null, 2));
    store = next;
    cache.clear();
    infoCache.clear();
  });
  queue = run.catch(() => {});
  return run;
}

// ---------- Fixed settings from docker-compose (SHARE_TOKEN, REMOTE_DASHBOARDS) ----------

const FIXED_TOKEN = SHARE_TOKEN.length >= MIN_TOKEN ? SHARE_TOKEN : "";
if (SHARE_TOKEN && !FIXED_TOKEN)
  logger.warn(`SHARE_TOKEN ignored: use at least ${MIN_TOKEN} characters`);

/** One per line (or comma separated): "Name | URL | token" or "URL | token". */
const FIXED_REMOTES = REMOTE_DASHBOARDS.split(/[\n,]/)
  .map((line) => line.trim())
  .filter(Boolean)
  .flatMap((line) => {
    const parts = line.split("|").map((p) => p.trim());
    const [name, rawUrl, token] = parts.length === 2 ? ["", ...parts] : parts;
    const url = cleanUrl(rawUrl);
    if (parts.length < 2 || parts.length > 3 || !url || !token) {
      logger.warn(
        'REMOTE_DASHBOARDS: skipped invalid entry (expected "Name | URL | token")',
      );
      return [];
    }
    const id = `env-${crypto.createHash("sha256").update(url).digest("hex").slice(0, 12)}`;
    return [
      {
        id,
        name: name.slice(0, 100) || new URL(url).host,
        url,
        token: token.slice(0, 200),
        fixed: true,
      },
    ];
  })
  .slice(0, MAX_REMOTES);

const shareTokenOf = (s) => FIXED_TOKEN || s.shareToken;

/** Seconds between updates: REMOTE_REFRESH_INTERVAL from docker-compose, else the Settings choice. */
const FIXED_INTERVAL = Math.min(REMOTE_REFRESH_INTERVAL, 3600);
const intervalOf = (s) => FIXED_INTERVAL || s.refreshInterval;

/** docker-compose remotes first; a saved remote with the same URL is left out. */
function allRemotes(s) {
  const urls = new Set(FIXED_REMOTES.map((r) => r.url));
  return [...FIXED_REMOTES, ...s.remotes.filter((r) => !urls.has(r.url))];
}

/** For the Settings dialog (needs edit access): this dashboard's token and the remotes without theirs. */
async function remoteSettings() {
  const s = await getStore();
  return {
    shareToken: shareTokenOf(s),
    shareFixed: Boolean(FIXED_TOKEN),
    refreshInterval: intervalOf(s),
    refreshFixed: Boolean(FIXED_INTERVAL),
    remotes: allRemotes(s).map(({ id, name, url, fixed }) => ({
      id,
      name,
      url,
      fixed: Boolean(fixed),
    })),
  };
}

async function setSharing(enabled) {
  if (FIXED_TOKEN)
    throw badRequest("The share token is set by SHARE_TOKEN in docker-compose");
  const shareToken = enabled
    ? crypto.randomBytes(24).toString("base64url")
    : "";
  await updateStore((current) => ({ ...current, shareToken }));
  return remoteSettings();
}

function cleanUrl(value) {
  try {
    const url = new URL(String(value || "").trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    return `${url.origin}${url.pathname}`.replace(/\/+$/, "");
  } catch {
    return "";
  }
}

async function setRefreshInterval(input) {
  if (FIXED_INTERVAL)
    throw badRequest(
      "The interval is set by REMOTE_REFRESH_INTERVAL in docker-compose",
    );
  if (!INTERVALS.includes(Number(input?.interval)))
    throw badRequest(`Interval must be ${INTERVALS.join(" / ")} seconds`);
  await updateStore((current) => ({
    ...current,
    refreshInterval: Number(input.interval),
  }));
  return remoteSettings();
}

/** Saves the list (docker-compose ones are not saved); a blank token keeps the remote's current one. */
async function saveRemotes(input) {
  if (!Array.isArray(input?.remotes))
    throw badRequest('Expected a "remotes" list');
  const fixedIds = new Set(FIXED_REMOTES.map((r) => r.id));
  const list = input.remotes.filter((r) => !fixedIds.has(r?.id));
  if (list.length > MAX_REMOTES)
    throw badRequest(`At most ${MAX_REMOTES} remote dashboards`);
  await updateStore((current) => {
    const old = new Map(current.remotes.map((r) => [r.id, r]));
    const remotes = list.map((r) => {
      const url = cleanUrl(r?.url);
      if (!url) throw badRequest("Remote URL must be an http(s) address");
      const prev = old.get(r.id);
      const token =
        (typeof r.token === "string" ? r.token.trim().slice(0, 200) : "") ||
        prev?.token ||
        "";
      if (!token) throw badRequest(`${url}: the share token is required`);
      const name =
        (typeof r.name === "string" ? r.name.trim().slice(0, 100) : "") ||
        new URL(url).host;
      return { id: prev?.id || crypto.randomUUID(), name, url, token };
    });
    return { ...current, remotes };
  });
  return remoteSettings();
}

// ---------- Serving this dashboard to others ----------

const digest = (s) => crypto.createHash("sha256").update(String(s)).digest();

/** Validate the supplied share token without depending on HTTP objects. */
async function peerAuthorized(given) {
  const shareToken = shareTokenOf(await getStore());
  if (shareToken && crypto.timingSafeEqual(digest(given), digest(shareToken)))
    return true;
  return false;
}

/** GET /api/peer with "Authorization: Bearer <share token>": this dashboard's servers and live data. */
async function getPeerData({ fresh = false } = {}) {
  // Only its own config.servers - never servers pulled in from remotes, so dashboards can't loop.
  const config = await readConfig();
  const servers = config.servers || [];
  const local = servers.some((s) => s.local);
  const [stats, docker, usage, health, availability] = await Promise.all([
    local ? getStats() : null,
    local ? getContainers() : { available: false, containers: [] },
    local ? getContainerStats({ fresh }) : { interval: 0, stats: {} },
    getHealth({ fresh }),
    local ? getAvailability({ outages: PEER_OUTAGES }) : null,
  ]);
  return {
    version: VERSION,
    title: config.settings?.title || "",
    servers,
    stats,
    docker,
    usage,
    health: health.results || {},
    availability,
    refreshError: local
      ? !docker.available
        ? docker.error || "Docker unavailable"
        : usage.ok === false
          ? usage.error || "Container usage unavailable"
          : ""
      : "",
  };
}

// ---------- Showing other dashboards ----------

const cache = new Map(); // remote id -> { at, data, pending }

async function readBody(res) {
  const chunks = [];
  let size = 0;
  for await (const chunk of res.body) {
    size += chunk.length;
    if (size > MAX_BYTES) throw peerError("Peer response too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size).toString("utf8");
}

/** GET a path of a remote dashboard with our token; returns the parsed JSON. */
async function peerJson(remote, pathname, notFound) {
  const res = await fetch(`${remote.url}${pathname}`, {
    headers: {
      Authorization: `Bearer ${remote.token}`,
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(get("remoteTimeout") * 1000),
    redirect: "manual", // a redirect elsewhere would drop (or leak) the token
  });
  if (!res.ok) await res.body?.cancel().catch(() => {});
  if (res.status >= 300 && res.status < 400)
    throw peerError("Peer redirected - configure its final URL");
  if (res.status === 401) throw peerError("Share token rejected");
  if (res.status === 404) throw peerError(notFound);
  if (!res.ok) throw peerError(`HTTP ${res.status}`);
  return JSON.parse(await readBody(res));
}

// Peer input is untrusted. Copy only known fields, with bounded collections;
// reject a malformed section rather than inventing successful zero metrics.
const record = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
function peerError(message) {
  return Object.assign(new Error(message), { peerSafe: true });
}
function peerString(v, max = 200, optional = false) {
  if (optional && v === undefined) return "";
  if (typeof v !== "string") throw new Error("Invalid string");
  return v.slice(0, max);
}
function peerNumber(v, max = Number.MAX_SAFE_INTEGER, min = 0) {
  if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max)
    throw new Error("Invalid number");
  return v;
}
function peerRecord(v) {
  if (!record(v)) throw new Error("Invalid object");
  return v;
}
function peerList(v, max, map) {
  if (!Array.isArray(v) || v.length > max) throw new Error("Invalid array");
  return v.map(map);
}
function peerBool(v) {
  if (typeof v !== "boolean") throw new Error("Invalid boolean");
  return v;
}
function peerMetrics(v, keys) {
  peerRecord(v);
  return Object.fromEntries(keys.map((key) => [key, peerNumber(v[key])]));
}
function peerMap(v, map) {
  peerRecord(v);
  const entries = Object.entries(v);
  if (entries.length > 2000) throw new Error("Too many entries");
  return Object.fromEntries(entries.map(([key, value]) => {
    if (!key || key.length > 200 || ["__proto__", "constructor", "prototype"].includes(key))
      throw new Error("Invalid key");
    return [key, map(value)];
  }));
}
function peerOutage(v) {
  const result = peerMetrics(v, ["start", "end"]);
  if (result.end < result.start) throw new Error("Invalid range");
  if (v.kind !== undefined && !["host", "app"].includes(v.kind))
    throw new Error("Invalid outage kind");
  return { ...result, ...(v.kind === undefined ? {} : { kind: v.kind }) };
}
function peerAvailability(v) {
  peerRecord(v);
  const result = {
    enabled: peerBool(v.enabled),
    ...peerMetrics(v, ["since", "now", "count"]),
    last: v.last == null ? null : peerOutage(v.last),
    windows: {},
  };
  peerRecord(v.windows);
  if (v.coverageSince !== undefined) {
    result.coverageSince = peerNumber(v.coverageSince, v.now, v.since);
    result.legacyHistory = peerBool(v.legacyHistory);
  }
  for (const key of ["day", "week", "month", "all"]) {
    const w = peerRecord(v.windows[key]);
    result.windows[key] = {
      ...peerMetrics(w, ["from", "observed", "down", "count", "longest"]),
      pct: w.pct === null ? null : peerNumber(w.pct, 100),
    };
    if (w.down > w.observed) throw new Error("Invalid duration");
    if (result.coverageSince !== undefined) {
      const requestedFrom = peerNumber(w.requestedFrom, w.from, v.since);
      const limited = peerBool(w.limited);
      if (w.from > v.now || w.from < result.coverageSince ||
          limited !== (w.from > requestedFrom) || w.observed > v.now - w.from)
        throw new Error("Invalid coverage");
      Object.assign(result.windows[key], { requestedFrom, limited });
    }
  }
  for (const key of ["interval", "limit", "lastHeartbeat", "records"])
    if (v[key] !== undefined) result[key] = peerNumber(v[key]);
  result.outages = v.outages === undefined ? [] : peerList(v.outages, PEER_OUTAGES, peerOutage);
  return result;
}
function peerStats(v) {
  peerRecord(v);
  const result = {
    cpu: peerNumber(v.cpu, 100),
    cores: peerNumber(v.cores, 65536),
    uptime: peerNumber(v.uptime),
    cpuModel: peerString(v.cpuModel, 200, true),
    interval: v.interval === undefined ? 0 : peerNumber(v.interval, 86400),
    load: peerList(v.load, 3, (n) => peerNumber(n)),
    mem: peerMetrics(v.mem, ["used", "total"]),
    disks: peerList(v.disks, 128, (d) => ({
      ...peerMetrics(d, ["used", "total"]), label: peerString(d.label),
    })),
    temps: v.temps === undefined ? [] : peerList(v.temps, 128, (t) => {
      peerRecord(t);
      if (!["cpu", "disk", "other"].includes(t.kind)) throw new Error("Invalid sensor");
      return { kind: t.kind, name: peerString(t.name), temp: peerNumber(t.temp, 1000, -273.15),
        detail: peerString(t.detail, 500, true) };
    }),
    fans: v.fans === undefined ? [] : peerList(v.fans, 128, (f) => ({
      ...peerMetrics(f, ["rpm"]), name: peerString(f.name),
    })),
  };
  if (result.mem.used > result.mem.total || result.disks.some((d) => d.used > d.total))
    throw new Error("Invalid memory or disk usage");
  if (v.net != null) result.net = {
    ...peerMetrics(v.net, ["rx", "tx", "rxRate", "txRate"]),
    ifaces: v.net.ifaces === undefined ? [] : peerList(v.net.ifaces, 128, (i) => peerString(i, 40)),
  };
  if (v.availability != null) result.availability = peerAvailability(v.availability);
  return result;
}

function peerInfo(data) {
  try {
    peerRecord(data);
    const s = peerRecord(data.system);
    if (!peerString(s.hostname)) throw new Error("Missing hostname");
    for (const key of ["hostname", "os", "osVersion", "kernel", "arch", "cpuModel"])
      if (s[key] !== undefined) peerString(s[key]);
    for (const key of ["cpuCores", "uptime"])
      if (s[key] != null) peerNumber(s[key]);
    if (data.at !== undefined) peerNumber(data.at);
    if (data.network != null) {
      const n = peerRecord(data.network);
      for (const key of ["ipv4", "ipv6"])
        if (n[key] !== undefined) peerList(n[key], 32, (a) => {
          peerRecord(a);
          peerString(a.address, 64);
          peerString(a.iface, 40);
        });
      if (n.interfaces !== undefined) peerList(n.interfaces, 32, (i) => peerString(i, 40));
      if (n.publicIp != null) {
        const p = peerRecord(n.publicIp);
        if (p.enabled !== undefined) peerBool(p.enabled);
        for (const key of ["mode", "value", "source", "error"])
          if (p[key] !== undefined) peerString(p[key]);
      }
    }
    if (data.docker != null) {
      const d = peerRecord(data.docker);
      peerBool(d.available);
      for (const key of ["error", "version", "apiVersion", "storageDriver"])
        if (d[key] !== undefined) peerString(d[key]);
      for (const key of ["running", "stopped", "total", "images"])
        if (d[key] != null) peerNumber(d[key]);
    }
    return sanitizeInfo(data);
  } catch {
    throw peerError("Invalid peer server info");
  }
}

function sanitizePeer(data) {
  if (!record(data)) throw peerError("Invalid peer snapshot");
  const issues = [];
  const section = (key, fallback, validate) => {
    try { return validate(); }
    catch { issues.push(key); return fallback; }
  };
  const servers = section("servers", [], () => {
    const bounded = peerList(data.servers, 100, (s) => {
      peerRecord(s);
      return { ...s,
        services: peerList(s.services, 1000, (v) => v),
        groups: s.groups === undefined ? [] : peerList(s.groups, 1000, (v) => v),
      };
    });
    return sanitizeConfig({ servers: bounded }).servers;
  });
  const local = servers.some((s) => s.local);
  const stats = section("stats", null, () =>
    data.stats == null && !local ? null : peerStats(data.stats));
  const docker = section("docker", { available: false, error: "Invalid Docker snapshot", containers: [] }, () => {
    const d = peerRecord(data.docker);
    return {
      available: peerBool(d.available), error: peerString(d.error, 200, true),
      containers: peerList(d.containers, 2000, (c) => {
        peerRecord(c);
        const name = peerString(c.name);
        if (!name) throw new Error("Missing container name");
        if (!["created", "restarting", "running", "removing", "paused", "exited", "dead"].includes(c.state))
          throw new Error("Invalid container state");
        return { name, image: peerString(c.image, 500), state: c.state,
          status: peerString(c.status, 200),
          ports: peerList(c.ports, 128, (p) => {
            if (!Number.isInteger(p)) throw new Error("Invalid port");
            return peerNumber(p, 65535, 1);
          }) };
      }),
    };
  });
  const usage = section("usage", { interval: 0, stats: {} }, () => {
    const u = peerRecord(data.usage);
    const result = { interval: peerNumber(u.interval, 86400),
      stats: peerMap(u.stats, (v) => peerMetrics(v, ["cpu", "mem", "memLimit", "rx", "tx"])) };
    if (u.ok !== undefined) result.ok = peerBool(u.ok);
    if (u.collectedAt !== undefined) result.collectedAt = peerNumber(u.collectedAt);
    if (u.error !== undefined) result.error = peerString(u.error);
    return result;
  });
  const health = section("health", {}, () => {
    const result = peerMap(data.health, (v) => {
      peerRecord(v);
      if (!["up", "down", "error"].includes(v.state)) throw new Error("Invalid state");
      return v.state === "down"
        ? { state: v.state, error: peerString(v.error, 200, true) }
        : { state: v.state, code: peerNumber(v.code, 599, 100), ms: peerNumber(v.ms) };
    });
    if (servers.some((s) => s.services.some((svc) => svc.url && !Object.hasOwn(result, svc.id))))
      throw new Error("Missing service health");
    return result;
  });
  const availability = section("availability", null, () =>
    data.availability == null ? null : peerAvailability(data.availability));
  const version = section("version", "", () => peerString(data.version, 40, true));
  const title = section("title", "", () => peerString(data.title, 100, true));
  const reportedError = section("refreshError", "", () => peerString(data.refreshError, 200, true));
  if (local && !docker.available) issues.push("docker unavailable");
  if (usage.ok === false) issues.push("usage unavailable");
  if (local && usage.interval > 0 && docker.containers.some((c) =>
    c.state === "running" && !Object.hasOwn(usage.stats, c.name)))
    issues.push("usage incomplete");
  return { version, title, servers, stats, docker, usage, health, availability,
    refreshError: issues.length ? `Invalid or incomplete peer snapshot: ${issues.join(", ")}`
      : reportedError ? "Peer reported an incomplete refresh" : "" };
}

async function fetchPeer(remote, fresh) {
  const data = await peerJson(
    remote,
    `/api/peer${fresh ? "?fresh=1" : ""}`,
    "Not a dashboard, or an older version without sharing",
  );
  return sanitizePeer(data);
}

const describe = (err) =>
  err.name === "TimeoutError"
    ? "Timed out"
    : err.peerSafe ? err.message : "Could not read peer response";

/** Cached briefly so several open tabs share one request; a failure keeps the last known servers.
 *  fresh = skip the cache here and on the remote (Refresh button). */
function remoteData(remote, fresh, ttl) {
  let entry = cache.get(remote.id);
  if (!entry)
    cache.set(remote.id, (entry = { at: 0, data: null, pending: null }));
  if (entry.pending) {
    if (fresh && !entry.pendingFresh)
      return entry.pending.then(() => remoteData(remote, true, ttl));
    return entry.pending;
  }
  if (!fresh && Date.now() - entry.at < ttl) return entry.data;
  entry.pendingFresh = fresh;
  // lastOk advances only for a complete snapshot; partial data stays visible.
  entry.pending ||= fetchPeer(remote, fresh)
    .then(
      (data) => {
        if (entry.data?.ok === false)
          logger.info("[Remotes] Remote dashboard recovered", { id: remote.id });
        return {
          ok: true,
          error: "",
          lastOk: data.refreshError ? entry.data?.lastOk || 0 : Date.now(),
          ...data,
        };
      },
      (err) => {
        if (entry.data?.ok !== false)
          logger.warn("[Remotes] Remote dashboard unavailable", { id: remote.id, error: describe(err) });
        return {
          ok: false,
          error: describe(err),
          lastOk: entry.data?.lastOk || 0,
          title: entry.data?.title || "",
          servers: entry.data?.servers || [],
        };
      },
    )
    .then((data) => {
      if (cache.get(remote.id) === entry)
        Object.assign(entry, { at: Date.now(), data, pending: null });
      return data;
    });
  return entry.pending;
}

/** GET /api/remotes: every remote dashboard with its servers and live data (no tokens), plus the polling interval.
 *  age = ms since the data was received, so browsers need not trust this server's clock.
 *  fresh = id of a remote to fetch fresh; only = id of the one remote wanted (switching to it must not wait for the others). */
async function getRemotes({ fresh = "", only = "" } = {}) {
  const s = await getStore();
  const interval = intervalOf(s);
  const remotes = allRemotes(s).filter((r) => !only || r.id === only);
  return {
    interval,
    remotes: await Promise.all(
      remotes.map(async (r) => {
        const data = await remoteData(r, r.id === fresh, cacheMs(interval));
        return {
          id: r.id,
          name: r.name,
          url: r.url,
          ...data,
          age: data.lastOk ? Math.max(0, Date.now() - data.lastOk) : null,
        };
      }),
    ),
  };
}

/** Servers last received from remotes (their icons may be cached too). */
const remoteServers = () =>
  [...cache.values()].flatMap((e) => e.data?.servers || []);

const infoCache = new Map(); // remote id -> { at, data, pending }
const INFO_CACHE_MS = 30_000;

/** GET /api/remotes/info?id=: the Server info of a remote dashboard's machine (cached briefly). */
async function getRemoteInfo(id) {
  const remote = allRemotes(await getStore()).find((r) => r.id === id);
  if (!remote) throw new HttpError(404, "Unknown remote dashboard");
  let entry = infoCache.get(id);
  if (!entry) infoCache.set(id, (entry = { at: 0, data: null, pending: null }));
  if (entry.data && Date.now() - entry.at < INFO_CACHE_MS) return entry.data;
  entry.pending ||= peerJson(
    remote,
    "/api/peer/info",
    "That dashboard is too old to share server info - update it",
  )
    .then(
      (data) =>
        Object.assign(entry, { at: Date.now(), data: peerInfo(data) }).data,
    )
    .finally(() => (entry.pending = null));
  try {
    return await entry.pending;
  } catch (err) {
    throw new HttpError(502, describe(err));
  }
}

module.exports = {
  peerAuthorized,
  getPeerData,
  getRemotes,
  getRemoteInfo,
  remoteSettings,
  setSharing,
  setRefreshInterval,
  saveRemotes,
  remoteServers,
};
