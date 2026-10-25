"use strict";

// Untrusted peer protocol validation, separate from remote I/O and cache state.
const { sanitizeConfig } = require("./config");
const { monitoringUrl } = require("./service-urls");
const { sanitizeInfo } = require("./serverinfo");

// Shared by the outgoing snapshot producer and incoming availability validator.
const PEER_OUTAGES = 100;

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
  return Object.fromEntries(
    entries.map(([key, value]) => {
      if (
        !key ||
        key.length > 200 ||
        ["__proto__", "constructor", "prototype"].includes(key)
      )
        throw new Error("Invalid key");
      return [key, map(value)];
    }),
  );
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
      if (
        w.from > v.now ||
        w.from < result.coverageSince ||
        limited !== w.from > requestedFrom ||
        w.observed > v.now - w.from
      )
        throw new Error("Invalid coverage");
      Object.assign(result.windows[key], { requestedFrom, limited });
    }
  }
  for (const key of ["interval", "limit", "lastHeartbeat", "records"])
    if (v[key] !== undefined) result[key] = peerNumber(v[key]);
  result.outages =
    v.outages === undefined
      ? []
      : peerList(v.outages, PEER_OUTAGES, peerOutage);
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
      ...peerMetrics(d, ["used", "total"]),
      label: peerString(d.label),
    })),
    temps:
      v.temps === undefined
        ? []
        : peerList(v.temps, 128, (t) => {
            peerRecord(t);
            if (!["cpu", "disk", "other"].includes(t.kind))
              throw new Error("Invalid sensor");
            return {
              kind: t.kind,
              name: peerString(t.name),
              temp: peerNumber(t.temp, 1000, -273.15),
              detail: peerString(t.detail, 500, true),
            };
          }),
    fans:
      v.fans === undefined
        ? []
        : peerList(v.fans, 128, (f) => ({
            ...peerMetrics(f, ["rpm"]),
            name: peerString(f.name),
          })),
  };
  if (
    result.mem.used > result.mem.total ||
    result.disks.some((d) => d.used > d.total)
  )
    throw new Error("Invalid memory or disk usage");
  if (v.net != null)
    result.net = {
      ...peerMetrics(v.net, ["rx", "tx", "rxRate", "txRate"]),
      ifaces:
        v.net.ifaces === undefined
          ? []
          : peerList(v.net.ifaces, 128, (i) => peerString(i, 40)),
    };
  if (v.availability != null)
    result.availability = peerAvailability(v.availability);
  return result;
}

function peerInfo(data) {
  try {
    peerRecord(data);
    const s = peerRecord(data.system);
    if (!peerString(s.hostname)) throw new Error("Missing hostname");
    for (const key of [
      "hostname",
      "os",
      "osVersion",
      "kernel",
      "arch",
      "cpuModel",
    ])
      if (s[key] !== undefined) peerString(s[key]);
    for (const key of ["cpuCores", "uptime"])
      if (s[key] != null) peerNumber(s[key]);
    if (data.at !== undefined) peerNumber(data.at);
    if (data.network != null) {
      const n = peerRecord(data.network);
      for (const key of ["ipv4", "ipv6"])
        if (n[key] !== undefined)
          peerList(n[key], 32, (a) => {
            peerRecord(a);
            peerString(a.address, 64);
            peerString(a.iface, 40);
          });
      if (n.interfaces !== undefined)
        peerList(n.interfaces, 32, (i) => peerString(i, 40));
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
    try {
      return validate();
    } catch {
      issues.push(key);
      return fallback;
    }
  };
  const servers = section("servers", [], () => {
    const bounded = peerList(data.servers, 100, (s) => {
      peerRecord(s);
      return {
        ...s,
        services: peerList(s.services, 1000, (v) => v),
        groups:
          s.groups === undefined ? [] : peerList(s.groups, 1000, (v) => v),
      };
    });
    return sanitizeConfig({ servers: bounded }).servers;
  });
  const local = servers.some((s) => s.local);
  const stats = section("stats", null, () =>
    data.stats == null && !local ? null : peerStats(data.stats),
  );
  const docker = section(
    "docker",
    { available: false, error: "Invalid Docker snapshot", containers: [] },
    () => {
      const d = peerRecord(data.docker);
      return {
        available: peerBool(d.available),
        error: peerString(d.error, 200, true),
        containers: peerList(d.containers, 2000, (c) => {
          peerRecord(c);
          const name = peerString(c.name);
          if (!name) throw new Error("Missing container name");
          if (
            ![
              "created",
              "restarting",
              "running",
              "removing",
              "paused",
              "exited",
              "dead",
            ].includes(c.state)
          )
            throw new Error("Invalid container state");
          return {
            name,
            image: peerString(c.image, 500),
            state: c.state,
            status: peerString(c.status, 200),
            ports: peerList(c.ports, 128, (p) => {
              if (!Number.isInteger(p)) throw new Error("Invalid port");
              return peerNumber(p, 65535, 1);
            }),
          };
        }),
      };
    },
  );
  const usage = section("usage", { interval: 0, stats: {} }, () => {
    const u = peerRecord(data.usage);
    const result = {
      interval: peerNumber(u.interval, 86400),
      stats: peerMap(u.stats, (v) =>
        peerMetrics(v, ["cpu", "mem", "memLimit", "rx", "tx"]),
      ),
    };
    if (u.ok !== undefined) result.ok = peerBool(u.ok);
    if (u.collectedAt !== undefined)
      result.collectedAt = peerNumber(u.collectedAt);
    if (u.error !== undefined) result.error = peerString(u.error);
    return result;
  });
  const health = section("health", {}, () => {
    const result = peerMap(data.health, (v) => {
      peerRecord(v);
      if (!["up", "down", "error"].includes(v.state))
        throw new Error("Invalid state");
      return v.state === "down"
        ? { state: v.state, error: peerString(v.error, 200, true) }
        : {
            state: v.state,
            code: peerNumber(v.code, 599, 100),
            ms: peerNumber(v.ms),
          };
    });
    if (
      servers.some((s) =>
        s.services.some(
          (svc) =>
            svc.type !== "bookmark" &&
            monitoringUrl(svc) &&
            !Object.hasOwn(result, svc.id),
        ),
      )
    )
      throw new Error("Missing service health");
    return result;
  });
  const availability = section("availability", null, () =>
    data.availability == null ? null : peerAvailability(data.availability),
  );
  const version = section("version", "", () =>
    peerString(data.version, 40, true),
  );
  const title = section("title", "", () => peerString(data.title, 100, true));
  const reportedError = section("refreshError", "", () =>
    peerString(data.refreshError, 200, true),
  );
  if (local && !docker.available) issues.push("docker unavailable");
  if (usage.ok === false) issues.push("usage unavailable");
  if (
    local &&
    usage.interval > 0 &&
    docker.containers.some(
      (c) => c.state === "running" && !Object.hasOwn(usage.stats, c.name),
    )
  )
    issues.push("usage incomplete");
  return {
    version,
    title,
    servers,
    stats,
    docker,
    usage,
    health,
    availability,
    refreshError: issues.length
      ? `Invalid or incomplete peer snapshot: ${issues.join(", ")}`
      : reportedError
        ? "Peer reported an incomplete refresh"
        : "",
  };
}

module.exports = { PEER_OUTAGES, peerError, peerInfo, sanitizePeer };
