// Host stats panel (CPU, memory, disks, network, uptime, sensors) for servers marked "This machine".

import { state, sourceOf } from '../state.js';
import { $, h, fill, svg } from '../dom.js';
import { fmtBytes, fmtUptime, fmtDuration, fmtDateTime, fmtPercent, plural } from '../utils.js';
import { openAvailability } from '../dialogs/availability.js';

// [warn, crit] in °C per sensor type
const TEMP_LIMITS = { cpu: [75, 90], disk: [55, 65], other: [70, 85] };
const SENSOR_ICONS = { cpu: 'cpu', disk: 'disk', other: 'chip' };
const SVG_NS = 'http://www.w3.org/2000/svg';

const usageLevel = (pct) => (pct >= 90 ? 'crit' : pct >= 70 ? 'warn' : 'ok');
const percent = (used, total) => (total > 0 ? Math.round((used / total) * 100) : 0);

function tempLevel(t) {
  const [warn, crit] = TEMP_LIMITS[t.kind] || TEMP_LIMITS.other;
  return t.temp >= crit ? 'crit' : t.temp >= warn ? 'warn' : 'ok';
}

/** Ring gauge with the percentage in the middle. */
function gauge(pct) {
  const ring = document.createElementNS(SVG_NS, 'svg');
  ring.setAttribute('viewBox', '0 0 36 36');
  ring.setAttribute('aria-hidden', 'true');
  for (const cls of ['track', 'value']) {
    const c = document.createElementNS(SVG_NS, 'circle');
    c.setAttribute('class', cls);
    c.setAttribute('cx', '18');
    c.setAttribute('cy', '18');
    c.setAttribute('r', '15.5');
    c.setAttribute('pathLength', '100');
    ring.append(c);
  }
  ring.lastChild.setAttribute('stroke-dasharray', `${Math.min(100, Math.max(0, pct))} 100`);
  return h('div', { class: `gauge ${usageLevel(pct)}` }, ring, h('span', {}, `${Math.round(pct)}%`));
}

const badge = (icon) => h('div', { class: 'gauge badge' }, svg(icon));

/** One column of the System card: gauge/icon, label, short value lines; details on hover. */
function metric(visual, label, lines, title) {
  return h(
    'div',
    { class: 'metric', title },
    visual,
    h('span', { class: 'metric-label' }, label),
    lines.map((line) => h('span', { class: 'metric-sub' }, line))
  );
}

function systemCard(s) {
  const { used, total } = s.mem;
  return h(
    'div',
    { class: 'stat-card system' },
    metric(gauge(s.cpu), 'CPU', [`${s.cores} cores`], [s.cpuModel, s.load[0] ? `load ${s.load.join(' / ')}` : ''].filter(Boolean).join(' · ')),
    metric(gauge(percent(used, total)), 'Memory', [`${fmtBytes(used)} / ${fmtBytes(total)}`], `${fmtBytes(total - used)} free`),
    s.disks.map((d) => metric(gauge(percent(d.used, d.total)), d.label, [`${fmtBytes(d.used)} / ${fmtBytes(d.total)}`], `${fmtBytes(d.total - d.used)} free`)),
    metric(badge('clock'), 'Uptime', [fmtUptime(s.uptime)], 'since last boot')
  );
}

// ---------- Network ----------

// Recent speeds for the graph and peaks, per machine (this one or a remote dashboard's);
// kept in the page, so they start fresh on reload.
const NET_HISTORY = 40;
const histories = new Map(); // source key -> { last, points: [{ rx, tx, at }] }

function recordNet(key, s) {
  let hist = histories.get(key);
  if (!hist) histories.set(key, (hist = { last: null, points: [] }));
  if (s === hist.last) return hist.points; // render() also runs between polls
  hist.last = s;
  hist.points.push({ rx: s.net.rxRate, tx: s.net.txRate, at: Date.now() });
  if (hist.points.length > NET_HISTORY) hist.points.shift();
  return hist.points;
}

/** Download as a filled area, upload as a line, both scaled to the highest recent speed. */
function sparkline(points) {
  const el = document.createElementNS(SVG_NS, 'svg');
  el.setAttribute('viewBox', '0 0 100 30');
  el.setAttribute('preserveAspectRatio', 'none');
  el.setAttribute('aria-hidden', 'true');
  const max = Math.max(1, ...points.flatMap((p) => [p.rx, p.tx]));
  const last = Math.max(1, points.length - 1);
  const coords = (key) => points.map((p, i) => `${((i / last) * 100).toFixed(1)},${(29 - (p[key] / max) * 27).toFixed(1)}`);
  const add = (tag, attrs) => {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    el.append(node);
  };
  const rx = coords('rx');
  add('path', { class: 'area', d: `M0,30 L${rx.join(' L')} L${rx.at(-1).split(',')[0]},30 Z` });
  add('polyline', { class: 'rx', points: rx.join(' ') });
  add('polyline', { class: 'tx', points: coords('tx').join(' ') });
  return el;
}

function speed(dir, label, rate, peak) {
  return h(
    'div',
    { class: `net-speed ${dir}` },
    h('span', { class: 'net-label' }, dir === 'rx' ? '↓ ' : '↑ ', label),
    h('b', {}, `${fmtBytes(rate)}/s`),
    h('span', { class: 'net-note' }, `peak ${fmtBytes(peak)}/s`)
  );
}

