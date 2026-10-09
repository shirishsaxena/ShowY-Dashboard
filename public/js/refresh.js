// Background polling and manual refresh orchestration, separate from page setup.

import { state, activeServer } from "./state.js";
import { $, toast } from "./dom.js";
import {
  loadDocker,
  loadHealth,
  loadStats,
  loadUsage,
  loadRemotes,
} from "./api.js";
import { render, requestRender } from "./view/render.js";
import { tickAgo } from "./view/server.js";
import { refreshClip } from "./clip.js";
import { startLoad, loaded } from "./loading.js";

// ---------- Data refresh ----------

const hasLocalServer = () => state.config.servers.some((s) => s.local);
const canRefresh = () => !state.locked && !document.hidden;

/** Coalesce background updates, preserving active drag operations. */
const rerender = () => requestRender();

// Count dashboard operations so one completing source cannot re-enable the
// button while another scheduled/manual refresh is still in flight.
let activeRefreshes = 0;
let lastRemotesFinishedAt = null;
let pendingRemotes = null;
let pendingRemotesConfig = null;
function refreshBusy(change) {
  activeRefreshes += change;
  const busy = activeRefreshes > 0;
  const btn = $("#refreshBtn");
  btn.disabled = busy;
  btn.classList.toggle("spin", busy);
  if (busy) btn.setAttribute("aria-busy", "true");
  else btn.removeAttribute("aria-busy");
}

/** Remote dashboards: their servers, statuses and stats in one request. */
function refreshRemotes() {
  if (pendingRemotes) {
    if (pendingRemotesConfig !== state.config)
      return pendingRemotes.then(refreshRemotes);
    return pendingRemotes;
  }
  if (!pageActive || !canRefresh()) return Promise.resolve(null);
  clearTimeout(remotesTimer);
  pendingRemotesConfig = state.config;
  refreshBusy(1);
  pendingRemotes = performRemotesRefresh().finally(() => {
    pendingRemotes = null;
    lastRemotesFinishedAt = performance.now();
    refreshBusy(-1);
    scheduleRemotes();
  });
  return pendingRemotes;
}

async function performRemotesRefresh() {
  const config = state.config;
  const had = state.remotes.length;
  const first = !state.remotesReady;
  const previous = new Map(state.remotes.map((r) => [r.id, r]));
  const ok = await loadRemotes();
  if (state.locked || state.config !== config) return null;
  state.remotesError = ok ? "" : "Remote dashboard status could not be refreshed";
  if (!ok)
    state.remotes = state.remotes.map((r) =>
      previous.get(r.id) === r ? { ...r, pollError: state.remotesError } : r,
    );
  state.remotesReady = true;
  if (first || had || state.remotes.length) rerender();
  return ok;
}

/** Completion-based deadlines avoid overlaps and survive hidden/suspended pages. */
let remotesTimer;
const remaining = (finishedAt, seconds) =>
  finishedAt == null
    ? 0
    : Math.max(0, finishedAt + seconds * 1000 - performance.now());

function scheduleRemotes() {
  clearTimeout(remotesTimer);
  if (!timersStarted || !pageActive || !canRefresh() || pendingRemotes) return;
  remotesTimer = setTimeout(
    refreshRemotes,
    remaining(lastRemotesFinishedAt, state.remotesInterval),
  );
}

// One cycle owns all local dashboard data. Different fresh variants are serialized,
// so a manual request cannot be swallowed by an in-flight cached poll.
let pendingLocal = null;
let pendingLocalFresh = false;
let pendingLocalConfig = null;
let lastLocalFinishedAt = null;
let localTimer;
let timersStarted = false;
let pageActive = true;

function scheduleLocal() {
  clearTimeout(localTimer);
  if (!timersStarted || !pageActive || !canRefresh() || pendingLocal) return;
  localTimer = setTimeout(
    refreshLocal,
    remaining(lastLocalFinishedAt, state.tunables.localDashboardRefresh),
  );
}

function refreshLocal(fresh = false) {
  if (pendingLocal) {
    if (pendingLocalConfig !== state.config)
      return pendingLocal.then(() => refreshLocal(fresh));
    if (fresh && !pendingLocalFresh)
      return pendingLocal.then(() => refreshLocal(true));
    return pendingLocal;
  }
  if (!pageActive || !canRefresh()) return Promise.resolve(null);
  clearTimeout(localTimer);
  pendingLocalFresh = fresh;
  pendingLocalConfig = state.config;
  refreshBusy(1);
  pendingLocal = performLocalRefresh(fresh).finally(() => {
    pendingLocal = null;
    lastLocalFinishedAt = performance.now();
    refreshBusy(-1);
    scheduleLocal();
  });
  return pendingLocal;
}

