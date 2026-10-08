// Server info modal: system, network and Docker details of a machine, without SSH.
// This dashboard's machine comes from /api/info; a remote dashboard's machine is fetched through this server.

import { $, h, fill, svg } from '../dom.js';
import { api } from '../api.js';
import { copyText } from '../clip.js';
import { fmtUptime } from '../utils.js';

const NA = 'Not available';

let current = null; // the server being shown, for Retry
let request = 0; // ignores a reply that arrives after the modal was reopened for another server

const text = (v) => (v == null || v === '' ? '' : String(v));

/** One label + value row. `values` may be several lines (each { text, note, copy }); empty -> "Not available". */
function row(label, values, hint = '') {
  const list = (Array.isArray(values) ? values : [values]).filter((v) => text(v?.text ?? v));
  return h(
    'div',
    { class: 'info-row' },
    h('span', { class: 'metric-label' }, label),
    h(
      'div',
      { class: 'info-values' },
      list.length
        ? list.map((v) => {
            const item = typeof v === 'object' ? v : { text: v };
            return h(
              'div',
              { class: 'info-value' },
              h('span', { class: 'info-text' }, item.text, item.note ? h('small', { class: 'muted' }, ` ${item.note}`) : null),
              item.copy ? h('button', { type: 'button', class: 'icon-btn sm', title: `Copy ${item.copy}`, 'aria-label': `Copy ${item.copy}`, onclick: () => copyText(item.text) }, svg('copy')) : null
            );
          })
        : h('span', { class: 'muted' }, NA, hint ? h('small', {}, ` ${hint}`) : null)
    )
  );
}

const section = (title, ...rows) => h('section', { class: 'info-section' }, h('h3', {}, title), ...rows);

const addresses = (list, copy) => (list || []).map((a) => ({ text: a.address, note: a.iface ? `(${a.iface})` : '', copy }));

const SOURCE_NOTES = { manual: '(set manually)', lookup: '(looked up)', interface: '(on an interface)' };

function publicIpRow(net) {
  const pub = net?.publicIp;
  if (!pub) return row('Public IP', []);
  if (pub.value) return row('Public IP', { text: pub.value, note: SOURCE_NOTES[pub.source] || '', copy: 'public IP' });
  return row('Public IP', [], pub.enabled ? `- ${pub.error || 'lookup returned nothing'}` : '- set it (or turn on the lookup) in Settings > Monitoring');
}

function renderInfo(info) {
  const { system: s, network: net, docker: d } = info;
  const dockerOk = d?.available;
  fill(
    $('#serverInfoBody'),
    section(
      'System',
      row('Hostname', { text: text(s.hostname), copy: 'hostname' }),
      row('Operating system', [[s.os, s.osVersion].filter(Boolean).join(' ')]),
      row('Kernel', s.kernel),
      row('CPU', [[s.cpuModel, s.cpuCores ? `${s.cpuCores} ${s.cpuCores === 1 ? 'core' : 'cores'}` : ''].filter(Boolean).join(' · ')]),
      row('Architecture', s.arch),
      row('Uptime', s.uptime == null ? '' : fmtUptime(s.uptime))
    ),
    section(
      'Network',
      publicIpRow(net),
      row('Private IPv4', addresses(net?.ipv4, 'IP')),
      row('IPv6', addresses(net?.ipv6, 'IPv6')),
      row('Interfaces', net?.interfaces?.length ? [net.interfaces.join(', ')] : [])
    ),
    section(
      'Docker',
      row('Version', dockerOk ? [[d.version, d.apiVersion ? `(API ${d.apiVersion})` : ''].filter(Boolean).join(' ')] : []),
      row('Containers', dockerOk && d.total != null ? [`${d.running ?? 0} running · ${d.stopped ?? 0} stopped · ${d.total} total`] : []),
      row('Images', dockerOk ? d.images : ''),
      row('Storage driver', dockerOk ? d.storageDriver : '')
    )
  );
}

function renderError(message) {
  fill($('#serverInfoBody'), h('div', { class: 'info-error' }, h('p', {}, svg('warn'), ` ${message}`), h('button', { type: 'button', class: 'btn ghost', onclick: () => load() }, 'Retry')));
}

async function load() {
  const id = ++request;
  const server = current;
  fill($('#serverInfoBody'), h('p', { class: 'muted info-loading' }, 'Loading…'));
  try {
    const url = server.remote ? `/api/remotes/info?id=${encodeURIComponent(server.remote)}` : '/api/info';
    const { res, data } = await api('GET', url);
    if (id !== request) return;
    if (res.ok) renderInfo(data);
    else renderError(data.error || `Request failed (${res.status})`);
  } catch {
    if (id === request) renderError('Dashboard server unreachable');
  }
}

export function openServerInfo(server) {
  current = server;
  $('#serverInfoTitle').textContent = `Server info · ${server.name}`;
  load();
  const dialog = $('#serverInfoDialog');
  if (!dialog.open) dialog.showModal();
}
