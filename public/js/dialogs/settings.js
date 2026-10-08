// Settings dialog: title, accent colour, hidden containers, sharing, remote dashboards, export/import.

import { state } from '../state.js';
import { $, h, fill, toast, iconBtn, resetIconCache } from '../dom.js';
import * as actions from '../actions.js';
import { api, loadRemotes } from '../api.js';
import { render } from '../view/render.js';
import { plural, fmtBytes } from '../utils.js';
import { applyAccent, syncAccent, isHexColor, DEFAULT_ACCENT } from '../theme.js';
import { field, value } from './common.js';
import { ask } from './ask.js';
import { openOwnAvailability, clearOutageHistory } from './availability.js';
import { refreshClip } from '../clip.js';

const ACCENTS = ['#7c5cff', '#3b82f6', '#06b6d4', '#22c55e', '#f59e0b', '#f97316', '#f43f5e', '#ec4899'];
const draft = { accent: '', hidden: [] };

function pickAccent(color) {
  draft.accent = color.toLowerCase();
  applyAccent(draft.accent); // live preview; reverted on cancel
  for (const btn of $('#accentPicker').querySelectorAll('[data-color]')) {
    btn.setAttribute('aria-pressed', String(btn.dataset.color === draft.accent));
  }
  $('#accentCustom').classList.toggle('on', !ACCENTS.includes(draft.accent));
}

function renderAccentPicker() {
  fill(
    $('#accentPicker'),
    ACCENTS.map((color) =>
      h('button', { type: 'button', class: 'swatch', style: `--swatch:${color}`, 'data-color': color, title: color, 'aria-label': `Accent ${color}`, onclick: () => pickAccent(color) })
    ),
    h(
      'label',
      { class: 'swatch custom', id: 'accentCustom', title: 'Custom colour' },
      h('input', { type: 'color', value: draft.accent, 'aria-label': 'Custom accent colour', oninput: (e) => pickAccent(e.target.value) })
    )
  );
  pickAccent(draft.accent);
}

function renderHiddenList() {
  fill(
    $('#hiddenList'),
    draft.hidden.length
      ? draft.hidden.map((name) =>
          h(
            'span',
            { class: 'chip' },
            name,
            h(
              'button',
              {
                type: 'button',
                title: `Show ${name} again`,
                'aria-label': `Unhide ${name}`,
                onclick: () => {
                  draft.hidden = draft.hidden.filter((n) => n !== name);
                  renderHiddenList();
                },
              },
              '✕'
            )
          )
        )
      : h('span', { class: 'muted' }, 'None')
  );
}

async function showIconCache() {
  const info = $('#iconCacheInfo');
  info.textContent = '';
  try {
    const { res, data } = await api('GET', '/api/icons');
    if (res.ok) info.textContent = data.count ? `${plural(data.count, 'icon')} · ${fmtBytes(data.bytes)}` : 'Empty';
  } catch {
    /* offline - leave it blank */
  }
}

// ---------- Storage: size of the data folder, with a clear button for what can be emptied ----------

async function clearIcons() {
  if (!(await actions.ensureCanEdit())) return;
  try {
    const { res, data } = await api('DELETE', '/api/icons', {});
    if (!res.ok) return toast(data.error || `Could not clear the cache (${res.status})`, true);
    resetIconCache();
    render();
    toast(`Cleared ${plural(data.removed, 'icon')}`);
    showIconCache();
  } catch {
    toast('Dashboard server unreachable', true);
  }
}

async function clearOutages() {
  const data = await clearOutageHistory(avail?.records || 0);
  if (data) showAvailability(data);
}

const STORAGE_CLEAR = { icons: clearIcons, clip: clearClipHistory, availability: clearOutages };

async function showStorage() {
  try {
    const { res, data } = await api('GET', '/api/storage');
    if (!res.ok) return;
    $('#storageTotal').textContent = `${fmtBytes(data.total)} in total`;
    fill(
      $('#storageList'),
      data.items.map((item) =>
        h(
          'div',
          { class: 'storage-row' },
          h('span', { class: 'grow', title: item.file }, item.name),
          h('span', { class: 'size' }, fmtBytes(item.bytes)),
          STORAGE_CLEAR[item.clear]
            ? h('button', { type: 'button', class: 'btn ghost', onclick: async () => (await STORAGE_CLEAR[item.clear](), showStorage()) }, 'Clear')
            : h('span')
        )
      )
    );
  } catch {
    /* offline - leave it as it is */
  }
}

