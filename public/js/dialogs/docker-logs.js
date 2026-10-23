// Snapshot logs are independent of dashboard polling and discarded on close.
import { $ } from "../dom.js";
import { editApi } from "../edit-api.js";
import { state } from "../state.js";

let target = null;
let pending = null;
let opener = null;

async function refreshLogs() {
  const dialog = $("#dockerLogsDialog");
  if (!target || !dialog.open) return;
  pending?.abort();
  const controller = new AbortController();
  pending = controller;
  const current = () => pending === controller && dialog.open && !state.locked;
  const refresh = $("#dockerLogsRefresh");
  const lines = $("#dockerLogsLines");
  const output = $("#dockerLogsOutput");
  const status = $("#dockerLogsStatus");
  const error = $("#dockerLogsError");
  refresh.disabled = lines.disabled = true;
  refresh.classList.add("spin");
  output.setAttribute("aria-busy", "true");
  output.textContent = "";
  status.textContent = "Loading log snapshot…";
  error.hidden = true;
  try {
    const result = await editApi("GET",
      `/api/docker/logs?id=${encodeURIComponent(target.id)}&tail=${lines.value}`,
      undefined, { signal: controller.signal, current, timeout: 20000 });
    if (!current()) return;
    if (!result) {
      status.textContent = "Log access cancelled. Refresh to try again.";
      return;
    }
    const { res, data } = result;
    if (!res.ok) throw new Error(data.error || `Could not load logs (${res.status})`);
    if (typeof data.text !== "string" || !Number.isFinite(data.fetchedAt))
      throw new Error("Invalid log response from dashboard server");
    output.textContent = data.text || "No log output available for this container.";
    output.scrollTop = 0;
    status.textContent = `Fetched ${new Date(data.fetchedAt).toLocaleTimeString()} · Up to ${data.tail} lines · Manual refresh only${data.truncated ? " · Response cut short at 1 MiB; some requested output is omitted" : ""}`;
  } catch (err) {
    if (!current()) return;
    status.textContent = "Log snapshot unavailable";
    error.textContent = err instanceof TypeError ? "Dashboard server unreachable" : err.message;
    error.hidden = false;
  } finally {
    if (pending === controller) {
      pending = null;
      refresh.disabled = lines.disabled = false;
      refresh.classList.remove("spin");
      output.setAttribute("aria-busy", "false");
    }
  }
}

export function openContainerLogs(container) {
  target = { id: container.id, name: container.name };
  opener = document.activeElement;
  $("#dockerLogsName").textContent = container.name;
  $("#dockerLogsLines").value = "250";
  const dialog = $("#dockerLogsDialog");
  if (!dialog.open) dialog.showModal();
  return refreshLogs();
}

export function initDockerLogs() {
  $("#dockerLogsRefresh").addEventListener("click", refreshLogs);
  $("#dockerLogsLines").addEventListener("change", refreshLogs);
  $("#dockerLogsDialog").addEventListener("close", () => {
    if ($("#dockerLogsDialog").open) return;
    pending?.abort();
    pending = null;
    target = null;
    $("#dockerLogsOutput").textContent = "";
    $("#dockerLogsStatus").textContent = "";
    $("#dockerLogsError").textContent = "";
    $("#dockerLogsName").textContent = "";
    const button = opener?.isConnected ? opener
      : [...document.querySelectorAll("[data-card-menu-key]")]
        .find((node) => node.dataset.cardMenuKey === opener?.dataset.cardMenuKey);
    button?.focus();
    opener = null;
  });
}
