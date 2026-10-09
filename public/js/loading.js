// Loading state of the selected server, shown while its data is first fetched (page open, or switching to
// a remote dashboard) so default or old values are not mistaken for current ones. The state is state.loading.

import { state, prefs, allServers } from "./state.js";
import { loadRemote } from "./api.js";
import { render } from "./view/render.js";

const TIMEOUT_MS = () => state.tunables.loadTimeout * 1000; // Settings / LOAD_TIMEOUT

let seq = 0; // every start bumps it: answers that belong to an older start are ignored
let controller = null;
let timer = 0;

const isKnown = (serverId) => allServers().some((s) => s.id === serverId);

/** What the selection points at: a remote server (possibly not known yet right after a page load),
 *  or - on page open only - this machine. null = nothing to wait for. */
function targetOf(initial) {
  const id = state.activeId;
  const servers = allServers();
  const known = servers.find((s) => s.id === id);
  if (known?.remote)
    return {
      kind: "remote",
      serverId: id,
      remoteId: known.remote,
      name: known.name,
      icon: known.icon || "",
    };
  // Remote server ids are "<dashboard id>:<server id>"; a saved one can't be resolved before its dashboard answered.
  if (!known && typeof id === "string" && id.includes(":")) {
    return {
      kind: "remote",
      serverId: id,
      remoteId: id.slice(0, id.indexOf(":")),
      name: prefs.tabName || "remote server",
      icon: "",
    };
  }
  const server = known || servers[0];
  return initial && server?.local && !server.remote
    ? {
        kind: "local",
        serverId: server.id,
        name: server.name,
        icon: server.icon || "",
      }
    : null;
}

/** Begin loading for the current selection, cancelling any load still running. The caller renders afterwards;
 *  later changes (finish, failure, steps) render themselves. Returns a promise for a remote load (settles when it ends). */
export function startLoad({ initial = false, fresh = false } = {}) {
  controller?.abort();
  clearTimeout(timer);
  const mine = ++seq;
  const target = targetOf(initial);
  if (!target) {
    state.loading = null;
    return;
  }

  const remote = target.kind === "remote";
  const loading = (state.loading = {
    ...target,
    stage: remote ? "connecting" : "info",
    progress: remote ? null : 0, // one request = no real percentage; this machine reports finished steps
    error: "",
    pending: remote ? null : new Set(["info", "services"]),
    // Nothing to show yet: a panel replaces the page. Known remote servers keep their last data on screen instead.
    blocking: !remote || !isKnown(target.serverId),
  });
  const alive = () =>
    mine === seq && state.loading === loading && loading.stage !== "failed";

  if (!remote) {
    timer = setTimeout(() => alive() && finish(), TIMEOUT_MS()); // never hold the page forever
    return;
  }
  controller = new AbortController();
  timer = setTimeout(() => {
    if (!alive()) return;
    controller.abort();
    fail(loading, "Timed out waiting for the dashboard");
  }, TIMEOUT_MS());
  return loadRemote(target.remoteId, { fresh, signal: controller.signal }).then(
    (data) => {
      if (!alive()) return;
      if (data?.ok === false) fail(loading, data.error || "No response");
      else finish(); // answered (or no longer configured: the page falls back to the first server)
    },
    (err) =>
      alive() &&
      fail(
        loading,
        err instanceof TypeError ? "Dashboard server unreachable" : err.message,
      ),
  );
}

function finish() {
  clearTimeout(timer);
  state.loading = null;
  render();
  document.dispatchEvent(new Event("initial-load-settled"));
}

function fail(loading, error) {
  clearTimeout(timer);
  Object.assign(loading, {
    stage: "failed",
    error,
    progress: null,
    failedAt: Date.now(),
    blocking: !isKnown(loading.serverId),
  });
  render();
  document.dispatchEvent(new Event("initial-load-settled"));
}

/** This machine's data arrived: 'info' (host stats) or 'services' (Docker). */
export function loaded(task) {
  const loading = state.loading;
  if (loading?.kind !== "local") return;
  loading.pending.delete(task);
  if (!loading.pending.size) return finish();
  loading.stage = [...loading.pending][0];
  loading.progress = 1 - loading.pending.size / 2;
  render();
}

export function retryLoad() {
  startLoad({ fresh: true });
  render();
}

/** A failed load ends by itself once a regular refresh got the dashboard's data after it. */
export function settleLoad() {
  const loading = state.loading;
  if (loading?.stage !== "failed") return;
  const remote = state.remotes.find((r) => r.id === loading.remoteId);
  if (remote?.ok && remote.at > loading.failedAt) state.loading = null;
}
