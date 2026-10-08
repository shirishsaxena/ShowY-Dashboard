// Entry point: wires up the page, loads data and keeps statuses fresh.

import { state, prefs, activeServer } from './state.js';
import { $, h, fill, svg, toast } from './dom.js';
import { logout, login, LockedError, loadAuth, loadConfig, loadDocker, loadHealth, loadStats, loadUsage, loadRemotes } from './api.js';
import { render, requestRender } from './view/render.js';
import { renderStats } from './view/stats.js';
import { makeSortable } from './sortable.js';
import { initDialogs } from './dialogs/common.js';
import { openServiceEditor, initServiceForm } from './dialogs/service.js';
import { openServerEditor, initServerForm } from './dialogs/server.js';
import { openSettings, initSettingsForm } from './dialogs/settings.js';
import { initLinkForm } from './dialogs/link.js';
import { initAvailability } from './dialogs/availability.js';
import { tickAgo } from './view/server.js';
import { initNotes } from './view/notes.js';
import { initClip, refreshClip } from './clip.js';
import { startLoad, loaded } from './loading.js';
import * as actions from './actions.js';
import { applyTheme, applyLayout, applyAccent, setTheme, setLayout, syncAccent, THEMES, LAYOUTS } from './theme.js';

// ---------- Data refresh ----------

const hasLocalServer = () => state.config.servers.some((s) => s.local);
const canRefresh = () => !state.locked && !document.hidden;

/** Coalesce background updates, preserving active drag operations. */
const rerender = () => requestRender();

async function refreshDocker() {
  if (!canRefresh() || !hasLocalServer()) return;
  await loadDocker();
  rerender();
}

async function refreshHealth(fresh = false) {
  if (!canRefresh()) return;
  await loadHealth(fresh);
  rerender();
}

/** Remote dashboards: their servers, statuses and stats in one request. */
async function refreshRemotes(fresh = '') {
  if (!canRefresh()) return;
  const had = state.remotes.length;
  const first = !state.remotesReady;
  await loadRemotes(fresh);
  state.remotesReady = true;
  if (state.remotesInterval !== scheduledEvery) scheduleRemotes(); // the interval was changed (Settings / docker-compose)
  if (first || had || state.remotes.length) rerender();
}

/** Polls remotes at a fixed rate (REMOTE_REFRESH_INTERVAL / Settings); the next run is planned before this one starts. */
let remotesTimer;
let scheduledEvery = 0;
function scheduleRemotes() {
  clearTimeout(remotesTimer);
  scheduledEvery = state.remotesInterval;
  remotesTimer = setTimeout(() => {
    scheduleRemotes();
    refreshRemotes();
  }, scheduledEvery * 1000);
}

/** Stats only update their own panel, so they never interrupt editing or dragging.
 *  The interval comes from HOST_STATS_INTERVAL on the server. */
let statsTimer;
async function refreshStats() {
  if (canRefresh() && !state.query && activeServer()?.local && !activeServer().remote) {
    await loadStats();
    if (!state.loading?.blocking) renderStats(activeServer()); // while loading, the loading panel is all that shows
  }
  clearTimeout(statsTimer);
  const secs = state.stats?.interval ?? 5;
  if (secs > 0) statsTimer = setTimeout(refreshStats, secs * 1000);
}

/** Container CPU / memory / network; the interval comes from CONTAINER_STATS_INTERVAL on the server. */
let usageTimer;
async function refreshUsage(fresh = false) {
  if (canRefresh() && hasLocalServer()) {
    await loadUsage(fresh);
    rerender();
  }
  clearTimeout(usageTimer);
  if (state.usage.interval > 0) usageTimer = setTimeout(refreshUsage, state.usage.interval * 1000);
}

async function refreshAll({ manual = false } = {}) {
  const btn = $('#refreshBtn');
  btn.classList.add('spin');
  // Viewing a remote dashboard's server: the manual refresh fetches that dashboard fresh, showing its loading state.
  const remoteId = manual ? activeServer()?.remote || '' : '';
  const reload = remoteId ? startLoad({ fresh: true }) : null;
  if (reload) render();
  // Each source re-renders as soon as it arrives; health checks can take a few seconds.
  const everything = Promise.all([
    hasLocalServer() && loadDocker().then(() => (loaded('services'), rerender())),
    refreshStats().then(() => loaded('info')),
    refreshUsage(manual && !remoteId),
    loadHealth(manual && !remoteId).then(rerender),
    reload || refreshRemotes(),
    refreshClip(),
  ]);
  // On a remote server only that remote matters: don't keep the button spinning for this machine's slower checks.
  await (remoteId ? reload : everything);
  btn.classList.remove('spin');
  if (manual) {
    const remote = remoteId && state.remotes.find((r) => r.id === remoteId);
    const dockerDown = hasLocalServer() && !state.docker.available;
    const failure = state.loading?.stage === 'failed' ? state.loading.error : '';
    if (remote && (failure || !remote.ok)) toast(`Could not reach ${remote.name}: ${failure || remote.error}`, true);
    else if (remote) toast(`${remote.name} refreshed`);
    else toast(dockerDown ? state.docker.error : 'Status refreshed', dockerDown);
  }
}

