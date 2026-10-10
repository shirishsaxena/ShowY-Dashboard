// Entry point: wires up the page, loads data and keeps statuses fresh.

import { state, prefs, activeServer } from "./state.js";
import { $, toast } from "./dom.js";
import {
  logout,
  login,
  LockedError,
  loadAuth,
  loadConfig,
} from "./api.js";
import { render } from "./view/render.js";
import { setRenderer } from "./render-interface.js";
import { makeSortable } from "./sortable.js";
import { initDialogs } from "./dialogs/common.js";
import { openServiceEditor, initServiceForm } from "./dialogs/service.js";
import { openServerEditor, initServerForm } from "./dialogs/server.js";
import { openSettings, initSettingsForm } from "./dialogs/settings.js";
import { initLinkForm } from "./dialogs/link.js";
import { initAvailability } from "./dialogs/availability.js";
import { initNotes } from "./view/notes.js";
import { initClip } from "./clip.js";
import { startLoad } from "./loading.js";
import * as actions from "./actions.js";
import { refreshAll, startTimers } from "./refresh.js";
import {
  applyTheme,
  applyLayout,
  applyAccent,
  syncAccent,
} from "./theme.js";

// ---------- Top bar ----------

setRenderer(render);

async function toggleEdit() {
  if (!state.editing && !(await actions.ensureCanEdit())) return;
  state.editing = !state.editing;
  render();
}

function initTopbar() {
  $("#editBtn").addEventListener("click", toggleEdit);
  $("#refreshBtn").addEventListener("click", () =>
    refreshAll({ manual: true }),
  );
  $("#lockBtn").addEventListener("click", async () => {
    const button = $("#lockBtn");
    if (button.disabled) return;
    button.disabled = true;
    try {
      await logout();
      if (state.auth.lockView) return location.reload();
      state.editing = false;
      render();
      toast("Locked — editing needs the password again");
    } catch (err) {
      toast(
        err instanceof TypeError ? "Dashboard server unreachable" : err.message,
        true,
      );
    } finally {
      button.disabled = false;
    }
  });

  const search = $("#search");
  const setQuery = (q) => {
    state.query = q;
    render();
  };
  search.addEventListener("input", () => setQuery(search.value.trim()));
  document.addEventListener("keydown", (e) => {
    if (
      e.key === "/" &&
      !e.target.closest("input, textarea, select") &&
      !document.querySelector("dialog[open]")
    ) {
      e.preventDefault();
      search.focus();
    } else if (e.key === "Escape" && e.target === search) {
      search.value = "";
      setQuery("");
      search.blur();
    }
  });
}

/** Position a popover menu under its button, aligned to the button's left or right edge,
 *  and kept inside the screen (on a phone the button is not at the screen edge, so a wide menu would run off the left). */
function anchorMenu(menu, btn, side) {
  menu.addEventListener("toggle", (e) => {
    btn.setAttribute("aria-expanded", String(e.newState === "open"));
    if (e.newState !== "open") return;
    const r = btn.getBoundingClientRect();
    const top = r.bottom + 8;
    const left = side === "right" ? r.right - menu.offsetWidth : r.left;
    menu.style.top = `${top}px`;
    menu.style.left = `${Math.max(8, Math.min(left, innerWidth - menu.offsetWidth - 8))}px`;
    menu.style.maxHeight = `${Math.max(160, innerHeight - top - 8)}px`; // scrolls instead of running off the bottom
  });
}

function initEditDock() {
  $("#dockDone").addEventListener("click", toggleEdit);
  $("#dockAddService").addEventListener(
    "click",
    () => activeServer() && openServiceEditor(activeServer().id),
  );
  $("#dockAddGroup").addEventListener(
    "click",
    () => activeServer() && actions.addGroup(activeServer().id),
  );
  $("#dockAddServer").addEventListener("click", () => openServerEditor());
  $("#dockSettings").addEventListener("click", openSettings);
}

function initSortables() {
  const services = $("#services");
  // Cards: within and between groups.
  makeSortable(services, {
    item: ".card[data-id]",
    handle: ".card .drag-handle",
    list: ".grid[data-list]",
    onSort: (lists) =>
      actions.arrangeServices(
        activeServer().id,
        lists.map(({ list, ids }) => ({
          group: list.closest(".group").dataset.id,
          ids,
        })),
      ),
  });
  // Groups themselves.
  makeSortable(services, {
    item: ".group.named",
    handle: ".group-handle",
    onSort: ([{ ids }]) => actions.reorderGroups(activeServer().id, ids),
  });
  makeSortable($("#serverList"), {
    item: ".server-item[data-id]",
    handle: ".drag-handle",
    onSort: ([{ ids }]) => actions.reorderServers(ids),
  });
  makeSortable($("#favs"), {
    item: ".fav[data-id]",
    handle: ".drag-handle",
    onSort: ([{ ids }]) => actions.reorderFavorites(ids),
  });
  makeSortable($("#links"), {
    item: ".link-pill[data-id]",
    handle: ".drag-handle",
    list: ".link-list",
    onSort: ([{ ids }]) => actions.reorderLinks(ids),
  });
}