/** The settings dialog is split into tabs; only one panel shows at a time. */
function showTab(name) {
  for (const btn of $('#settingsTabs').querySelectorAll('[data-tab]')) btn.setAttribute('aria-pressed', String(btn.dataset.tab === name));
  for (const panel of document.querySelectorAll('#settingsDialog [data-panel]')) panel.hidden = panel.dataset.panel !== name;
  $('#settingsDialog .dialog-body').scrollTop = 0;
}

export function openSettings() {
  const form = $('#settingsForm');
  const { settings } = state.config;
  form.reset();
  showTab('general');
  showIconCache();
  showStorage();
  loadSharing();
  loadAvailability();
  loadServerInfoSettings();
  loadTunables();
  $('#clipMax').value = String(state.clip.max || 10);
  showClipInfo();
  field(form, 'title').value = settings.title;
  draft.accent = isHexColor(settings.accent) ? settings.accent.toLowerCase() : DEFAULT_ACCENT;
  draft.hidden = [...settings.hiddenContainers];
  renderAccentPicker();
  renderHiddenList();

  $('#appVersion').textContent = state.version ? `v${state.version}` : '';

  const { passwordSet, lockView } = state.auth;
  $('#securityInfo').textContent = passwordSet
    ? `On — ${lockView ? 'the whole dashboard is locked' : 'only editing is locked'}. Change it with DASHBOARD_PASSWORD / DASHBOARD_LOCK_VIEW in docker-compose.yml.`
    : 'Off — anyone who can reach this URL can view and edit. Set DASHBOARD_PASSWORD in docker-compose.yml to enable it.';

  const dialog = $('#settingsDialog');
  dialog.addEventListener('close', syncAccent, { once: true }); // drop an unsaved preview
  dialog.showModal();
}

// ---------- Shared clipboard limit and history (saved right away, in data/clipboard.json) ----------

function showClipInfo() {
  const count = (state.clip.entries || []).length;
  $('#clipInfo').textContent = count ? `${count} ${count === 1 ? 'entry' : 'entries'} stored` : 'Empty';
  $('#clipClearSettingsBtn').disabled = !count;
}

async function saveClipMax() {
  const select = $('#clipMax');
  const data = (await actions.ensureCanEdit()) && (await sharingApi('PUT', '/api/clip/settings', { max: Number(select.value) }));
  if (data) {
    state.clip = data;
    showClipInfo();
    toast('Clipboard limit saved');
  } else select.value = String(state.clip.max || 10); // not saved: back to the stored value
}

async function clearClipHistory() {
  if (!(await actions.ensureCanEdit())) return;
  const count = (state.clip.entries || []).length;
  const ok = await ask({ title: 'Clear clipboard history?', message: `${count} ${count === 1 ? 'entry' : 'entries'} will be removed for every device.`, okLabel: 'Clear', danger: true });
  if (!ok) return;
  const data = await sharingApi('DELETE', '/api/clip', {});
  if (!data) return;
  state.clip = data;
  showClipInfo();
  refreshClip();
  toast('Clipboard history cleared');
}

// ---------- Outage tracking (saved right away, in data/availability.json) ----------

let avail = null;

function showAvailability(data) {
  avail = data;
  $('#availEnabled').checked = data.enabled;
  $('#availInterval').value = String(data.interval);
  $('#availThreshold').value = String(data.threshold);
  $('#availInterval').disabled = $('#availThreshold').disabled = !data.enabled;
  const note = $('#availLimitNote');
  note.hidden = data.limit <= data.threshold;
  note.textContent = `Gaps shorter than ${data.limit} minutes are ignored: the threshold always stays above the heartbeat interval.`;
  $('#availInfo').textContent = plural(data.count, 'outage') + ' recorded';
  $('#availClearBtn').disabled = !data.records;
}

