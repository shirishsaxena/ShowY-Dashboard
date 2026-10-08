'use strict';
// Remote dashboards: share this dashboard read-only with a token, and show the
// servers of other dashboards (fetched here, so their tokens never reach a browser).

const fsp = require('fs').promises;
const crypto = require('crypto');
const { VERSION, REMOTES_FILE, SHARE_TOKEN, REMOTE_DASHBOARDS, REMOTE_REFRESH_INTERVAL } = require('./env');
const { readConfig, writeAtomic, sanitizeConfig } = require('./config');
const { badRequest, send, HttpError } = require('./http');
const { getStats } = require('./system');
const { getContainers, getContainerStats } = require('./docker');
const { getHealth } = require('./health');
const { getAvailability } = require('./availability');
const { getServerInfo, sanitizeInfo } = require('./serverinfo');
const { get } = require('./tunables');

const MAX_REMOTES = 20;
const PEER_OUTAGES = 100;
const INTERVALS = [5, 10, 15, 30, 60]; // seconds, the choices in Settings
const DEFAULT_INTERVAL = 10;
const cleanInterval = (n) => (INTERVALS.includes(Number(n)) ? Number(n) : DEFAULT_INTERVAL);
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
      const data = JSON.parse(await fsp.readFile(REMOTES_FILE, 'utf8'));
      store = { shareToken: String(data.shareToken || ''), refreshInterval: cleanInterval(data.refreshInterval), remotes: Array.isArray(data.remotes) ? data.remotes : [] };
    } catch {
      store = { shareToken: '', refreshInterval: DEFAULT_INTERVAL, remotes: [] };
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

const FIXED_TOKEN = SHARE_TOKEN.length >= MIN_TOKEN ? SHARE_TOKEN : '';
if (SHARE_TOKEN && !FIXED_TOKEN) console.warn(`SHARE_TOKEN ignored: use at least ${MIN_TOKEN} characters`);

/** One per line (or comma separated): "Name | URL | token" or "URL | token". */
const FIXED_REMOTES = REMOTE_DASHBOARDS.split(/[\n,]/)
  .map((line) => line.trim())
  .filter(Boolean)
  .flatMap((line) => {
    const parts = line.split('|').map((p) => p.trim());
    const [name, rawUrl, token] = parts.length === 2 ? ['', ...parts] : parts;
    const url = cleanUrl(rawUrl);
    if (parts.length < 2 || parts.length > 3 || !url || !token) {
      console.warn(`REMOTE_DASHBOARDS: skipped "${line.split('|')[0].trim()}..." (expected "Name | URL | token")`);
      return [];
    }
    const id = `env-${crypto.createHash('sha256').update(url).digest('hex').slice(0, 12)}`;
    return [{ id, name: name.slice(0, 100) || new URL(url).host, url, token: token.slice(0, 200), fixed: true }];
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
    remotes: allRemotes(s).map(({ id, name, url, fixed }) => ({ id, name, url, fixed: Boolean(fixed) })),
  };
}

async function setSharing(enabled) {
  if (FIXED_TOKEN) throw badRequest('The share token is set by SHARE_TOKEN in docker-compose');
  const shareToken = enabled ? crypto.randomBytes(24).toString('base64url') : '';
  await updateStore((current) => ({ ...current, shareToken }));
  return remoteSettings();
}

function cleanUrl(value) {
  try {
    const url = new URL(String(value || '').trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    return `${url.origin}${url.pathname}`.replace(/\/+$/, '');
  } catch {
    return '';
  }
}

async function setRefreshInterval(input) {
  if (FIXED_INTERVAL) throw badRequest('The interval is set by REMOTE_REFRESH_INTERVAL in docker-compose');
  if (!INTERVALS.includes(Number(input?.interval))) throw badRequest(`Interval must be ${INTERVALS.join(' / ')} seconds`);
  await updateStore((current) => ({ ...current, refreshInterval: Number(input.interval) }));
  return remoteSettings();
}

/** Saves the list (docker-compose ones are not saved); a blank token keeps the remote's current one. */
async function saveRemotes(input) {
  if (!Array.isArray(input?.remotes)) throw badRequest('Expected a "remotes" list');
  const fixedIds = new Set(FIXED_REMOTES.map((r) => r.id));
  const list = input.remotes.filter((r) => !fixedIds.has(r?.id));
  if (list.length > MAX_REMOTES) throw badRequest(`At most ${MAX_REMOTES} remote dashboards`);
  await updateStore((current) => {
    const old = new Map(current.remotes.map((r) => [r.id, r]));
    const remotes = list.map((r) => {
      const url = cleanUrl(r?.url);
      if (!url) throw badRequest('Remote URL must be an http(s) address');
      const prev = old.get(r.id);
      const token = (typeof r.token === 'string' ? r.token.trim().slice(0, 200) : '') || prev?.token || '';
      if (!token) throw badRequest(`${url}: the share token is required`);
      const name = (typeof r.name === 'string' ? r.name.trim().slice(0, 100) : '') || new URL(url).host;
      return { id: prev?.id || crypto.randomUUID(), name, url, token };
    });
    return { ...current, remotes };
  });
  return remoteSettings();
}

// ---------- Serving this dashboard to others ----------

const digest = (s) => crypto.createHash('sha256').update(String(s)).digest();

/** True when the request carries this dashboard's share token (else the 401 reply has been sent). */
async function peerAuthorized(req, res) {
  const shareToken = shareTokenOf(await getStore());
  const given = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization || '')?.[1] || '';
  if (shareToken && crypto.timingSafeEqual(digest(given), digest(shareToken))) return true;
  send(res, 401, { error: 'Invalid share token' });
  return false;
}

/** GET /api/peer with "Authorization: Bearer <share token>": this dashboard's servers and live data. */
async function handlePeer(req, res) {
  if (!(await peerAuthorized(req, res))) return;
  // Only its own config.servers - never servers pulled in from remotes, so dashboards can't loop.
  const config = await readConfig();
  const servers = config.servers || [];
  const local = servers.some((s) => s.local);
  const fresh = req.url.includes('fresh=1'); // the other dashboard's Refresh button
  const [stats, docker, usage, health, availability] = await Promise.all([
    local ? getStats() : null,
    local ? getContainers() : { available: false, containers: [] },
    local ? getContainerStats({ fresh }) : { interval: 0, stats: {} },
    getHealth({ fresh }),
    local ? getAvailability({ outages: PEER_OUTAGES }) : null,
  ]);
  send(res, 200, { version: VERSION, title: config.settings?.title || '', servers, stats, docker, usage, health: health.results || {}, availability });
}

/** GET /api/peer/info: this machine's system / network / Docker details (fetched only when someone opens the panel). */
async function handlePeerInfo(req, res) {
  if (!(await peerAuthorized(req, res))) return;
  send(res, 200, await getServerInfo());
}

// ---------- Showing other dashboards ----------

const cache = new Map(); // remote id -> { at, data, pending }

async function readBody(res) {
  const chunks = [];
  let size = 0;
  for await (const chunk of res.body) {
    size += chunk.length;
    if (size > MAX_BYTES) throw new Error('Response too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** GET a path of a remote dashboard with our token; returns the parsed JSON. */
async function peerJson(remote, pathname, notFound) {
  const res = await fetch(`${remote.url}${pathname}`, {
    headers: { Authorization: `Bearer ${remote.token}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(get('remoteTimeout') * 1000),
    redirect: 'manual', // a redirect elsewhere would drop (or leak) the token
  });
  if (res.status >= 300 && res.status < 400) throw new Error(`Redirects to ${res.headers.get('location')} - use that URL`);
  if (res.status === 401) throw new Error('Share token rejected');
  if (res.status === 404) throw new Error(notFound);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return JSON.parse(await readBody(res));
}

async function fetchPeer(remote, fresh) {
  const data = await peerJson(remote, `/api/peer${fresh ? '?fresh=1' : ''}`, 'Not a dashboard, or an older version without sharing');
  return {
    version: String(data.version || ''),
    title: String(data.title || ''),
    // Same validation as our own config: the browser gets nothing a saved config couldn't contain.
    servers: sanitizeConfig({ servers: data.servers }).servers,
    stats: data.stats || null,
    docker: { available: Boolean(data.docker?.available), error: data.docker?.error || '', containers: data.docker?.containers || [] },
    usage: { interval: data.usage?.interval || 0, stats: data.usage?.stats || {} },
    health: data.health || {},
    availability: data.availability && typeof data.availability === 'object' ? data.availability : null,
  };
}

const describe = (err) => (err.name === 'TimeoutError' ? 'Timed out' : err.cause?.code || err.cause?.message || err.message);

/** Cached briefly so several open tabs share one request; a failure keeps the last known servers.
 *  fresh = skip the cache here and on the remote (Refresh button). */
function remoteData(remote, fresh, ttl) {
  let entry = cache.get(remote.id);
  if (!entry) cache.set(remote.id, (entry = { at: 0, data: null, pending: null }));
  if (!fresh && Date.now() - entry.at < ttl) return entry.data;
  // lastOk = when the servers/data were last received, so a failure can say how old the shown servers are.
  entry.pending ||= fetchPeer(remote, fresh)
    .then(
      (data) => ({ ok: true, error: '', lastOk: Date.now(), ...data }),
      (err) => ({ ok: false, error: describe(err), lastOk: entry.data?.lastOk || 0, title: entry.data?.title || '', servers: entry.data?.servers || [] })
    )
    .then((data) => {
      if (cache.get(remote.id) === entry) Object.assign(entry, { at: Date.now(), data, pending: null });
      return data;
    });
  return entry.pending;
}

/** GET /api/remotes: every remote dashboard with its servers and live data (no tokens), plus the polling interval.
 *  age = ms since the data was received, so browsers need not trust this server's clock.
 *  fresh = id of a remote to fetch fresh; only = id of the one remote wanted (switching to it must not wait for the others). */
async function getRemotes({ fresh = '', only = '' } = {}) {
  const s = await getStore();
  const interval = intervalOf(s);
  const remotes = allRemotes(s).filter((r) => !only || r.id === only);
  return {
    interval,
    remotes: await Promise.all(
      remotes.map(async (r) => {
        const data = await remoteData(r, r.id === fresh, cacheMs(interval));
        return { id: r.id, name: r.name, url: r.url, ...data, age: data.lastOk ? Math.max(0, Date.now() - data.lastOk) : null };
      })
    ),
  };
}

/** Servers last received from remotes (their icons may be cached too). */
const remoteServers = () => [...cache.values()].flatMap((e) => e.data?.servers || []);

const infoCache = new Map(); // remote id -> { at, data, pending }
const INFO_CACHE_MS = 30_000;

/** GET /api/remotes/info?id=: the Server info of a remote dashboard's machine (cached briefly). */
async function getRemoteInfo(id) {
  const remote = allRemotes(await getStore()).find((r) => r.id === id);
  if (!remote) throw new HttpError(404, 'Unknown remote dashboard');
  let entry = infoCache.get(id);
  if (!entry) infoCache.set(id, (entry = { at: 0, data: null, pending: null }));
  if (entry.data && Date.now() - entry.at < INFO_CACHE_MS) return entry.data;
  entry.pending ||= peerJson(remote, '/api/peer/info', 'That dashboard is too old to share server info - update it')
    .then((data) => Object.assign(entry, { at: Date.now(), data: sanitizeInfo(data) }).data)
    .finally(() => (entry.pending = null));
  try {
    return await entry.pending;
  } catch (err) {
    throw new HttpError(502, describe(err));
  }
}

module.exports = { handlePeer, handlePeerInfo, getRemotes, getRemoteInfo, remoteSettings, setSharing, setRefreshInterval, saveRemotes, remoteServers };
