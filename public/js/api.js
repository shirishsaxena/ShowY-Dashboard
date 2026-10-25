// Calls to the dashboard server.

import { state, normalizeConfig } from "./state.js";
import { toast } from "./dom.js";

export class LockedError extends Error {}

// A forced peer refresh may wait for a background fetch, then fetch fresh.
// The browser must outlive both backend deadlines, including response overhead.
// These are consumer deadlines: aborting must not cancel shared server collection.
export const collectionTimeout = ({ fresh = false } = {}) =>
  Math.max(
    state.tunables.loadTimeout || 75,
    (fresh ? 2 : 1) * (state.tunables.remoteTimeout || 60) + 5,
  ) * 1000;

export async function api(method, url, body, signal, responseType = "json") {
  const opts = { method, headers: {}, signal };
  if (body !== undefined) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(url, opts);
  if (res.ok && responseType === "blob") return { res, data: await res.blob() };
  let data;
  try {
    data = await res.json();
    if (data === null || typeof data !== "object") throw new Error();
  } catch (err) {
    if (signal?.aborted) throw err;
    if (res.ok)
      throw new Error("Dashboard server returned an invalid response");
    data = {};
  }
  if (!["GET", "HEAD"].includes(method) && typeof document !== "undefined")
    document.dispatchEvent(new Event("activity-changed"));
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
    collectionTimeout({
      fresh: url.startsWith("/api/remotes?") && url.includes("fresh="),
    }),
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
  const epoch = state.configEpoch;
  const saving = state.configSaving;
  const { res, data } = await api("GET", "/api/config", undefined, signal);
  if (res.status === 401) throw new LockedError("Locked");
  if (!res.ok) throw new Error(`Failed to load config (${res.status})`);
  // A load begun before/during an edit must not replace its committed result.
  if (!saving && !state.configSaving && epoch === state.configEpoch) {
    state.config = normalizeConfig(data.config);
    state.configRevision = data.revision || null;
    state.configEpoch = (state.configEpoch || 0) + 1;
  }
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
  const ok = await load(
    "/api/docker",
    (data) => (state.docker = data),
    current,
  );
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
  const { res, data } = await api(
    "GET",
    "/api/availability",
    undefined,
    signal,
  );
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

const remoteContext = () => {
  const config = state.config;
  const auth = state.auth;
  return () => !state.locked && state.config === config && state.auth === auth;
};

let pendingRemotes = null;
let remoteDirectory = null;
const sameRemote = (a, b) => a?.url === b?.url && a?.name === b?.name;

/** Publish names first, then at most four independent peer snapshots.
 *  Progress runs after directory publication and every applied completion (including errors).
 *  false means the directory failed or the context expired; peer failures live on their entries.
 *  Identical polls share work; fresh variants queue and get their version when they actually start. */
export function loadRemotes(fresh = "", onProgress = () => {}) {
  if (pendingRemotes?.current()) {
    if (!fresh || fresh === pendingRemotes.fresh) {
      pendingRemotes.listeners.add(onProgress);
      return pendingRemotes.promise;
    }
    const current = remoteContext();
    return pendingRemotes.promise.then(() =>
      current() ? loadRemotes(fresh, onProgress) : false,
    );
  }
  const cycle = {
    fresh,
    current: remoteContext(),
    version: ++remoteRequestVersion,
    listeners: new Set([onProgress]),
    entries: new Set(),
  };
  pendingRemotes = cycle;
  cycle.promise = performRemotesLoad(cycle).finally(() => {
    // Only clean up placeholders still owned by this cycle, never a newer load.
    state.remotes = state.remotes.map((r) =>
      cycle.entries.has(r) && r.loading ? { ...r, loading: false } : r,
    );
    if (pendingRemotes === cycle) pendingRemotes = null;
  });
  return cycle.promise;
}

function remoteProgress(cycle) {
  if (!cycle.current()) return;
  for (const listener of cycle.listeners) {
    // Rendering failures must not strand the remaining peer requests.
    try {
      listener();
    } catch {}
  }
}

async function performRemotesLoad(cycle) {
  const { fresh, current, version } = cycle;
  let directory;
  const ok = await performLoad(
    `/api/remotes?directory=1${fresh ? `&fresh=${encodeURIComponent(fresh)}` : ""}`,
    (data) => {
      if (!Array.isArray(data.remotes)) return false;
      directory = data.remotes;
      if (data.interval) state.remotesInterval = data.interval;
      const previous = new Map(state.remotes.map((r) => [r.id, r]));
      remoteDirectory = {
        current,
        entries: new Map(directory.map((r) => [r.id, r])),
      };
      state.remotes = directory.map(({ id, name, url }) => {
        let prior = previous.get(id);
        // A later-started targeted request may already know newer metadata too.
        if (prior?.requestVersion > version) return prior;
        // A different dashboard at the same id must not inherit the old snapshot.
        if (prior && prior.url !== url) prior = undefined;
        const entry = {
          servers: [],
          ...prior,
          id,
          name,
          url,
          loading: true,
          requestVersion: version,
        };
        cycle.entries.add(entry);
        return entry;
      });
      remoteProgress(cycle);
    },
    current,
  );
  if (!ok) return false;
  let next = 0;
  const worker = async () => {
    while (current() && next < directory.length) {
      const remote = directory[next++];
      const before = state.remotes.find((r) => r.id === remote.id);
      if (!before || before.requestVersion > version) continue;
      let applied = false;
      const loaded = await performLoad(
        `/api/remotes?id=${encodeURIComponent(remote.id)}${remote.id === fresh ? `&fresh=${encodeURIComponent(fresh)}` : ""}`,
        (data) => {
          const index = state.remotes.findIndex((r) => r.id === remote.id);
          const previous = state.remotes[index];
          if (!previous || previous.requestVersion > version) return;
          const result = data.remotes?.find((r) => r.id === remote.id);
          if (!result || !sameRemote(remote, result)) return false;
          const entry = remoteEntry(result, version, previous);
          // Transport/peer failures must not erase servers already known in this tab.
          if (!result.ok && previous.servers.length)
            entry.servers = previous.servers;
          state.remotes[index] = entry;
          applied = true;
        },
        current,
      );
      if (!current()) return;
      if (!loaded) {
        const index = state.remotes.findIndex((r) => r.id === remote.id);
        const previous = state.remotes[index];
        if (previous && previous.requestVersion <= version) {
          state.remotes[index] = {
            ...previous,
            ok: false,
            error: "Dashboard server unreachable",
            pollError: "Dashboard server unreachable",
            loading: false,
          };
          applied = true;
        }
      }
      if (applied) remoteProgress(cycle);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(4, directory.length) }, worker),
  );
  return current();
}

