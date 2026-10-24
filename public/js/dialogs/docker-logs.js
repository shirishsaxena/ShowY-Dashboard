// Snapshot logs are independent of dashboard polling and discarded on close.
import { $, h, fill, toast } from "../dom.js";
import { editApi } from "../edit-api.js";
import { state } from "../state.js";

let target = null;
let pending = null;
let opener = null;
let snapshot = null;

function showLines(output, text) {
  if (!text) {
    output.textContent = "No log output available for this container.";
    return;
  }
  const lines = text.split("\n");
  fill(
    output,
    lines.map((line, index) =>
      h(
        "span",
        { class: "docker-log-line" },
        h("span", {
          class: "docker-log-number",
          "data-line": index + 1,
          "aria-hidden": "true",
        }),
        h(
          "span",
          { class: "docker-log-text" },
          line + (index < lines.length - 1 ? "\n" : ""),
        ),
      ),
    ),
  );
}

function downloadLogs() {
  if (
    !snapshot?.text ||
    pending ||
    state.locked ||
    !$("#dockerLogsDialog").open
  )
    return;
  let url;
  try {
    const name =
      snapshot.name
        .replace(/[^a-zA-Z0-9_.-]/g, "-")
        .replace(/^[.-]+/, "")
        .slice(0, 80) || "container";
    const timestamp = new Date(snapshot.fetchedAt)
      .toISOString()
      .replace(/[:.]/g, "-");
    url = URL.createObjectURL(
      new Blob([snapshot.text], { type: "text/plain;charset=utf-8" }),
    );
    h("a", {
      href: url,
      download: `${name}-logs-${timestamp}${snapshot.truncated ? "-truncated" : ""}.txt`,
    }).click();
  } catch {
    toast("Could not download this log snapshot. Try again.", true);
  } finally {
    // Allow the browser to begin saving before releasing the blob URL.
    if (url) setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

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
  snapshot = null;
  $("#dockerLogsDownload").disabled = true;
  refresh.disabled = lines.disabled = true;
  refresh.classList.add("spin");
  output.setAttribute("aria-busy", "true");
  output.textContent = "";
  status.textContent = "Loading log snapshot…";
  error.hidden = true;
  try {
    const result = await editApi(
      "GET",
      `/api/docker/logs?id=${encodeURIComponent(target.id)}&tail=${lines.value}`,
      undefined,
      { signal: controller.signal, current, timeout: 20000 },
    );
    if (!current()) return;
    if (!result) {
      status.textContent = "Log access cancelled. Refresh to try again.";
      return;
    }
    const { res, data } = result;
    if (!res.ok)
      throw new Error(data.error || `Could not load logs (${res.status})`);
    if (typeof data.text !== "string" || !Number.isFinite(data.fetchedAt))
      throw new Error("Invalid log response from dashboard server");
    showLines(output, data.text);
    snapshot = {
      text: data.text,
      name: target.name,
      fetchedAt: data.fetchedAt,
      truncated: data.truncated,
    };
    $("#dockerLogsDownload").disabled = !data.text;
    status.textContent = `Fetched ${new Date(data.fetchedAt).toLocaleTimeString()} · Up to ${data.tail} lines · Manual refresh only${data.truncated ? " · Response cut short at 1 MiB; some requested output is omitted" : ""}`;
    // Keep multiline entries in their original order and reveal the newest output.
    output.scrollTop = output.scrollHeight;
  } catch (err) {
    if (!current()) return;
    status.textContent = "Log snapshot unavailable";
    error.textContent =
      err instanceof TypeError ? "Dashboard server unreachable" : err.message;
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
  $("#dockerLogsDownload").addEventListener("click", downloadLogs);
  $("#dockerLogsLines").addEventListener("change", refreshLogs);
  $("#dockerLogsDialog").addEventListener("close", () => {
    if ($("#dockerLogsDialog").open) return;
    pending?.abort();
    pending = null;
    target = null;
    snapshot = null;
    $("#dockerLogsDownload").disabled = true;
    $("#dockerLogsOutput").textContent = "";
    $("#dockerLogsStatus").textContent = "";
    $("#dockerLogsError").textContent = "";
    $("#dockerLogsName").textContent = "";
    const button = opener?.isConnected
      ? opener
      : [...document.querySelectorAll("[data-card-menu-key]")].find(
          (node) => node.dataset.cardMenuKey === opener?.dataset.cardMenuKey,
        );
    button?.focus();
    opener = null;
  });
}
