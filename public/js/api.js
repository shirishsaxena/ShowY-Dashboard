// Calls to the dashboard server.

import { state, normalizeConfig } from './state.js';
import { toast } from './dom.js';

export class LockedError extends Error {}

export async function api(method, url, body, signal) {
  const opts = { method, headers: {}, signal };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(url, opts);
  const data = await res.json().catch(() => ({}));
  return { res, data };
}

/** GET a JSON endpoint and store the result; failures keep the previous value. local = data about this machine (stamps state.localAt). */
async function load(url, apply, local = false) {
  try {
    const { res, data } = await api('GET', url);
    if (res.ok) {
      apply(data);
      if (local) state.localAt = Date.now();
    }
    return res.ok;
  } catch {
    return false;
  }
}

export async function loadAuth() {
  await load('/api/auth', (data) => (state.auth = data));
}

export async function loadConfig() {
  const { res, data } = await api('GET', '/api/config');
  if (res.status === 401) throw new LockedError('Locked');
  if (!res.ok) throw new Error(`Failed to load config (${res.status})`);
  state.config = normalizeConfig(data.config);
  // The server was rebuilt while this tab stayed open: its scripts are out of date.
  if (state.version && data.version && data.version !== state.version) {
    toast(`Dashboard updated to v${data.version} — reload the page`);
  }
  state.version = data.version || state.version;
  if (data.tunables) state.tunables = { ...state.tunables, ...data.tunables };
}

export async function loadDocker() {
  const ok = await load('/api/docker', (data) => (state.docker = data), true);
  if (!ok) state.docker = { available: false, error: 'Dashboard server unreachable', containers: [] };
}

export const loadStats = () => load('/api/stats', (data) => (state.stats = data), true);

/** Outage history of this dashboard (settings, availability per period, outage list). */
export async function fetchAvailability() {
  const { res, data } = await api('GET', '/api/availability');
  return res.ok ? data : null;
}

export const loadClip = () => load('/api/clip', (data) => (state.clip = data));

/** Container CPU / memory / network; fresh = skip the server's cache (refresh button). */
export const loadUsage = (fresh = false) =>
  load(`/api/docker/stats${fresh ? '?fresh=1' : ''}`, (data) => (state.usage = { interval: data.interval, stats: data.stats || {} }), true);

/** fresh = re-run the checks instead of using the server's short cache. */
export const loadHealth = (fresh = false) =>
  load(`/api/health${fresh ? '?fresh=1' : ''}`, (data) => (state.health = data.results || {}), true);

/** Remote dashboards. Their live data only counts while they answer; otherwise just the last known servers show.
 *  fresh = id of a remote to fetch fresh (Refresh button while viewing it). */
export async function loadRemotes(fresh = '') {
  const started = Date.now();
  return load(`/api/remotes${fresh ? `?fresh=${encodeURIComponent(fresh)}` : ''}`, (data) => {
    if (data.interval) state.remotesInterval = data.interval;
    // A remote loaded on its own while this request was running is newer than what came back here.
    const current = new Map(state.remotes.map((r) => [r.id, r]));
    state.remotes = (data.remotes || []).map(remoteEntry).map((r) => (current.get(r.id)?.at > started ? current.get(r.id) : r));
  });
}

/** One remote dashboard, for switching to its servers. Returns null when it is no longer configured;
 *  a network failure throws (signal = cancel when another server was picked). */
export async function loadRemote(id, { fresh = false, signal } = {}) {
  const { res, data } = await api('GET', `/api/remotes?id=${encodeURIComponent(id)}${fresh ? `&fresh=${encodeURIComponent(id)}` : ''}`, undefined, signal);
  if (!res.ok) throw new Error(`Dashboard server answered HTTP ${res.status}`);
  if (!data.remotes?.[0]) return null;
  if (data.interval) state.remotesInterval = data.interval;
  const entry = remoteEntry(data.remotes[0]);
  const i = state.remotes.findIndex((r) => r.id === id);
  if (i < 0) state.remotes.push(entry);
  else state.remotes[i] = entry;
  return entry;
}

function remoteEntry(r) {
  const live = r.ok
    ? { docker: r.docker, usage: r.usage, stats: r.stats, health: r.health, availability: r.availability }
    : { docker: { available: false, containers: [] }, usage: { interval: 0, stats: {} }, stats: null, health: {}, availability: null };
  let { servers } = normalizeConfig({ servers: r.servers });
  if (!servers.length) servers = [{ id: '', name: r.name, services: [], groups: [] }];
  return {
    id: r.id,
    name: r.name,
    url: r.url,
    ok: r.ok,
    error: r.error,
    // The server says how old the data is; our own clock is used from there (the two clocks may differ).
    lastOk: r.age == null ? 0 : Date.now() - r.age, // when its servers were last received
    at: Date.now(), // when this browser got the data (to tell when it has gone stale)
    ...live,
    servers: servers.map((s) => ({ ...s, id: `${r.id}:${s.id}`, remote: r.id })),
  };
}

/** Returns an error message, or null on success. */
export async function login(password) {
  const { res, data } = await api('POST', '/api/login', { password });
  if (!res.ok) return data.error || 'Login failed';
  state.auth = data;
  return null;
}

export async function logout() {
  const { data } = await api('POST', '/api/logout', {});
  state.auth = { ...state.auth, ...data, authenticated: false };
}