async function performLocalRefresh(fresh) {
  const config = state.config;
  const local = hasLocalServer();
  const applied = (task, ok) => {
    if (state.config === config && !state.locked && task) loaded(task);
    rerender();
    return ok;
  };
  // Apply and render each source promptly, but commit the age only after all finish.
  const results = await Promise.allSettled([
    local
      ? loadDocker().then((ok) => applied("services", ok))
      : true,
    local && (fresh || state.stats?.interval !== 0)
      ? loadStats().then((ok) => applied("info", ok))
      : applied("info", true),
    local ? loadUsage(fresh).then((ok) => applied(null, ok)) : true,
    loadHealth(fresh).then((ok) => applied(null, ok)),
  ]);
  // Config edits or a new authenticated session invalidate the old cycle.
  if (state.locked || state.config !== config) return null;
  const ok =
    results.every(
      (result) => result.status === "fulfilled" && result.value === true,
    ) &&
    (!local || state.docker.available);
  state.localError = ok ? "" : "Some required dashboard data could not be refreshed";
  if (local && ok) state.localAt = Date.now();
  rerender();
  if (!ok && !fresh)
    toast(
      "Some status data could not be refreshed — showing last known values",
      true,
    );
  return ok;
}

let pendingRefresh = null;
let pendingManual = false;
let pendingRefreshConfig = null;

export function refreshAll(options = {}) {
  if (pendingRefresh) {
    if (pendingRefreshConfig !== state.config)
      return pendingRefresh.then(() => refreshAll(options));
    // A background refresh must not swallow a request to bypass the server cache.
    if (options.manual && !pendingManual)
      return pendingRefresh.then(() => refreshAll(options));
    return pendingRefresh;
  }
  if (!pageActive || !canRefresh()) return Promise.resolve(null);
  pendingManual = Boolean(options.manual);
  pendingRefreshConfig = state.config;
  refreshBusy(1);
  pendingRefresh = performRefresh(options).finally(() => {
    pendingRefresh = null;
    refreshBusy(-1);
  });
  return pendingRefresh;
}

async function performRefresh({ manual = false } = {}) {
  // Viewing a remote dashboard's server: the manual refresh fetches that dashboard fresh, showing its loading state.
  const remoteId = manual ? activeServer()?.remote || "" : "";
  const reload = remoteId ? startLoad({ fresh: true }) : null;
  if (reload) {
    render();
    await reload;
    if (activeServer()?.remote !== remoteId) return;
    const remote = state.remotes.find((r) => r.id === remoteId);
    const failure =
      state.loading?.remoteId === remoteId && state.loading.stage === "failed"
        ? state.loading.error
        : "";
    if (remote && (failure || !remote.ok || remote.refreshError))
      toast(
        `Could not refresh ${remote.name}: ${failure || remote.error || remote.refreshError}`,
        true,
      );
    else if (remote) toast(`${remote.name} refreshed`);
    return;
  }
  const results = await Promise.all([
    refreshLocal(manual),
    refreshRemotes(),
    refreshClip(),
  ]);
  if (manual) {
    const dockerDown = hasLocalServer() && !state.docker.available;
    const incomplete = results[0] !== true || results[1] === false;
    toast(
      dockerDown
        ? state.docker.error
        : incomplete
          ? "Some status data could not be refreshed — showing last known values"
          : "Status refreshed",
      dockerDown || incomplete,
    );
  }
}

/** Runs fn every state.tunables[key] seconds (Settings / docker-compose); the returned function re-plans after that setting changed. */
function every(key, fn) {
  let timer;
  const plan = () => {
    clearTimeout(timer);
    if (!pageActive) return;
    timer = setTimeout(() => {
      plan();
      fn();
    }, state.tunables[key] * 1000);
  };
  plan.stop = () => clearTimeout(timer);
  plan();
  return plan;
}

export function startTimers() {
  if (timersStarted) return;
  timersStarted = true;
  const planClip = every("healthRefresh", () => canRefresh() && refreshClip());
  scheduleLocal();
  document.addEventListener("tunables-changed", () => {
    scheduleLocal();
    planClip();
  });
  let agoTimer = setInterval(tickAgo, 1000);
  scheduleRemotes();
  document.addEventListener("visibilitychange", () => {
    clearTimeout(localTimer);
    clearTimeout(remotesTimer);
    if (document.hidden) return;
    tickAgo(); // Catch up the label after browser timer throttling, without fetching.
    if (state.locked) return;
    // Reuse the original deadlines: resume the remaining delay, or catch up
    // immediately when overdue. Merely becoming visible never stamps the age.
    scheduleLocal();
    scheduleRemotes();
    refreshClip();
  });
  document.addEventListener("config-saved", () => refreshLocal(true));
  document.addEventListener("remotes-interval-changed", scheduleRemotes);
  // Timers/listeners live for this page; no duplicate subscriptions on login/navigation.
  window.addEventListener("pagehide", () => {
    pageActive = false;
    clearTimeout(localTimer);
    clearTimeout(remotesTimer);
    planClip.stop();
    clearInterval(agoTimer);
  });
  window.addEventListener("pageshow", () => {
    pageActive = true;
    tickAgo();
    scheduleLocal();
    scheduleRemotes();
    planClip();
    clearInterval(agoTimer);
    agoTimer = setInterval(tickAgo, 1000);
  });
}