/** Runs fn every state.tunables[key] seconds (Settings / docker-compose); the returned function re-plans after that setting changed. */
function every(key, fn) {
  let timer;
  const plan = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      plan();
      fn();
    }, state.tunables[key] * 1000);
  };
  plan();
  return plan;
}

function startTimers() {
  const plans = [every('dockerRefresh', refreshDocker), every('healthRefresh', refreshHealth), every('healthRefresh', () => canRefresh() && refreshClip())];
  document.addEventListener('tunables-changed', () => plans.forEach((plan) => plan()));
  setInterval(tickAgo, 1000);
  scheduleRemotes();
  document.addEventListener('visibilitychange', () => !document.hidden && !state.locked && refreshAll());
  document.addEventListener('config-saved', () => refreshHealth());
  document.addEventListener('server-selected', refreshStats);
  document.addEventListener('availability-changed', refreshStats);
  document.addEventListener('remotes-interval-changed', scheduleRemotes);
}

// ---------- Top bar ----------

async function toggleEdit() {
  if (!state.editing && !(await actions.ensureCanEdit())) return;
  state.editing = !state.editing;
  render();
}

function initTopbar() {
  $('#editBtn').addEventListener('click', toggleEdit);
  $('#refreshBtn').addEventListener('click', () => refreshAll({ manual: true }));
  $('#lockBtn').addEventListener('click', async () => {
    await logout();
    if (state.auth.lockView) return location.reload();
    state.editing = false;
    render();
    toast('Locked — editing needs the password again');
  });

  const search = $('#search');
  const setQuery = (q) => {
    state.query = q;
    render();
  };
  search.addEventListener('input', () => setQuery(search.value.trim()));
  document.addEventListener('keydown', (e) => {
    if (e.key === '/' && !e.target.closest('input, textarea, select') && !document.querySelector('dialog[open]')) {
      e.preventDefault();
      search.focus();
    } else if (e.key === 'Escape' && e.target === search) {
      search.value = '';
      setQuery('');
      search.blur();
    }
  });
}

/** Segmented control: options = [[value, icon, label]]. */
function segmented(el, options, current, onPick) {
  fill(
    el,
    options.map(([value, icon, label]) =>
      h(
        'button',
        {
          type: 'button',
          'aria-pressed': String(value === current),
          onclick: () => {
            onPick(value);
            segmented(el, options, value, onPick);
          },
        },
        svg(icon),
        label
      )
    )
  );
}

function initViewMenu() {
  const menu = $('#viewMenu');
  const btn = $('#viewBtn');
  const layout = LAYOUTS.includes(prefs.layout) ? prefs.layout : 'cards';
  const theme = THEMES.includes(prefs.theme) ? prefs.theme : 'auto';
  segmented($('#layoutSeg'), [['cards', 'cards', 'Cards'], ['compact', 'compact', 'Compact'], ['list', 'list', 'List']], layout, setLayout);
  segmented($('#themeSeg'), [['auto', 'auto', 'Auto'], ['light', 'sun', 'Light'], ['dark', 'moon', 'Dark']], theme, setTheme);

  // Anchor the popover under its button.
  anchorMenu(menu, btn, 'right');
}

/** Position a popover menu under its button, aligned to the button's left or right edge,
 *  and kept inside the screen (on a phone the button is not at the screen edge, so a wide menu would run off the left). */
function anchorMenu(menu, btn, side) {
  menu.addEventListener('toggle', (e) => {
    btn.setAttribute('aria-expanded', String(e.newState === 'open'));
    if (e.newState !== 'open') return;
    const r = btn.getBoundingClientRect();
    const top = r.bottom + 8;
    const left = side === 'right' ? r.right - menu.offsetWidth : r.left;
    menu.style.top = `${top}px`;
    menu.style.left = `${Math.max(8, Math.min(left, innerWidth - menu.offsetWidth - 8))}px`;
    menu.style.maxHeight = `${Math.max(160, innerHeight - top - 8)}px`; // scrolls instead of running off the bottom
  });
}

function initEditDock() {
  $('#dockDone').addEventListener('click', toggleEdit);
  $('#dockAddService').addEventListener('click', () => activeServer() && openServiceEditor(activeServer().id));
  $('#dockAddGroup').addEventListener('click', () => activeServer() && actions.addGroup(activeServer().id));
  $('#dockAddServer').addEventListener('click', () => openServerEditor());
  $('#dockSettings').addEventListener('click', openSettings);
}

