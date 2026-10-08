'use strict';
// Timing and limit values that used to be hard-coded. Each has a default, can be changed in Settings
// (saved in data/tunables.json) or fixed with an environment variable in docker-compose (which wins).

const fs = require('fs');
const { TUNABLES_FILE } = require('./env');
const { writeAtomic } = require('./config');
const { badRequest } = require('./http');

// client: true = the browser needs the value too (sent with /api/config). All values are whole numbers.
const DEFS = [
  { key: 'dockerRefresh', env: 'DOCKER_REFRESH_INTERVAL', group: 'Refresh timing', label: 'Docker status refresh', unit: 'seconds', def: 30, min: 5, max: 3600, client: true },
  { key: 'healthRefresh', env: 'HEALTH_REFRESH_INTERVAL', group: 'Refresh timing', label: 'Service status refresh', unit: 'seconds', def: 60, min: 10, max: 3600, client: true },
  { key: 'localStale', env: 'LOCAL_STALE_AFTER', group: 'Refresh timing', label: 'Mark this machine stale after', unit: 'seconds', def: 90, min: 15, max: 3600, client: true },
  { key: 'refreshGap', env: 'REFRESH_MIN_GAP', group: 'Refresh timing', label: 'Minimum gap between forced refreshes', unit: 'seconds', def: 5, min: 1, max: 60 },
  { key: 'healthTimeout', env: 'HEALTH_TIMEOUT', group: 'Health checks', label: 'Timeout per check', unit: 'seconds', def: 6, min: 1, max: 60 },
  { key: 'healthCache', env: 'HEALTH_CACHE', group: 'Health checks', label: 'Keep results for', unit: 'seconds', def: 45, min: 5, max: 600 },
  { key: 'healthParallel', env: 'HEALTH_PARALLEL', group: 'Health checks', label: 'Checks at the same time', unit: '', def: 8, min: 1, max: 32 },
  { key: 'remoteTimeout', env: 'REMOTE_TIMEOUT', group: 'Remote dashboards', label: 'Request timeout', unit: 'seconds', def: 8, min: 2, max: 60 },
  { key: 'loadTimeout', env: 'LOAD_TIMEOUT', group: 'Remote dashboards', label: 'Loading screen gives up after', unit: 'seconds', def: 15, min: 5, max: 120, client: true },
  { key: 'dockerParallel', env: 'DOCKER_PARALLEL', group: 'Docker', label: 'Container stats requests at the same time', unit: '', def: 6, min: 1, max: 16 },
];
const BY_KEY = new Map(DEFS.map((d) => [d.key, d]));

/** A whole number inside the definition's range, or null. */
function valid(def, value) {
  if (value === '' || value == null) return null;
  const n = Number(value);
  return Number.isInteger(n) && n >= def.min && n <= def.max ? n : null;
}

const fixedValue = (def) => valid(def, process.env[def.env]);

let saved = {}; // key -> number, from data/tunables.json
try {
  const file = JSON.parse(fs.readFileSync(TUNABLES_FILE, 'utf8'));
  for (const def of DEFS) {
    const n = valid(def, file?.[def.key]);
    if (n != null) saved[def.key] = n;
  }
} catch {
  /* no file yet */
}

/** The value in use: docker-compose, else Settings, else the default. */
function get(key) {
  const def = BY_KEY.get(key);
  return fixedValue(def) ?? saved[key] ?? def.def;
}

/** Everything the Settings screen needs. */
function list() {
  return DEFS.map(({ key, env, group, label, unit, def, min, max }) => ({
    key, env, group, label, unit, def, min, max,
    value: get(key),
    fixed: fixedValue(BY_KEY.get(key)) != null,
  }));
}

/** The values the browser uses (seconds). */
function clientValues() {
  return Object.fromEntries(DEFS.filter((d) => d.client).map((d) => [d.key, get(d.key)]));
}

/** values: { key: number | null }; null (or empty) goes back to the default. Values fixed in docker-compose are refused. */
async function save(values) {
  if (!values || typeof values !== 'object') throw badRequest('Nothing to save');
  const next = { ...saved };
  for (const [key, value] of Object.entries(values)) {
    const def = BY_KEY.get(key);
    if (!def) throw badRequest(`Unknown setting: ${key}`);
    if (fixedValue(def) != null) throw badRequest(`${def.label} is set by ${def.env} in docker-compose`);
    if (value === null || value === '') {
      delete next[key];
      continue;
    }
    const n = valid(def, value);
    if (n == null) throw badRequest(`${def.label} must be a whole number from ${def.min} to ${def.max}`);
    next[key] = n;
  }
  await writeAtomic(TUNABLES_FILE, JSON.stringify(next));
  saved = next;
  return list();
}

module.exports = { get, list, clientValues, save };