async function loadAvailability() {
  try {
    const { res, data } = await api('GET', '/api/availability');
    if (res.ok) showAvailability(data);
  } catch {
    /* offline - leave the controls as they are */
  }
}

async function saveAvailability() {
  const body = { enabled: $('#availEnabled').checked, interval: Number($('#availInterval').value), threshold: Number($('#availThreshold').value) };
  const data = (await actions.ensureCanEdit()) && (await sharingApi('PUT', '/api/availability/settings', body));
  if (!data) return avail && showAvailability(avail); // not saved: back to the stored values
  showAvailability(data);
  document.dispatchEvent(new CustomEvent('availability-changed'));
  toast('Outage tracking saved');
}

function initAvailabilitySettings() {
  for (const id of ['#availEnabled', '#availInterval', '#availThreshold']) $(id).addEventListener('change', saveAvailability);
  $('#availViewBtn').addEventListener('click', openOwnAvailability);
  $('#availClearBtn').addEventListener('click', async () => {
    await clearOutages();
    showStorage();
  });
}

// ---------- Server info: how the public IP is found (saved right away, in data/serverinfo.json) ----------

const PUBLIC_IP_HINTS = {
  off: 'Only a public address found on a network interface is shown (typical for a VPS).',
  lookup: 'Asks api.ipify.org (or PUBLIC_IP_URL) at most once an hour. Shows the result in the Server info panel.',
  manual: 'Shown as typed - nothing is looked up. Press Enter or leave the field to save it.',
};
let serverInfoSettings = { mode: 'off', manualIp: '' };

function showServerInfoSettings(data = serverInfoSettings) {
  serverInfoSettings = data;
  $('#publicIpMode').value = data.mode;
  $('#publicIpManual').value = data.manualIp;
  $('#publicIpManual').hidden = data.mode !== 'manual';
  $('#publicIpNote').textContent = PUBLIC_IP_HINTS[data.mode];
}

async function loadServerInfoSettings() {
  showServerInfoSettings({ mode: 'off', manualIp: '' });
  const data = await sharingApi('GET', '/api/info/settings');
  if (data) showServerInfoSettings(data);
}

async function saveServerInfoSettings() {
  const mode = $('#publicIpMode').value;
  const manualIp = $('#publicIpManual').value.trim();
  if (mode === 'manual' && !manualIp) {
    // Nothing to save yet: show the field and wait for the address.
    showServerInfoSettings({ ...serverInfoSettings, mode });
    return $('#publicIpManual').focus();
  }
  if (mode === 'manual' && manualIp === serverInfoSettings.manualIp && serverInfoSettings.mode === 'manual') return;
  const data = (await actions.ensureCanEdit()) && (await sharingApi('PUT', '/api/info/settings', { mode, manualIp }));
  if (!data) return showServerInfoSettings(); // not saved: back to the stored values
  showServerInfoSettings(data);
  toast('Public IP setting saved');
}

// ---------- Timing and limits (saved right away, in data/tunables.json; an env var in docker-compose locks a field) ----------

let tunableItems = [];

function tunableField(item) {
  const input = h('input', { type: 'number', min: item.min, max: item.max, step: 1, value: item.value, disabled: item.fixed, 'data-key': item.key, onchange: () => saveTunable(item, input) });
  const unit = item.unit ? ` ${item.unit}` : '';
  return h(
    'label',
    { class: 'field' },
    `${item.label}${item.unit ? ` (${item.unit})` : ''}`,
    input,
    h('small', {}, item.fixed ? `Set by ${item.env} in docker-compose.yml` : `${item.min}–${item.max}${unit} · default ${item.def} · ${item.env}`)
  );
}

function showTunables(items = tunableItems) {
  tunableItems = items;
  const groups = [...new Set(items.map((item) => item.group))];
  fill(
    $('#tunableList'),
    groups.map((group) =>
      h('div', { class: 'field set-group' }, h('h3', {}, group, ' ', h('span', { class: 'auto-badge' }, 'Saves automatically')), items.filter((item) => item.group === group).map(tunableField))
    )
  );
}

async function loadTunables() {
  const items = await sharingApi('GET', '/api/tunables');
  if (items) showTunables(items);
}

