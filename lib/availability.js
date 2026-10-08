'use strict';
// Approximate outage history for this machine, without any external monitor.
// A heartbeat timestamp is saved every few minutes; when the dashboard starts (or wakes up after a
// suspend) and the last heartbeat is older than the threshold, the gap is recorded as an outage.
// A clean stop (docker stop) saves a final heartbeat, so a quick restart leaves no gap.
// The host's own uptime tells the two kinds of gap apart when the dashboard starts:
//   host rebooted since the last heartbeat -> outage 'host' (last heartbeat until the host booted)
//   host kept running                      -> 'app' gap: the dashboard was down, the host was up (not counted)

const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const { AVAILABILITY_FILE, DATA_DIR } = require('./env');
const { writeAtomic } = require('./config');
const { badRequest } = require('./http');

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const MAX_OUTAGES = 500;
const MAX_PAUSES = 100;
const INTERVALS = [1, 5, 10]; // heartbeat, minutes
const THRESHOLDS = [5, 10, 15, 30]; // gap that counts as an outage, minutes
const DEFAULT_SETTINGS = { enabled: true, interval: 5, threshold: 10 };
const WINDOWS = { day: DAY, week: 7 * DAY, month: 30 * DAY, all: Infinity };

// { since, lastHeartbeat, settings, outages: [{ start, end, kind: 'host'|'app' }], paused: [{ start, end|null }] }
// since = when monitoring began; paused = periods with tracking switched off (not counted as observed).
let data = null;
let ready = null;
let timer = null;
let saving = Promise.resolve();

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

function cleanSettings(input, base = DEFAULT_SETTINGS) {
  const s = { ...base };
  if (input?.enabled !== undefined) s.enabled = Boolean(input.enabled);
  if (input?.interval !== undefined) {
    if (!INTERVALS.includes(Number(input.interval))) throw badRequest(`Heartbeat interval must be ${INTERVALS.join(' / ')} minutes`);
    s.interval = Number(input.interval);
  }
  if (input?.threshold !== undefined) {
    if (!THRESHOLDS.includes(Number(input.threshold))) throw badRequest(`Outage threshold must be ${THRESHOLDS.join(' / ')} minutes`);
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
      .map((r) => ({ start: num(r?.start), end: r?.end == null && open ? null : num(r?.end), ...(r?.kind === 'app' && { kind: 'app' }) }))
      .filter((r) => r.start > 0 && (r.end === null || r.end > r.start))
      .sort((a, b) => a.start - b.start);
  return {
    since: num(file.since) || now,
    lastHeartbeat: num(file.lastHeartbeat),
    settings,
    outages: range(file.outages).slice(-MAX_OUTAGES),
    paused: range(file.paused, true).slice(-MAX_PAUSES),
  };
}

/** Gaps longer than this count as outages; always a little above the heartbeat interval. */
const limitMs = () => Math.max(data.settings.threshold, data.settings.interval + 1) * MIN;

function save() {
  saving = saving.then(() => writeAtomic(AVAILABILITY_FILE, JSON.stringify(data))).catch((err) => console.error('Availability: could not save:', err.message));
  return saving;
}

/** A host outage (the default kind). Gaps where only the dashboard was down are kept as kind 'app'. */
const isHostOutage = (o) => o.kind !== 'app';

function addOutage(start, end, kind = 'host') {
  data.outages.push(kind === 'app' ? { start, end, kind } : { start, end });
  if (data.outages.length > MAX_OUTAGES) data.outages.splice(0, data.outages.length - MAX_OUTAGES);
}

/**
 * Compares the last heartbeat with now, then stamps a new heartbeat.
 * At startup the host's boot time decides what the gap was; a gap while the dashboard kept running
 * (heartbeat timer fired late) means the whole machine was suspended or paused.
 */
function beat(now = Date.now(), startup = false) {
  const last = data.lastHeartbeat;
  if (last && now > last) {
    const limit = limitMs();
    const boot = now - os.uptime() * 1000;
    if (!startup) {
      if (now - last > limit) addOutage(last, now);
    } else if (boot > last) {
      const end = Math.min(boot, now); // back up when the host booted, not when the dashboard came up
      if (end - last > limit) addOutage(last, end);
    } else if (now - last > limit) {
      addOutage(last, now, 'app');
    }
  }
  data.lastHeartbeat = now;
  return save();
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
      file = JSON.parse(await fsp.readFile(AVAILABILITY_FILE, 'utf8'));
    } catch {
      /* first start, or an unreadable file - start a fresh history */
    }
    data = normalize(file || {}, now);
    if (data.settings.enabled) await beat(now, true);
    else await save();
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
  } catch {
    /* shutting down anyway */
  }
}

// ---------- Numbers ----------

const overlap = (a1, a2, b1, b2) => Math.max(0, Math.min(a2, b2) - Math.max(a1, b1));

/** Availability between from and to; time with tracking switched off does not count as observed. */
function windowStats(from, to) {
  const paused = data.paused.reduce((sum, p) => sum + overlap(p.start, p.end ?? to, from, to), 0);
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
    longest = Math.max(longest, o.end - o.start);
  }
  down = Math.min(down, observed);
  let pct = null;
  if (observed > 0) pct = down > 0 ? Math.min(99.99, Math.floor((1 - down / observed) * 10_000) / 100) : 100;
  return { from, observed, down, count, longest, pct };
}

/** Settings, availability for 24 h / 7 d / 30 d / everything observed so far, and the latest `outages` records (newest first). */
async function getAvailability({ outages = 0 } = {}) {
  await init();
  const now = Date.now();
  const windows = {};
  for (const [name, span] of Object.entries(WINDOWS)) windows[name] = windowStats(Math.max(now - span, data.since), now);
  const hostOutages = data.outages.filter(isHostOutage);
  const result = {
    ...data.settings,
    limit: limitMs() / MIN,
    since: data.since,
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
  const next = cleanSettings(input, data.settings);
  const now = Date.now();
  const was = data.settings.enabled;
  if (was) beat(now); // close the current gap with the old limit before it changes
  if (was && !next.enabled) {
    data.paused.push({ start: now, end: null });
    data.lastHeartbeat = 0;
  } else if (!was && next.enabled) {
    for (const p of data.paused) if (p.end === null) p.end = now;
    data.lastHeartbeat = now;
  }
  if (data.paused.length > MAX_PAUSES) data.paused.splice(0, data.paused.length - MAX_PAUSES);
  data.settings = next;
  schedule();
  await save();
  return getAvailability({ outages: MAX_OUTAGES });
}

/** Removes the outage records; the monitoring start stays, so percentages are 100% again. */
async function clearHistory() {
  await init();
  data.outages = [];
  await save();
  return getAvailability({ outages: MAX_OUTAGES });
}

module.exports = { init, flushSync, getAvailability, saveSettings, clearHistory, MAX_OUTAGES };