/** One remote dashboard, for switching to its servers. Returns null when it is no longer configured;
 *  a network failure throws (signal = cancel when another server was picked). */
export async function loadRemote(id, { fresh = false, signal } = {}) {
  const current = remoteContext();
  const directory = remoteDirectory;
  const version = ++remoteRequestVersion;
  const { res, data } = await api(
    "GET",
    `/api/remotes?id=${encodeURIComponent(id)}${fresh ? `&fresh=${encodeURIComponent(id)}` : ""}`,
    undefined,
    signal,
  );
  if (!res.ok) throw new Error(`Dashboard server answered HTTP ${res.status}`);
  if (signal?.aborted || !current())
    throw new Error("Dashboard load cancelled");
  if (!data.remotes?.[0]) return null;
  // A directory received while this request waited may remove/reconfigure its id.
  // Do not let a late targeted response resurrect that old dashboard.
  if (remoteDirectory !== directory && remoteDirectory?.current()) {
    const configured = remoteDirectory.entries.get(id);
    if (!configured || !sameRemote(configured, data.remotes[0])) return null;
  }
  if (data.interval) state.remotesInterval = data.interval;
  const i = state.remotes.findIndex((r) => r.id === id);
  if (i >= 0 && state.remotes[i].requestVersion > version)
    return state.remotes[i];
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
    loading: false,
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