async function saveTunable(item, input) {
  const value = input.value.trim() === '' ? null : Number(input.value); // empty = back to the default
  const data = (await actions.ensureCanEdit()) && (await sharingApi('PUT', '/api/tunables', { values: { [item.key]: value } }));
  if (!data) return showTunables(); // not saved: back to the stored values
  showTunables(data.items);
  state.tunables = { ...state.tunables, ...data.client };
  document.dispatchEvent(new CustomEvent('tunables-changed'));
  toast(`${item.label} saved`);
}

// ---------- Remote dashboards: update interval (saved right away, in data/remotes.json) ----------

async function saveRemoteInterval() {
  const select = $('#remoteInterval');
  const data = (await actions.ensureCanEdit()) && (await sharingApi('PUT', '/api/remotes/interval', { interval: Number(select.value) }));
  if (!data) return (select.value = String(sharing.refreshInterval)); // not saved: back to the stored value
  showSharing(data);
  state.remotesInterval = data.refreshInterval;
  document.dispatchEvent(new CustomEvent('remotes-interval-changed'));
  toast('Update interval saved');
}

// ---------- Sharing and remote dashboards (saved right away, outside config.json) ----------

let sharing = { shareToken: '', refreshInterval: 10, remotes: [] }; // remotes: [{ id, name, url }] - tokens stay on the server

/** Calls a remote-settings endpoint; returns the data, or null after showing the error. */
async function sharingApi(method, url, body) {
  try {
    const { res, data } = await api(method, url, body);
    if (res.ok) return data;
    toast(res.status === 401 ? 'Login required' : data.error || `Failed (${res.status})`, true);
  } catch {
    toast('Dashboard server unreachable', true);
  }
  return null;
}

async function loadSharing() {
  showSharing({ shareToken: '', refreshInterval: state.remotesInterval, remotes: [] });
  const data = await sharingApi('GET', '/api/remotes/settings');
  if (data) showSharing(data);
}

function showSharing(data = sharing) {
  sharing = data;
  const on = Boolean(sharing.shareToken);
  $('#shareToken').value = sharing.shareToken;
  $('#shareCopyBtn').hidden = !on;
  $('#shareOffBtn').hidden = !on || sharing.shareFixed;
  $('#shareNewBtn').hidden = Boolean(sharing.shareFixed);
  $('#shareNewBtn').textContent = on ? 'New token' : 'Turn on';
  $('#shareFixedNote').hidden = !sharing.shareFixed;
  $('#remoteInterval').value = String(sharing.refreshInterval);
  $('#remoteInterval').disabled = Boolean(sharing.refreshFixed);
  $('#remoteIntervalNote').textContent = sharing.refreshFixed
    ? 'Set by REMOTE_REFRESH_INTERVAL in docker-compose - change it there.'
    : 'Saved right away. Can also be set with REMOTE_REFRESH_INTERVAL in docker-compose.';
  fill($('#remoteList'), sharing.remotes.length ? sharing.remotes.map(remoteRow) : h('span', { class: 'muted' }, 'None'));
}

function remoteRow(r) {
  const live = state.remotes.find((x) => x.id === r.id);
  const status = !live ? '' : live.ok ? 'Connected' : `Unreachable: ${live.error || 'no response'}`;
  return h(
    'div',
    { class: 'remote-row' },
    h('span', { class: `dot ${live ? (live.ok ? 'up' : 'down') : ''}`, title: status || null }),
    h('span', { class: 'remote-text' }, h('span', {}, r.name), h('small', { class: 'muted', title: status || null }, live?.ok ? r.url : status || r.url)),
    r.fixed
      ? h('small', { class: 'muted', title: 'Set by REMOTE_DASHBOARDS - edit it there' }, 'docker-compose')
      : iconBtn('trash', `Remove ${r.name}`, () => removeRemote(r), 'icon-btn sm danger')
  );
}

/** Existing remotes are sent without tokens; the server keeps theirs. docker-compose ones are not sent. */
async function saveRemotes(remotes, message) {
  const data = await sharingApi('PUT', '/api/remotes/settings', { remotes: remotes.filter((r) => !r.fixed) });
  if (!data) return false;
  showSharing(data);
  await loadRemotes();
  render();
  showSharing(); // with the new connection status
  toast(message);
  return true;
}

