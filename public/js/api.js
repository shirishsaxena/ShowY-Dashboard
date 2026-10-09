// Calls to the dashboard server.

import { state, normalizeConfig } from "./state.js";
import { toast } from "./dom.js";

export class LockedError extends Error {}

export async function api(method, url, body, signal) {
  const opts = { method, headers: {}, signal };
  if (body !== undefined) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(url, opts);
  let data;
  try {
    data = await res.json();
    if (data === null || typeof data !== "object") throw new Error();
  } catch (err) {
    if (signal?.aborted) throw err;
    if (res.ok) throw new Error("Dashboard server returned an invalid response");
    data = {};
  }
  return { res, data };
}

const pendingLoads = new Map();

/** Share identical polls; serialize different variants so a manual fresh request is never lost. */
function load(url, apply, current = () => true) {
  const source = url.split("?")[0];
  const pending = pendingLoads.get(source);
  if (pending) {
    return pending.url === url || !url.includes("?")
      ? pending.promise
      : pending.promise.then(() => load(url, apply, current));
  }
  const promise = performLoad(url, apply, current).finally(() =>
    pendingLoads.delete(source),
  );
  pendingLoads.set(source, { url, promise });
  return promise;
}

/** GET a JSON endpoint and store the result; only the refresh coordinator stamps dashboard age. */
async function performLoad(url, apply, current) {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    state.tunables.loadTimeout * 1000,
  );
  try {
    const { res, data } = await api("GET", url, undefined, controller.signal);
    if (!res.ok || !current()) return false;
    return apply(data, started) !== false;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export async function loadAuth(signal) {
  const { res, data } = await api("GET", "/api/auth", undefined, signal);
  if (!res.ok) throw new Error(`Failed to check access (${res.status})`);
  state.auth = data;
}

export async function loadConfig(signal) {
  const { res, data } = await api("GET", "/api/config", undefined, signal);
  if (res.status === 401) throw new LockedError("Locked");
  if (!res.ok) throw new Error(`Failed to load config (${res.status})`);
  state.config = normalizeConfig(data.config);
  // The server was rebuilt while this tab stayed open: its scripts are out of date.
  if (state.version && data.version && data.version !== state.version) {
    toast(`Dashboard updated to v${data.version} — reload the page`);
  }
  state.version = data.version || state.version;
  if (data.tunables) state.tunables = { ...state.tunables, ...data.tunables };
}

const dashboardContext = () => {
  const config = state.config;
  return () => !state.locked && state.config === config;
};

export async function loadDocker() {
  const current = dashboardContext();
  const ok = await load("/api/docker", (data) => (state.docker = data), current);
  if (!ok && current())
    state.docker = {
      available: false,
      error: "Dashboard server unreachable",
      containers: [],
    };
  return ok;
}

export const loadStats = () =>
  load("/api/stats", (data) => (state.stats = data), dashboardContext());

/** Outage history of this dashboard (settings, availability per period, outage list). */
export async function fetchAvailability(signal) {
  const { res, data } = await api("GET", "/api/availability", undefined, signal);
  return res.ok ? data : null;
}

export const loadClip = () => load("/api/clip", (data) => (state.clip = data));

/** Container CPU / memory / network; fresh = skip the server's cache (refresh button). */
export const loadUsage = (fresh = false) =>
  load(
    `/api/docker/stats${fresh ? "?fresh=1" : ""}`,
    (data) => {
      if (data.ok === false) return false;
      state.usage = { interval: data.interval, stats: data.stats || {} };
    },
    dashboardContext(),
  );

/** fresh = re-run the checks instead of using the server's short cache. */
export const loadHealth = (fresh = false) =>
  load(
    `/api/health${fresh ? "?fresh=1" : ""}`,
    (data) => (state.health = data.results || {}),
    dashboardContext(),
  );

/** Remote dashboards. Their live data only counts while they answer; otherwise just the last known servers show.
 *  fresh = id of a remote to fetch fresh (Refresh button while viewing it). */
export async function loadRemotes(fresh = "") {
  const version = ++remoteRequestVersion;
  return load(
    `/api/remotes${fresh ? `?fresh=${encodeURIComponent(fresh)}` : ""}`,
    (data) => {
      if (data.interval) state.remotesInterval = data.interval;
      // Preserve later-started targeted loads even if this bulk response arrives last.
      const current = new Map(state.remotes.map((r) => [r.id, r]));
      state.remotes = (data.remotes || [])
        .map((r) => remoteEntry(r, version, current.get(r.id)))
        .map((r) =>
          current.get(r.id)?.requestVersion > version ? current.get(r.id) : r,
        );
    },
    dashboardContext(),
  );
}

/** One remote dashboard, for switching to its servers. Returns null when it is no longer configured;
 *  a network failure throws (signal = cancel when another server was picked). */
export async function loadRemote(id, { fresh = false, signal } = {}) {
  const current = dashboardContext();
  const version = ++remoteRequestVersion;
  const { res, data } = await api(
    "GET",
    `/api/remotes?id=${encodeURIComponent(id)}${fresh ? `&fresh=${encodeURIComponent(id)}` : ""}`,
    undefined,
    signal,
  );
  if (!res.ok) throw new Error(`Dashboard server answered HTTP ${res.status}`);
  if (signal?.aborted || !current()) throw new Error("Dashboard load cancelled");
  if (!data.remotes?.[0]) return null;
  if (data.interval) state.remotesInterval = data.interval;
  const i = state.remotes.findIndex((r) => r.id === id);
  if (i >= 0 && state.remotes[i].requestVersion > version) return state.remotes[i];
  const entry = remoteEntry(data.remotes[0], version, state.remotes[i]);
  if (i < 0) state.remotes.push(entry);
  else state.remotes[i] = entry;
  return entry;
}

let remoteRequestVersion = 0;

function remoteEntry(r, requestVersion, previous) {
  const live = r.ok
    ? {
        docker: r.docker,
        usage: r.usage,
        stats: r.stats,
        health: r.health,
        availability: r.availability,
        refreshError: r.refreshError || "",
      }
    : {
        docker: { available: false, containers: [] },
        usage: { interval: 0, stats: {} },
        stats: null,
        health: {},
        availability: null,
      };
  let { servers } = normalizeConfig({ servers: r.servers });
  if (!servers.length)
    servers = [{ id: "", name: r.name, services: [], groups: [] }];
  return {
    id: r.id,
    name: r.name,
    url: r.url,
    ok: r.ok,
    error: r.error,
    // The server says how old the data is; our own clock is used from there (the two clocks may differ).
    // Identical cached snapshots keep exactly the same age anchor. The backend
    // stamp is compared for identity only, never interpreted using our clock.
    sourceAt: r.lastOk,
    lastOk:
      r.age == null
        ? 0
        : r.lastOk && previous?.sourceAt === r.lastOk
          ? previous.lastOk
          : Date.now() - Math.max(0, Number(r.age) || 0),
    at: Date.now(), // browser receipt time; not the snapshot's success timestamp
    requestVersion, // request ordering independent of browser wall-clock changes
    ...live,
    servers: servers.map((s) => ({
      ...s,
      id: `${r.id}:${s.id}`,
      remote: r.id,
    })),
  };
}

/** Returns an error message, or null on success. */
export async function login(password) {
  const { res, data } = await api("POST", "/api/login", { password });
  if (!res.ok) return data.error || "Login failed";
  state.auth = data;
  return null;
}

export async function logout() {
  const { res, data } = await api("POST", "/api/logout", {});
  if (!res.ok) throw new Error(data.error || `Logout failed (${res.status})`);
  state.auth = { ...state.auth, ...data, authenticated: false };
}
