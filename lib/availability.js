"use strict";
const logger = require("./logger");
// Approximate outage history for this machine, without any external monitor.
// A heartbeat timestamp is saved every few minutes; when the dashboard starts (or wakes up after a
// suspend) and the last heartbeat is older than the threshold, the gap is recorded as an outage.
// A clean stop (docker stop) saves a final heartbeat, so a quick restart leaves no gap.
// The host's own uptime tells the two kinds of gap apart when the dashboard starts:
//   host rebooted since the last heartbeat -> outage 'host' (last heartbeat until the host booted)
//   host kept running                      -> 'app' gap: the dashboard was down, the host was up (not counted)

const fs = require("fs");
const fsp = fs.promises;
const os = require("os");
const { AVAILABILITY_FILE, DATA_DIR } = require("./env");
const { writeAtomic } = require("./config");
const { badRequest } = require("./http");

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const MAX_OUTAGES = 500;
const MAX_PAUSES = 100;
const INTERVALS = [1, 5, 10]; // heartbeat, minutes
const THRESHOLDS = [5, 10, 15, 30]; // gap that counts as an outage, minutes
const DEFAULT_SETTINGS = { enabled: true, interval: 5, threshold: 10 };
const WINDOWS = { day: DAY, week: 7 * DAY, month: 30 * DAY, all: Infinity };

// { since, lastHeartbeat, settings, outages: [{ start, end, kind: 'host'|'app' }], paused: [{ start, end|null }] }
// since = original monitoring start; coverageSince = supported calculation start.
// paused = periods with tracking switched off (not counted as observed).
let data = null;
let ready = null;
let timer = null;
let saving = Promise.resolve();

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

function cleanSettings(input, base = DEFAULT_SETTINGS) {
  const s = { ...base };
  if (input?.enabled !== undefined) s.enabled = Boolean(input.enabled);
  if (input?.interval !== undefined) {
    if (!INTERVALS.includes(Number(input.interval)))
      throw badRequest(
        `Heartbeat interval must be ${INTERVALS.join(" / ")} minutes`,
      );
    s.interval = Number(input.interval);
  }
  if (input?.threshold !== undefined) {
    if (!THRESHOLDS.includes(Number(input.threshold)))
      throw badRequest(
        `Outage threshold must be ${THRESHOLDS.join(" / ")} minutes`,
      );
    s.threshold = Number(input.threshold);
  }
  return s;
}

function normalize(file, now) {
  let settings = DEFAULT_SETTINGS;
  try {
    settings = cleanSettings(file.settings);
  } catch {
    /* unusable values - use the defaults */
  }
  const range = (list, open) =>
    (Array.isArray(list) ? list : [])
      .map((r) => ({
        start: num(r?.start),
        end: r?.end == null && open ? null : num(r?.end),
        ...(r?.kind === "app" && { kind: "app" }),
      }))
      .filter((r) => r.start > 0 && (r.end === null || r.end > r.start))
      .sort((a, b) => a.start - b.start);
  const since = Math.min(num(file.since) || now, now);
  // Legacy stores cannot reveal previous pruning. Keep their records, but do
  // not invent historical precision. New stores begin with complete coverage.
  const coverageSince = file.coverageSince === undefined
    ? (file.since ? now : since)
    : Math.max(since, Math.min(num(file.coverageSince) || now, now));
  const result = {
    since,
    coverageSince,
    legacyHistory: file.coverageSince === undefined ? Boolean(file.since) : Boolean(file.legacyHistory),
    lastHeartbeat: num(file.lastHeartbeat),
    settings,
    outages: range(file.outages),
    paused: range(file.paused, true),
  };
  retain(result, "outages", MAX_OUTAGES, now);
  retain(result, "paused", MAX_PAUSES, now);
  if (!settings.enabled && !result.paused.some((p) => p.end === null)) {
    result.paused.push({ start: now, end: null });
    retain(result, "paused", MAX_PAUSES, now);
  }
  return result;
}

// Discarded intervals must never become apparent uptime/observed time.
function retain(data, key, max, now) {
  const removed = data[key].splice(0, Math.max(0, data[key].length - max));
  for (const r of removed)
    data.coverageSince = Math.max(data.coverageSince, r.end ?? now);
}

/** Gaps longer than this count as outages; always a little above the heartbeat interval. */
const limitMs = () =>
  Math.max(data.settings.threshold, data.settings.interval + 1) * MIN;

// Serialize heartbeats and user changes against the latest committed snapshot.
function update(change) {
  const run = saving.then(async () => {
    const next = structuredClone(data);
    change(next);
    await writeAtomic(AVAILABILITY_FILE, JSON.stringify(next));
    data = next;
  });
  saving = run.catch(() => {});
  return run;
}

/** A host outage (the default kind). Gaps where only the dashboard was down are kept as kind 'app'. */
const isHostOutage = (o) => o.kind !== "app";

function addOutage(data, start, end, kind = "host") {
  data.outages.push(kind === "app" ? { start, end, kind } : { start, end });
  retain(data, "outages", MAX_OUTAGES, end);
}

/**
 * Compares the last heartbeat with now, then stamps a new heartbeat.
 * At startup the host's boot time decides what the gap was; a gap while the dashboard kept running
 * (heartbeat timer fired late) means the whole machine was suspended or paused.
 */
