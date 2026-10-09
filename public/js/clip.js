// Shared clipboard: paste text or a link on one device, open or copy it on another. Stored on the server.
// The box holds the newest entry; the list below it is the history (newest first).

import { state, prefs, setPref } from "./state.js";
import { loadClip } from "./api.js";
import { editApi } from "./edit-api.js";
import { $, h, fill, toast, iconBtn } from "./dom.js";
import { fmtDateTime } from "./utils.js";

const URL_RE = /https?:\/\/[^\s<>"']*[^\s<>"'.,;:!?)\]]/;
const PREVIEW_CHARS = 120;

let dirty = false; // the text box has unsaved typing - don't overwrite it
let listKey = ""; // what the history list currently shows, so unchanged polls don't rebuild it
const expanded = new Set(); // ids of entries shown in full
let confirmTimer = 0; // set while "Clear History" waits for its second click

function ago(ts) {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(ts).toLocaleDateString();
}

const isOpen = () => $("#clipMenu").matches(":popover-open");

/** Dot on the button when something was shared that this device hasn't looked at yet. */
function renderDot() {
  const { text, updatedAt } = state.clip;
  $("#clipBtn .badge-dot").hidden = !text || updatedAt <= prefs.clipSeen;
}

function markSeen() {
  setPref("clipSeen", state.clip.updatedAt);
  renderDot();
}

function syncButtons() {
  const text = $("#clipText").value;
  const link = text.match(URL_RE)?.[0];
  const open = $("#clipOpen");
  open.hidden = !link;
  if (link) open.href = link;
  $("#clipCopy").disabled = $("#clipClear").disabled = !text;
}

const entries = () => state.clip.entries || [];

function stopConfirm() {
  clearTimeout(confirmTimer);
  confirmTimer = 0;
  const btn = $("#clipClearAll");
  btn.textContent = "Clear History";
  btn.classList.remove("primary", "danger-fill");
  $("#clipClearCancel").hidden = true;
}

function entryRow(entry) {
  const long = entry.text.length > PREVIEW_CHARS || entry.text.includes("\n");
  const open = expanded.has(entry.id);
  const preview = open
    ? entry.text
    : entry.text.length > PREVIEW_CHARS
      ? `${entry.text.slice(0, PREVIEW_CHARS).trimEnd()}…`
      : entry.text;
  // Entry text only ever goes in as a text node (never HTML).
  const body = long
    ? h(
        "button",
        {
          type: "button",
          class: `clip-entry-text${open ? " open" : ""}`,
          "aria-expanded": String(open),
          title: open ? "Show less" : "Show all",
          onclick: () => {
            if (open) expanded.delete(entry.id);
            else expanded.add(entry.id);
            renderList(true);
          },
        },
        preview,
      )
    : h("div", { class: "clip-entry-text" }, preview);
  return h(
    "div",
    { class: "clip-entry" },
    body,
    h(
      "div",
      { class: "clip-entry-foot" },
      h(
        "span",
        {
          class: "clip-age",
          title: new Date(entry.createdAt).toLocaleString(),
        },
        fmtDateTime(entry.createdAt),
      ),
      h("span", { class: "grow" }),
      iconBtn("copy", "Copy this entry", () => copyText(entry.text)),
      iconBtn("trash", "Delete this entry", () => removeEntry(entry.id)),
    ),
  );
}

function renderList(force = false) {
  const list = entries();
  $("#clipCount").textContent = list.length
    ? `${list.length} / ${state.clip.max || 10}`
    : "";
  $("#clipClearAll").disabled = !list.length;
  if (!list.length) stopConfirm();
  const key = list.map((e) => e.id + (expanded.has(e.id) ? "+" : "")).join();
  if (!force && key === listKey) return;
  listKey = key;
  for (const id of expanded)
    if (!list.some((e) => e.id === id)) expanded.delete(id);
  const box = $("#clipList");
  const top = box.scrollTop;
  fill(box, list.map(entryRow));
  box.scrollTop = top;
  box.hidden = !list.length;
}

function showClip() {
  const { text, updatedAt } = state.clip;
  $("#clipText").value = text;
  $("#clipAge").textContent = text && updatedAt ? ago(updatedAt) : "";
  dirty = false;
  syncButtons();
  renderList();
}

/** Called with the other status refreshes. */
export async function refreshClip() {
  await loadClip();
  if (isOpen()) {
    if (!dirty) showClip();
    else renderList();
    markSeen();
  } else renderDot();
}

/** Sends a change to the server (asking for the login first when needed); true when it was saved. */
async function send(method, url, body) {
  try {
    const result = await editApi(method, url, body);
    if (!result) return false;
    const { res, data } = result;
    if (!res.ok) throw new Error(data.error || `Not saved (${res.status})`);
    state.clip = data;
    markSeen();
    return true;
  } catch (err) {
    toast(
      err instanceof TypeError ? "Dashboard server unreachable" : err.message,
      true,
    );
    return false;
  }
}

async function removeEntry(id) {
  if (!(await send("DELETE", "/api/clip/entry", { id }))) return;
  if (!dirty) showClip();
  else renderList();
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // The Clipboard API needs HTTPS; on a plain-http LAN address fall back to the old way.
    const focused = document.activeElement;
    const temp = h("textarea", {
      readonly: true,
      "aria-hidden": "true",
      style: "position:fixed;opacity:0;pointer-events:none",
    });
    temp.value = text;
    let ok = false;
    try {
      // A closed popover cannot host a selectable textarea; a modal must host it to avoid inertness.
      (
        document.querySelector("dialog[open]") ||
        (isOpen() ? $("#clipMenu") : document.body)
      ).append(temp);
      temp.select();
      ok = document.execCommand("copy");
    } catch {
      // Some browsers throw instead of returning false when copying is denied.
    } finally {
      temp.remove();
      focused?.focus({ preventScroll: true });
    }
    if (!ok)
      return toast("Copy failed - select the text and copy it manually", true);
  }
  toast("Copied");
}

