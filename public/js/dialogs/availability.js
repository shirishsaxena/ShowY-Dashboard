// Outage history modal: timeline, outages and availability for the chosen period.
// Opened for this dashboard (clearable) or for a remote dashboard's server (read-only, data from that dashboard).

import { sourceOf } from '../state.js';
import { $, h, fill, toast } from '../dom.js';
import { api, fetchAvailability } from '../api.js';
import * as actions from '../actions.js';
import { plural, fmtDuration, fmtDateTime, fmtPercent } from '../utils.js';
import { ask } from './ask.js';

const PERIODS = [['day', '24 h'], ['week', '7 days'], ['month', '30 days'], ['all', 'All']];

const view = { detail: null, period: 'day', readOnly: false };

const tile = (label, value, level = '') => h('div', { class: 'avail-tile' }, h('b', { class: level }, value), h('span', { class: 'net-label' }, label));

function timeline(w, outages, now) {
  const span = Math.max(1, now - w.from);
  const marks = outages
    .map((o) => ({ a: Math.max(o.start, w.from), b: Math.min(o.end, now), o }))
    .filter((m) => m.b > m.a)
    .map(({ a, b, o }) =>
      h('span', {
        class: `avail-mark${o.kind === 'app' ? ' app' : ''}`,
        style: `left:${(((a - w.from) / span) * 100).toFixed(2)}%;width:max(3px,${(((b - a) / span) * 100).toFixed(2)}%)`,
        title: `${fmtDateTime(o.start)} → ${fmtDateTime(o.end)} (~${fmtDuration(o.end - o.start)})`,
      })
    );
  return h(
    'div',
    {},
    h('div', { class: 'avail-strip' }, marks),
    h('div', { class: 'avail-axis' }, h('span', {}, fmtDateTime(w.from)), h('span', {}, 'now'))
  );
}

function outageRow(o) {
  const app = o.kind === 'app';
  return h(
    'div',
    { class: 'avail-row' },
    h('span', { class: `dot ${app ? 'warn' : 'down'}` }),
    h(
      'div',
      { class: 'avail-when' },
      h('span', {}, app ? 'Dashboard stopped ' : 'Host down ', h('b', {}, `~ ${fmtDateTime(o.start)}`)),
      h('span', { class: 'muted' }, app ? 'Running again ' : 'Back up ', h('b', {}, fmtDateTime(o.end))),
      app && h('small', { class: 'muted' }, 'The host stayed up - not counted as downtime')
    ),
    h('b', { class: 'avail-len' }, `~${fmtDuration(o.end - o.start)}`)
  );
}

function renderModal() {
  const { detail, period, readOnly } = view;
  const w = detail.windows?.[period] || { from: detail.since, observed: 0, down: 0, count: 0, longest: 0, pct: null };
  const now = detail.now || Date.now();
  const outages = (detail.outages || []).filter((o) => o.end > w.from);
  const level = w.pct == null || w.pct >= 99 ? '' : w.pct >= 95 ? 'warn' : 'crit';

  fill(
    $('#availPeriod'),
    PERIODS.map(([key, label]) =>
      h('button', { type: 'button', 'aria-pressed': String(key === period), onclick: () => ((view.period = key), renderModal()) }, label)
    )
  );
  fill(
    $('#availSummary'),
    tile('Availability', fmtPercent(w.pct), level),
    tile('Total downtime', w.down ? `~${fmtDuration(w.down)}` : 'None'),
    tile('Longest outage', w.longest ? `~${fmtDuration(w.longest)}` : 'None'),
    tile('Outages', String(w.count))
  );
  $('#availObserved').textContent = detail.enabled
    ? `Observed ${fmtDuration(w.observed)} since ${fmtDateTime(w.from)}${period !== 'all' && w.from === detail.since ? ' (monitoring started)' : ''}.`
    : 'Outage tracking is off - no new outages are recorded.';
  fill($('#availTimeline'), timeline(w, outages, now));
  fill($('#availList'), outages.length ? outages.map(outageRow) : h('p', { class: 'muted avail-empty' }, 'No outages in this period.'));
  const clear = $('#availClear');
  clear.hidden = readOnly;
  clear.disabled = !detail.records;
}

function show(detail, readOnly) {
  Object.assign(view, { detail, readOnly });
  renderModal();
  const dialog = $('#availabilityDialog');
  if (!dialog.open) dialog.showModal();
}

/** server = the server whose card was used; a remote server shows what its dashboard reports. */
export async function openAvailability(server) {
  if (server?.remote) {
    const source = sourceOf(server);
    const detail = source.availability || { ...source.stats?.availability, outages: [] };
    return show(detail, true);
  }
  await openOwnAvailability();
}

export async function openOwnAvailability() {
  let detail = null;
  try {
    detail = await fetchAvailability();
  } catch {
    /* handled below */
  }
  if (!detail) return toast('Could not load the outage history', true);
  show(detail, false);
}

/** Asks first, then removes this dashboard's outage records. Resolves to the new history, or null if nothing was cleared. */
export async function clearOutageHistory(count) {
  if (!(await actions.ensureCanEdit())) return null;
  const ok = await ask({
    title: 'Clear outage history?',
    message: `This removes ${plural(count, 'record')} (outages and dashboard-only gaps). Availability goes back to 100% for the time monitored so far. It cannot be undone.`,
    okLabel: 'Clear history',
    danger: true,
  });
  if (!ok) return null;
  try {
    const { res, data } = await api('DELETE', '/api/availability', {});
    if (!res.ok) {
      toast(data.error || `Could not clear the history (${res.status})`, true);
      return null;
    }
    document.dispatchEvent(new CustomEvent('availability-changed'));
    toast('Outage history cleared');
    return data;
  } catch {
    toast('Dashboard server unreachable', true);
    return null;
  }
}

export function initAvailability() {
  $('#availClear').addEventListener('click', async () => {
    const detail = await clearOutageHistory(view.detail.records);
    if (!detail) return;
    view.detail = detail;
    renderModal();
  });
}
