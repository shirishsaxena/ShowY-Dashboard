// Persistent server history; only the unread marker is a per-browser preference.
import { $, h, fill, svg, toast } from "./dom.js";
import { api, loadDocker, loadUsage } from "./api.js";
import { state, prefs, setPref } from "./state.js";
import { ensureCanEdit } from "./actions.js";
import { render } from "./render-interface.js";

let snapshot = { entries: [], limit: 200 };
let pending = null;
let timer;
let error = "";
const canRead = () => !state.locked && (!state.auth.passwordSet || state.auth.authenticated);
const latest = () => Math.max(0, ...snapshot.entries.map((entry) => entry.updatedAt));

function paint() {
  const unread = snapshot.entries.filter((entry) => entry.updatedAt > (prefs.activitySeen || 0)).length;
  $("#activityBadge").hidden = !unread || !canRead();
  $("#activityBtn").setAttribute("aria-label", unread && canRead()
    ? `Action history, ${unread} unread updates` : "Action history");
  if (!$("#activityDialog").open) return;
  $("#activityError").textContent = error || (snapshot.persistenceError ? "Some recent history could not be saved to disk. Check backend logs." : "");
  $("#activityError").hidden = !$("#activityError").textContent;
  fill($("#activityList"), snapshot.entries.length ? snapshot.entries.map((entry) => h("article", {
    class: `activity-entry activity-${entry.status}`,
  }, h("div", { class: "activity-entry-head" },
    svg(entry.status === "success" ? "check" : entry.status === "pending" ? "clock" : "warn"),
    h("strong", {}, entry.title)),
  h("div", { class: "activity-entry-meta" },
    h("span", {}, ({ pending: "In progress", success: "Completed", failed: "Failed", uncertain: "Check outcome" })[entry.status]),
    h("time", { datetime: new Date(entry.updatedAt).toISOString() }, new Date(entry.updatedAt).toLocaleString())),
  entry.message ? h("p", {}, entry.message) : null))
    : h("p", { class: "muted" }, "No actions recorded yet."));
}

function schedule() {
  clearTimeout(timer);
  if (document.hidden || !canRead()) return;
  timer = setTimeout(refreshActivity, snapshot.entries.some((entry) => entry.status === "pending") ? 2000 : 15000);
}

export function refreshActivity(options = {}) {
  if (!canRead()) {
    snapshot = { entries: [], limit: 200 };
    paint();
    return Promise.resolve(false);
  }
  if (pending) return options.fresh ? pending.then(() => refreshActivity()) : pending;
  const auth = state.auth;
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), 10000);
  pending = (async () => {
    const { res, data } = await api("GET", "/api/activity", undefined, controller.signal);
    if (auth !== state.auth || !canRead()) return false;
    if (res.status === 401) {
      state.auth.authenticated = false;
      snapshot = { entries: [], limit: 200 };
      error = "Login required to read action history.";
      return false;
    }
    if (!res.ok || !Array.isArray(data.entries)) throw new Error(data.error || "Action history unavailable");
    const oldBusy = state.docker.control?.busy || [];
    snapshot = data;
    state.docker.control = data.control;
    error = "";
    document.dispatchEvent(new CustomEvent("activity-updated", { detail: data }));
    document.dispatchEvent(new Event("docker-control-changed"));
    render();
    if (oldBusy.some((job) => !data.control.busy.some((current) => current.id === job.id))) {
      await Promise.all([loadDocker(), loadUsage(true)]);
      render();
      document.dispatchEvent(new Event("docker-control-changed"));
    }
    if ($("#activityDialog").open) setPref("activitySeen", latest());
    return true;
  })().catch((err) => {
    error = err.name === "AbortError" ? "Action history request timed out" : err.message;
    return false;
  }).finally(() => {
    clearTimeout(deadline);
    pending = null;
    paint();
    schedule();
  });
  return pending;
}

export function initActivity() {
  $("#activityBtn").addEventListener("click", async () => {
    if (!(await ensureCanEdit())) return;
    $("#activityDialog").showModal();
    setPref("activitySeen", latest());
    paint();
    await refreshActivity();
  });
  $("#activityRefresh").addEventListener("click", async () => {
    const button = $("#activityRefresh");
    button.disabled = true;
    button.classList.add("spin");
    try { if (!(await refreshActivity())) toast("Action history could not be refreshed", true); }
    finally { button.disabled = false; button.classList.remove("spin"); }
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) clearTimeout(timer);
    else refreshActivity();
  });
  document.addEventListener("config-saved", refreshActivity);
  document.addEventListener("activity-changed", () => {
    clearTimeout(timer);
    timer = setTimeout(refreshActivity, 0);
  });
  document.addEventListener("initial-load-settled", refreshActivity);
}