function stamp(data, now, startup = false) {
  const last = data.lastHeartbeat;
  if (last && now > last) {
    const limit = Math.max(data.settings.threshold, data.settings.interval + 1) * MIN;
    const boot = now - os.uptime() * 1000;
    if (!startup) {
      if (now - last > limit) addOutage(data, last, now);
    } else if (boot > last) {
      const end = Math.min(boot, now); // End at host boot, not app startup.
      if (end - last > limit) addOutage(data, last, end);
    } else if (now - last > limit) {
      addOutage(data, last, now, "app");
    }
  }
  data.lastHeartbeat = now;
}

// Diagnostic heartbeats are deliberately best effort, unlike user changes.
function beat(now = Date.now(), startup = false) {
  return update((next) => {
    if (next.settings.enabled) stamp(next, now, startup);
  }).catch((err) => logger.error("[Availability] Could not save history", err));
}

function schedule() {
  clearInterval(timer);
  timer = null;
  if (!data.settings.enabled) return;
  timer = setInterval(() => beat(), data.settings.interval * MIN);
  timer.unref?.();
}

/** Load the history and compare the last heartbeat with now. Call once when the server starts. */
function init() {
  ready ||= (async () => {
    const now = Date.now();
    let file = null;
    try {
      file = JSON.parse(await fsp.readFile(AVAILABILITY_FILE, "utf8"));
      if (!file || typeof file !== "object" || Array.isArray(file))
        throw new Error("Invalid availability store");
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }
    data = normalize(file || {}, now);
    await beat(now, true);
    schedule();
  })();
  return ready;
}

/** On a clean stop (docker stop, Ctrl+C) the last heartbeat is "now", so quick restarts leave no gap. */
function flushSync() {
  if (!data) return;
  try {
    if (data.settings.enabled) data.lastHeartbeat = Date.now();
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = `${AVAILABILITY_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
    fs.renameSync(tmp, AVAILABILITY_FILE);
  } catch (err) {
    logger.error("[Availability] Could not save final heartbeat", err);
  }
}

// ---------- Numbers ----------

const overlap = (a1, a2, b1, b2) =>
  Math.max(0, Math.min(a2, b2) - Math.max(a1, b1));

/** Availability between from and to; time with tracking switched off does not count as observed. */
function windowStats(from, to) {
  const paused = data.paused.reduce(
    (sum, p) => sum + overlap(p.start, p.end ?? to, from, to),
    0,
  );
  const observed = Math.max(0, to - from - paused);
  let down = 0;
  let count = 0;
  let longest = 0;
  for (const o of data.outages) {
    if (!isHostOutage(o)) continue;
    const ms = overlap(o.start, o.end, from, to);
    if (!ms) continue;
    down += ms;
    count++;
    longest = Math.max(longest, ms);
  }
  down = Math.min(down, observed);
  let pct = null;
  if (observed > 0)
    pct =
      down > 0
        ? Math.min(99.99, Math.floor((1 - down / observed) * 10_000) / 100)
        : 100;
  return { from, observed, down, count, longest, pct };
}

/** Rolling/retained availability, clipped to supported coverage, and latest records (newest first). */
async function getAvailability({ outages = 0 } = {}) {
  await init();
  const now = Date.now();
  const windows = {};
  for (const [name, span] of Object.entries(WINDOWS)) {
    const requestedFrom = Math.max(now - span, data.since);
    const from = Math.min(now, Math.max(requestedFrom, data.coverageSince));
    windows[name] = { ...windowStats(from, now), requestedFrom, limited: from > requestedFrom };
  }
  const hostOutages = data.outages.filter(isHostOutage);
  const result = {
    ...data.settings,
    limit: limitMs() / MIN,
    since: data.since,
    coverageSince: data.coverageSince,
    legacyHistory: data.legacyHistory,
    lastHeartbeat: data.lastHeartbeat,
    now,
    count: hostOutages.length, // host outages only
    records: data.outages.length, // including dashboard-only gaps
    last: hostOutages.at(-1) || null,
    windows,
  };
  if (outages) result.outages = data.outages.slice(-outages).reverse();
  return result;
}

// ---------- Changes ----------

async function saveSettings(input) {
  await init();
  await update((data) => {
    const next = cleanSettings(input, data.settings);
    const now = Date.now();
    const was = data.settings.enabled;
    if (was) stamp(data, now); // Close the gap using the old limit.
    if (was && !next.enabled) {
      data.paused.push({ start: now, end: null });
      data.lastHeartbeat = 0;
    } else if (!was && next.enabled) {
      for (const p of data.paused) if (p.end === null) p.end = now;
      data.lastHeartbeat = now;
    }
    retain(data, "paused", MAX_PAUSES, now);
    data.settings = next;
  });
  schedule();
  return getAvailability({ outages: MAX_OUTAGES });
}

/** Clear records and start a new supported calculation period, not fictional past uptime. */
async function clearHistory() {
  await init();
  await update((data) => {
    const now = Date.now();
    data.outages = [];
    data.coverageSince = now;
    data.paused = data.settings.enabled ? [] : [{ start: now, end: null }];
    data.lastHeartbeat = data.settings.enabled ? now : 0;
  });
  return getAvailability({ outages: MAX_OUTAGES });
}

module.exports = {
  init,
  flushSync,
  getAvailability,
  saveSettings,
  clearHistory,
  MAX_OUTAGES,
};