// ---------- Install as an app (PWA) ----------

function initPwa() {
  // Service workers (and the install prompt) need HTTPS or localhost.
  if ("serviceWorker" in navigator && window.isSecureContext) {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  }
  const installBtn = $("#installBtn");
  const standalone =
    matchMedia("(display-mode: standalone)").matches || navigator.standalone;
  $("#installHint").hidden = Boolean(standalone);

  let deferred = null;
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferred = e;
    installBtn.hidden = false;
    $("#installHint").hidden = true;
  });
  installBtn.addEventListener("click", async () => {
    $("#settingsDialog").close();
    if (!deferred) return;
    deferred.prompt();
    await deferred.userChoice;
    deferred = null;
    installBtn.hidden = true;
  });
  window.addEventListener("appinstalled", () => {
    installBtn.hidden = true;
    toast("Installed");
  });
}

// ---------- Lock screen ----------

function showLockScreen() {
  state.locked = true;
  state.editing = false;
  document.body.classList.remove("booting");
  document.body.classList.add("locked");
  $("#appShell").hidden = true;
  $("#appShell").inert = true;
  $("#bootScreen").hidden = true;
  $("#lockScreen").hidden = false;
  $("#summary").textContent = "Locked";
  $("#lockForm").elements.password.focus();
}

function initLockScreen() {
  $("#lockForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.target;
    const error = $("#lockError");
    const button = form.querySelector('button[type="submit"]');
    if (button.disabled) return;
    button.disabled = true;
    try {
      const msg = await login(form.elements.password.value);
      error.textContent = msg || "";
      error.hidden = !msg;
      if (msg) return;
      form.reset();
      await start();
    } catch {
      error.textContent = "Unable to connect. Please try again.";
      error.hidden = false;
    } finally {
      button.disabled = false;
    }
  });
}

// ---------- Start ----------

function showBoot(error = "") {
  document.body.classList.add("booting");
  document.body.classList.remove("locked");
  $("#appShell").hidden = true;
  $("#appShell").inert = true;
  $("#lockScreen").hidden = true;
  const screen = $("#bootScreen");
  screen.hidden = false;
  screen.setAttribute("aria-busy", String(!error));
  screen.classList.toggle("boot-error", Boolean(error));
  $(".boot-spinner", screen).hidden = Boolean(error);
  $("#bootTitle").textContent = error
    ? "Unable to load dashboard"
    : "Loading dashboard";
  $("#bootMessage").textContent = error || "Connecting to your dashboard.";
  $("#bootRetry").hidden = !error;
}

function revealDashboard() {
  if (
    state.locked ||
    (state.loading?.blocking && state.loading.stage !== "failed")
  )
    return;
  $("#appShell").hidden = false;
  $("#appShell").inert = false;
  $("#bootScreen").hidden = true;
  document.body.classList.remove("booting", "locked");
}

let starting = false;
let timersStarted = false;

async function start() {
  if (starting) return;
  starting = true;
  state.locked = true;
  showBoot();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    await loadAuth(controller.signal);
    await loadConfig(controller.signal);
    clearTimeout(timeout);
    state.locked = false;
    syncAccent();
    startLoad({ initial: true });
    render();
    $("#bootMessage").textContent = "Loading services and server information.";
    revealDashboard();
    if (!timersStarted) {
      startTimers();
      timersStarted = true;
    }
    await refreshAll();
  } catch (err) {
    if (err instanceof LockedError) return showLockScreen();
    state.locked = true;
    showBoot(
      controller.signal.aborted
        ? "The dashboard took too long to respond. Check your connection and retry."
        : err.message || "Check your connection and retry.",
    );
  } finally {
    clearTimeout(timeout);
    starting = false;
  }
}

async function init() {
  applyTheme();
  applyLayout();
  applyAccent(prefs.accent);
  initDialogs();
  initServiceForm();
  initServerForm();
  initSettingsForm();
  initLinkForm();
  initAvailability();
  initNotes();
  initClip();
  initTopbar();
  anchorMenu($("#serverMenu"), $("#serverBtn"), "left");
  anchorMenu($("#clipMenu"), $("#clipBtn"), "right");
  initEditDock();
  initSortables();
  initLockScreen();
  $("#bootRetry").onclick = start;
  document.addEventListener("initial-load-settled", revealDashboard);
  initPwa();
  await start();
}

init().catch((err) => {
  state.locked = true;
  showBoot(
    err.message || "Unable to initialize the dashboard. Reload to try again.",
  );
  $("#bootRetry").textContent = "Reload";
  $("#bootRetry").onclick = () => location.reload();
});