export function initClip() {
  const menu = $("#clipMenu");
  const box = $("#clipText");

  menu.addEventListener("toggle", (e) => {
    if (e.newState !== "open") return;
    showClip();
    markSeen();
    refreshClip(); // pick up anything shared since the last refresh
  });
  box.addEventListener("input", () => {
    dirty = true;
    syncButtons();
  });
  box.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) $("#clipSave").click();
  });

  $("#clipSave").addEventListener("click", async () => {
    if (!box.value.trim()) return toast("Nothing to share");
    if (!(await send("PUT", "/api/clip", { text: box.value }))) return;
    showClip();
    toast("Shared - open the clipboard on another device");
    if (isOpen()) menu.hidePopover();
  });
  // Empties the box only; shared entries are removed from the history list.
  $("#clipClear").addEventListener("click", () => {
    box.value = "";
    dirty = true;
    syncButtons();
    box.focus();
  });
  $("#clipCopy").addEventListener("click", () => copyText(box.value));
  $("#clipOpen").addEventListener("click", () => menu.hidePopover());

  // Clear History asks first: the first click turns the button into "Confirm clear".
  $("#clipClearAll").addEventListener("click", async (e) => {
    if (!confirmTimer) {
      e.currentTarget.textContent = "Confirm clear";
      e.currentTarget.classList.add("primary", "danger-fill");
      $("#clipClearCancel").hidden = false;
      confirmTimer = setTimeout(stopConfirm, 5000);
      return;
    }
    stopConfirm();
    if (!(await send("DELETE", "/api/clip", {}))) return;
    expanded.clear();
    showClip();
    toast("Clipboard history cleared");
  });
  $("#clipClearCancel").addEventListener("click", stopConfirm);
  menu.addEventListener(
    "toggle",
    (e) => e.newState !== "open" && stopConfirm(),
  );
}