function initSortables() {
  const services = $('#services');
  // Cards: within and between groups.
  makeSortable(services, {
    item: '.card[data-id]',
    handle: '.card .drag-handle',
    list: '.grid[data-list]',
    onSort: (lists) =>
      actions.arrangeServices(
        activeServer().id,
        lists.map(({ list, ids }) => ({ group: list.closest('.group').dataset.id, ids }))
      ),
  });
  // Groups themselves.
  makeSortable(services, { item: '.group.named', handle: '.group-handle', onSort: ([{ ids }]) => actions.reorderGroups(activeServer().id, ids) });
  makeSortable($('#serverList'), { item: '.server-item[data-id]', handle: '.drag-handle', onSort: ([{ ids }]) => actions.reorderServers(ids) });
  makeSortable($('#favs'), { item: '.fav[data-id]', handle: '.drag-handle', onSort: ([{ ids }]) => actions.reorderFavorites(ids) });
  makeSortable($('#links'), { item: '.link-pill[data-id]', handle: '.drag-handle', list: '.link-list', onSort: ([{ ids }]) => actions.reorderLinks(ids) });
}

// ---------- Install as an app (PWA) ----------

function initPwa() {
  // Service workers (and the install prompt) need HTTPS or localhost.
  if ('serviceWorker' in navigator && window.isSecureContext) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
  const installBtn = $('#installBtn');
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  $('#installHint').hidden = Boolean(standalone);

  let deferred = null;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e;
    installBtn.hidden = false;
    $('#installHint').hidden = true;
  });
  installBtn.addEventListener('click', async () => {
    $('#viewMenu').hidePopover();
    if (!deferred) return;
    deferred.prompt();
    await deferred.userChoice;
    deferred = null;
    installBtn.hidden = true;
  });
  window.addEventListener('appinstalled', () => {
    installBtn.hidden = true;
    toast('Installed');
  });
}

// ---------- Lock screen ----------

function showLockScreen() {
  state.locked = true;
  state.editing = false;
  document.body.classList.remove('booting');
  document.body.classList.add('locked');
  $('#appShell').hidden = true;
  $('#appShell').inert = true;
  $('#bootScreen').hidden = true;
  $('#lockScreen').hidden = false;
  $('#summary').textContent = 'Locked';
  $('#lockForm').elements.password.focus();
}

function initLockScreen() {
  $('#lockForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const error = $('#lockError');
    const button = form.querySelector('button[type="submit"]');
    if (button.disabled) return;
    button.disabled = true;
    try {
      const msg = await login(form.elements.password.value);
      error.textContent = msg || '';
      error.hidden = !msg;
      if (msg) return;
      form.reset();
      await start();
    } catch {
      error.textContent = 'Unable to connect. Please try again.';
      error.hidden = false;
    } finally {
      button.disabled = false;
    }
  });
}

// ---------- Start ----------

function showBoot(error = '') {
  document.body.classList.add('booting');
  document.body.classList.remove('locked');
  $('#appShell').hidden = true;
  $('#appShell').inert = true;
  $('#lockScreen').hidden = true;
  const screen = $('#bootScreen');
  screen.hidden = false;
  screen.setAttribute('aria-busy', String(!error));
  screen.classList.toggle('boot-error', Boolean(error));
  $('.boot-spinner', screen).hidden = Boolean(error);
  $('#bootTitle').textContent = error ? 'Unable to load dashboard' : 'Loading dashboard';
  $('#bootMessage').textContent = error || 'Connecting to your dashboard.';
  $('#bootRetry').hidden = !error;
}

function revealDashboard() {
  if (state.locked || (state.loading?.blocking && state.loading.stage !== 'failed')) return;
  $('#appShell').hidden = false;
  $('#appShell').inert = false;
  $('#bootScreen').hidden = true;
  document.body.classList.remove('booting', 'locked');
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
    $('#bootMessage').textContent = 'Loading services and server information.';
    revealDashboard();
    if (!timersStarted) {
      startTimers();
      timersStarted = true;
    }
    await refreshAll();
  } catch (err) {
    if (err instanceof LockedError) return showLockScreen();
    state.locked = true;
    showBoot(controller.signal.aborted ? 'The dashboard took too long to respond. Check your connection and retry.' : err.message || 'Check your connection and retry.');
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
  initViewMenu();
  anchorMenu($('#serverMenu'), $('#serverBtn'), 'left');
  anchorMenu($('#clipMenu'), $('#clipBtn'), 'right');
  initEditDock();
  initSortables();
  initLockScreen();
  $('#bootRetry').onclick = start;
  document.addEventListener('initial-load-settled', revealDashboard);
  initPwa();
  await start();
}

init().catch((err) => {
  state.locked = true;
  showBoot(err.message || 'Unable to initialize the dashboard. Reload to try again.');
  $('#bootRetry').textContent = 'Reload';
  $('#bootRetry').onclick = () => location.reload();
});