async function addRemote() {
  const name = $('#remoteName').value.trim();
  const url = $('#remoteUrl').value.trim();
  const token = $('#remoteToken').value.trim();
  if (!url || !token) return toast('Enter the other dashboard\'s URL and share token', true);
  if (await saveRemotes([...sharing.remotes, { name, url, token }], 'Remote dashboard added')) {
    for (const id of ['#remoteName', '#remoteUrl', '#remoteToken']) $(id).value = '';
  }
}

async function removeRemote(r) {
  const ok = await ask({ title: 'Remove remote dashboard?', message: `The servers of “${r.name}” will no longer show here.`, okLabel: 'Remove', danger: true });
  if (ok) await saveRemotes(sharing.remotes.filter((x) => x.id !== r.id), 'Remote dashboard removed');
}

async function setSharing(enabled) {
  if (sharing.shareToken) {
    const ok = await ask({
      title: enabled ? 'Create a new token?' : 'Turn sharing off?',
      message: 'Dashboards using the current token will stop showing this one until they get a new token.',
      okLabel: enabled ? 'New token' : 'Turn off',
      danger: true,
    });
    if (!ok) return;
  }
  const data = await sharingApi('PUT', '/api/share', { enabled });
  if (data) showSharing(data);
}

async function copyToken() {
  const box = $('#shareToken');
  try {
    await navigator.clipboard.writeText(box.value);
  } catch {
    // The Clipboard API needs HTTPS; on a plain-http LAN address fall back to the old way.
    box.select();
    if (!document.execCommand('copy')) return toast('Copy failed - select the token and copy it manually', true);
  }
  toast('Token copied');
}

function initSharing() {
  $('#shareCopyBtn').addEventListener('click', copyToken);
  $('#shareNewBtn').addEventListener('click', () => setSharing(true));
  $('#shareOffBtn').addEventListener('click', () => setSharing(false));
  $('#remoteAddBtn').addEventListener('click', addRemote);
  // Enter in the add-row adds the remote instead of submitting the whole Settings form.
  for (const id of ['#remoteName', '#remoteUrl', '#remoteToken']) {
    $(id).addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      addRemote();
    });
  }
}

export function initSettingsForm() {
  const form = $('#settingsForm');
  initSharing();
  initAvailabilitySettings();
  $('#settingsTabs').addEventListener('click', (e) => {
    const tab = e.target.closest('[data-tab]')?.dataset.tab;
    if (tab) showTab(tab);
  });
  $('#publicIpMode').addEventListener('change', saveServerInfoSettings);
  $('#publicIpManual').addEventListener('change', saveServerInfoSettings);
  $('#publicIpManual').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    saveServerInfoSettings();
  });
  $('#remoteInterval').addEventListener('change', saveRemoteInterval);
  $('#tunableList').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault(); // Enter saves the field instead of submitting the whole dialog
    e.target.blur();
  });
  $('#clipClearSettingsBtn').addEventListener('click', async () => {
    await clearClipHistory();
    showStorage();
  });
  $('#clipMax').addEventListener('change', saveClipMax);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const ok = await actions.saveSettings({
      title: value(form, 'title') || 'Home Lab',
      accent: draft.accent === DEFAULT_ACCENT ? '' : draft.accent,
      hiddenContainers: draft.hidden,
    });
    if (ok) $('#settingsDialog').close();
  });

  $('#clearIconsBtn').addEventListener('click', async () => {
    await clearIcons();
    showStorage();
  });

  $('#exportBtn').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(state.config, null, 2)], { type: 'application/json' });
    const a = h('a', { href: URL.createObjectURL(blob), download: `dashboard-${new Date().toISOString().slice(0, 10)}.json` });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });

  $('#importFile').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    let parsed;
    try {
      parsed = JSON.parse(await file.text());
    } catch {
      return toast('That file is not valid JSON', true);
    }
    if (await actions.importConfig(parsed)) $('#settingsDialog').close();
  });
}