function networkCard(net, interval, points) {
  const peak = (key) => Math.max(0, ...points.map((p) => p[key]));
  const secs = Math.max(interval || 5, Math.round((points.at(-1).at - points[0].at) / 1000));
  const span = secs >= 120 ? `${Math.round(secs / 60)} min` : `${secs} s`;
  return h(
    'div',
    { class: 'stat-card network' },
    h(
      'div',
      { class: 'net-head' },
      h('span', { class: 'metric-label' }, 'Network'),
      h('span', { class: 'net-note', title: 'Network interfaces' }, net.ifaces.join(', '))
    ),
    h('div', { class: 'net-speeds' }, speed('rx', 'Download', net.rxRate, peak('rx')), speed('tx', 'Upload', net.txRate, peak('tx'))),
    h('div', { class: 'net-graph', title: `Last ${span}` }, sparkline(points)),
    h('span', { class: 'net-note' }, `Since boot  ↓ ${fmtBytes(net.rx)}  ↑ ${fmtBytes(net.tx)}`)
  );
}

// ---------- Availability ----------

const PERIODS = [['24 h', 'day'], ['7 d', 'week'], ['30 d', 'month']];
const pctLevel = (pct) => (pct == null || pct >= 99 ? '' : pct >= 95 ? 'warn' : 'crit');

/** Approximate availability from heartbeat gaps (see lib/availability.js); `a` comes from this or a remote dashboard. */
function availabilityCard(s, server) {
  const a = s.availability;
  const { count = 0, last } = a;
  const notes = [];
  if (a.enabled) {
    notes.push(count && last ? `${plural(count, 'outage')} · last ${fmtDateTime(last.start)} (~${fmtDuration(last.end - last.start)})` : 'No outages recorded');
    if (a.windows?.month?.observed < 30 * 86400_000 - 3600_000) notes.push(`Monitored since ${fmtDateTime(a.since)}`);
  } else {
    notes.push('Outage tracking is off');
  }
  return h(
    'div',
    { class: 'stat-card availability' },
    h(
      'div',
      { class: 'net-head' },
      h('span', { class: 'metric-label', title: 'Estimated from gaps between saved heartbeats, using the host\'s boot time to tell a host outage from a dashboard restart' }, 'Availability (est.)'),
      h('span', { class: 'net-note', title: 'Host uptime' }, `up ${fmtUptime(s.uptime)}`)
    ),
    a.enabled &&
      h(
        'div',
        { class: 'avail-pcts' },
        PERIODS.map(([label, key]) => {
          const w = a.windows?.[key] || {};
          return h(
            'div',
            { class: `avail-pct ${pctLevel(w.pct)}`, title: w.observed ? `Observed for ${fmtDuration(w.observed)}` : 'Not enough data yet' },
            h('b', {}, fmtPercent(w.pct)),
            h('span', { class: 'net-label' }, label)
          );
        })
      ),
    notes.map((n) => h('span', { class: 'avail-note' }, n)),
    h('button', { type: 'button', class: 'btn sm ghost', onclick: () => openAvailability(server) }, 'View history')
  );
}

// ---------- Sensors ----------
function sensorRow(icon, name, value, level = '', title = null) {
  return h('div', { class: 'sensor', title }, svg(icon), h('span', { class: 'sensor-name' }, name), h('b', { class: level }, value));
}

function sensorsCard({ temps = [], fans = [] }) {
  return h(
    'div',
    { class: 'stat-card sensors' },
    h('span', { class: 'metric-label' }, 'Sensors'),
    temps.map((t) => sensorRow(SENSOR_ICONS[t.kind] || 'chip', t.name, `${t.temp}°C`, tempLevel(t), [t.name, t.detail].filter(Boolean).join(' — '))),
    fans.map((f) => sensorRow('fan', f.name, `${f.rpm} rpm`))
  );
}

const disclosureOpen = new Map();

export function renderStats(server) {
  const section = $('#stats');
  // Snapshot the live property before replacement; toggle events may still be queued.
  const previous = section.querySelector('details.stats-details');
  if (previous) disclosureOpen.set(previous.dataset.statsKey, previous.open);
  const focused = previous?.contains(document.activeElement) ? document.activeElement.tagName.toLowerCase() : null;
  const s = sourceOf(server).stats;
  if (!server?.local || state.query || !s) {
    section.hidden = true;
    return;
  }
  const points = s.net ? recordNet(server.remote || '', s) : null;
  const key = JSON.stringify([server.remote || '', server.id]);
  const cards = [
    s.net ? networkCard(s.net, s.interval, points) : null,
    s.availability ? availabilityCard(s, server) : null,
    s.temps?.length || s.fans?.length ? sensorsCard(s) : null,
  ].filter(Boolean);
  const labels = [s.net && 'Network', s.availability && 'availability', (s.temps?.length || s.fans?.length) && 'sensors'].filter(Boolean);
  fill(
    section,
    systemCard(s),
    cards.length ? h(
      'details',
      { class: 'stats-details', 'data-stats-key': key, open: disclosureOpen.get(key) ?? !window.matchMedia('(max-width: 720px)').matches },
      h('summary', {}, labels.join(', ')),
      h('div', { class: 'stats-details-content' }, cards)
    ) : null
  );
  section.hidden = false;
  if (previous?.dataset.statsKey === key && (focused === 'summary' || focused === 'button')) {
    section.querySelector(`.stats-details ${focused}`)?.focus({ preventScroll: true });
  }
}
