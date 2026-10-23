import { state } from "./state.js";
import { toast, h, svg } from "./dom.js";
import { editApi } from "./edit-api.js";
import { ensureCanEdit } from "./actions.js";
import { ask } from "./dialogs/ask.js";
import { uid } from "./utils.js";
import { render } from "./render-interface.js";
import { refreshActivity } from "./activity.js";

const pending = new Map();
const verbs = { start: "Starting", restart: "Restarting", stop: "Stopping" };
function busy(id) {
  return pending.get(id) || state.docker.control?.busy?.find((job) => job.id === id);
}
function changed() {
  render();
  document.dispatchEvent(new Event("docker-control-changed"));
}

export function containerOperationNode(container) {
  const job = container && busy(container.id);
  return job ? h("small", { class: "container-operation", role: "status" }, svg("clock"),
    `${verbs[job.action]} container…`) : null;
}

export function containerControlItems(container) {
  const current = state.docker.containers.find((item) => item.id === container?.id);
  const valid = current && /^[a-f0-9]{64}$/.test(current.id);
  const job = current && busy(current.id);
  const capability = state.docker.control;
  const stable = ["running", "exited", "created"].includes(current?.state);
  const reason = !capability?.enabled ? capability?.reason || "Container control unavailable"
    : !valid || !state.docker.available ? "Container unavailable — refresh first"
      : current.protected ? "This container is protected from lifecycle actions"
      : job ? "An action is already in progress"
        : !stable ? `Actions unavailable while container is ${current.state}` : "";
  const primary = current?.state === "running" ? "restart" : "start";
  return [primary, "stop"].map((action) => ({
    label: job?.action === action ? `${verbs[action]}…` : `${action[0].toUpperCase()}${action.slice(1)} container`,
    icon: action === "start" ? "play" : action === "stop" ? "stop" : "refresh",
    danger: action !== "start",
    disabled: Boolean(reason) || (action === "stop" && current?.state !== "running"),
    hint: reason || (action === "stop" && current?.state !== "running" ? "Container is already stopped" : ""),
    run: () => runAction(current, action),
  }));
}

async function runAction(container, action) {
  if (!container || busy(container.id) || !state.docker.control?.enabled) return;
  const requestId = uid() + uid();
  const job = { action, requestId, phase: "confirming" };
  pending.set(container.id, job);
  changed();
  try {
    if (!(await ensureCanEdit())) return;
    if (action !== "start" && !(await ask({
      title: `${action === "stop" ? "Stop" : "Restart"} container?`,
      message: `${container.name}\n\nThis will interrupt the service. Docker gets 10 seconds to stop it gracefully before forcing it to stop.`,
      okLabel: action === "stop" ? "Stop container" : "Restart container", danger: true,
    }))) return;
    job.phase = "submitting";
    const result = await editApi("POST", "/api/docker/action", {
      id: container.id, action, requestId,
    }, { timeout: 20000 });
    if (!result) return;
    if (!result.res.ok) throw new Error(result.data.error || "Container action was rejected");
    job.phase = "working";
    // Reflect acceptance immediately, before other tabs/pollers can return a stale snapshot.
    state.docker.control.busy = [...(state.docker.control.busy || []).filter((item) => item.id !== container.id),
      { id: container.id, action, requestId }];
    toast(`${verbs[action]} ${container.name} — see action history`);
    await refreshActivity({ fresh: true });
  } catch (err) {
    if (job.phase === "submitting" && (err instanceof TypeError || /timed out|invalid response/i.test(err.message))) {
      job.phase = "checking";
      job.checkUntil = Date.now() + 30000;
      toast("Action outcome is not yet known. Checking history; the action will not be retried automatically.", true);
      await refreshActivity({ fresh: true });
    } else {
      toast(err.message, true);
      await refreshActivity({ fresh: true });
    }
  } finally {
    if (!["working", "checking"].includes(job.phase)) pending.delete(container.id);
    changed();
  }
}

export function initDockerControl() {
  document.addEventListener("activity-updated", ({ detail }) => {
    for (const [id, job] of pending) {
      if (!["working", "checking"].includes(job.phase)) continue;
      const entry = detail.entries.find((item) => item.id === job.requestId);
      if (entry && entry.status !== "pending") {
        pending.delete(id);
        toast(`${entry.title}: ${entry.message}`, entry.status !== "success");
      } else if (job.phase === "checking" && Date.now() >= job.checkUntil &&
          !entry && !detail.control.busy.some((item) => item.id === id)) {
        pending.delete(id);
        toast("No accepted action was found in history. Check container state before trying again.", true);
      }
    }
  });
}
