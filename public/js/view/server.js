// Server page: header with chips, host stats, grouped services and unlisted containers.

import { state, sourceOf } from '../state.js';
import { $, h, fill, svg, iconNode, iconBtn, external } from '../dom.js';
import { safeUrl, fmtAgo } from '../utils.js';
import { serverCounts } from '../status.js';
import { openServerEditor } from '../dialogs/server.js';
import { openServerInfo } from '../dialogs/serverinfo.js';
import { renderStats } from './stats.js';
import { renderGroups } from './groups.js';
import { renderUnlisted } from './containers.js';
import { renderLoading } from './loading.js';

// A remote dashboard's data counts as stale when nothing newer arrived for 3 refresh intervals (at least 30 s).
const staleMs = () => Math.max(30_000, state.remotesInterval * 3000);
const localStaleMs = () => state.tunables.localStale * 1000; // this machine is polled every few seconds

/** The age chip next to the server name: when the data on the page last arrived ("12 sec ago"), always shown.
 *  level 'red' / 'amber' flag old data; for a remote server they also dim the page.
 *  level '' is the plain "all good" state. `since` + `label` let the text tick without a re-render. */
function staleness(server) {
  if (!server.remote) {
    if (!server.local || !state.localAt) return null;
    const old = Date.now() - state.localAt > localStaleMs();
    return { level: old ? 'amber' : '', label: old ? 'Stale ·' : 'Updated', since: state.localAt, local: true, dim: false, title: 'When this page last received data from the dashboard server' };
  }
  const src = sourceOf(server);
  if (!src.ok) return { level: 'red', label: 'Unreachable · last seen', since: src.lastOk, dim: true, title: src.error || '' };
  const failed = state.loading?.stage === 'failed' && state.loading.serverId === server.id;
  if (failed || Date.now() - src.at > staleMs()) {
    return { level: 'amber', label: 'Stale ·', since: src.at, dim: true, title: failed ? state.loading.error : 'No recent update from this dashboard' };
  }
  return { level: '', label: 'Updated', since: src.lastOk || src.at, dim: false, title: 'When this dashboard last answered' };
}

/** Re-write the age in every age chip (no re-render). This machine's chip follows state.localAt, which changes between renders. */
export function tickAgo() {
  for (const el of document.querySelectorAll('[data-since]')) el.textContent = agoText(el.dataset.label, el.dataset.local ? state.localAt : Number(el.dataset.since));
}

const agoText = (label, since) => (since ? [label, fmtAgo(since)].filter(Boolean).join(' ') : label.replace(/\s*·.*$/, '') || 'Waiting');

export function renderServer(server) {
  const empty = $('#empty');
  renderLoading();
  $('main').classList.remove('stale');
  if (state.loading?.blocking) {
    // Nothing known about this server yet: the loading panel is all there is (no default values).
    $('#serverHead').replaceChildren();
    $('#services').replaceChildren();
    $('#unlisted').hidden = true;
    $('#stats').hidden = true;
    empty.hidden = true;
    return;
  }
  if (!server) {
    $('#serverHead').replaceChildren();
    $('#services').replaceChildren();
    $('#unlisted').hidden = true;
    $('#stats').hidden = true;
    empty.hidden = false;
    empty.textContent = state.editing
      ? 'Add your first server with the “+ Server” button, or import a backup from Settings below.'
      : 'Nothing here yet — click Edit to add a server or import a backup.';
    return;
  }
  renderServerHead(server);
  // Old data stays visible but is dimmed, with the warning in the heading.
  $('main').classList.toggle('stale', Boolean(staleness(server)?.dim));
  if (server.remote && state.editing) {
    // Remote servers are read-only here; they are edited on their own dashboard.
    $('#stats').hidden = true;
    $('#services').replaceChildren();
    $('#unlisted').hidden = true;
    empty.hidden = false;
    empty.textContent = `This server is shown from ${sourceOf(server).name} — make changes on that dashboard.`;
    return;
  }
  renderStats(server);
  renderGroups(server);
  renderUnlisted(server);
  empty.hidden = server.services.length > 0 || state.editing;
  const src = sourceOf(server);
  empty.textContent = server.remote && !src.ok ? `Could not reach ${src.name}: ${src.error || 'no response'}` : 'No services on this server yet.';
}

function renderServerHead(server) {
  const meta = h('div', { class: 'meta' });
  if (server.location) meta.append(h('span', { class: 'chip' }, svg('pin'), server.location));
  if (server.specs) meta.append(h('span', { class: 'chip' }, svg('cpu'), server.specs));
  const main = safeUrl(server.mainUrl);
  if (main) meta.append(h('a', { class: 'chip', href: main, ...external }, svg('external'), new URL(main).host));

  const counts = serverCounts(server);
  if (counts.up) meta.append(h('span', { class: 'chip green' }, h('span', { class: 'dot' }), `${counts.up} online`));
  if (counts.warn) meta.append(h('span', { class: 'chip amber' }, h('span', { class: 'dot' }), `${counts.warn} warning`));
  if (counts.down) meta.append(h('span', { class: 'chip red' }, h('span', { class: 'dot' }), `${counts.down} offline`));
  const src = sourceOf(server);
  const stale = staleness(server);
  if (!stale?.level && server.local && !src.docker.available) {
    meta.append(h('span', { class: 'chip amber', title: src.docker.error || '' }, svg('warn'), 'Docker unavailable'));
  }
  const remoteUrl = server.remote ? safeUrl(src.url) : '';
  const remoteChip = remoteUrl
    ? h('a', { class: 'chip', href: remoteUrl, title: `Shown from ${src.name} (read-only) — open it to make changes`, ...external }, svg('globe'), src.name)
    : null;

  fill(
    $('#serverHead'),
    server.icon ? iconNode(server.icon, server.name, 'icon server-icon') : null,
    h(
      'div',
      { class: 'info' },
      h(
        'h2',
        {},
        server.name,
        server.local ? iconBtn('info', 'Server info', () => openServerInfo(server), 'icon-btn sm info-btn') : null,
        server.local && !server.remote ? h('span', { class: 'chip' }, svg('home'), 'This machine') : null,
        remoteChip,
        stale
          ? h(
              'span',
              { class: `chip age ${stale.level}`, title: stale.title },
              svg(stale.level === 'red' ? 'warn' : 'clock'),
              h('span', { 'data-since': stale.since || 0, 'data-label': stale.label, 'data-local': stale.local ? '1' : null }, agoText(stale.label, stale.since))
            )
          : null,
        state.editing && !server.remote ? h('button', { type: 'button', class: 'btn sm', onclick: () => openServerEditor(server.id) }, svg('edit'), 'Edit server') : null
      ),
      server.description ? h('p', { class: 'desc' }, server.description) : null,
      meta
    )
  );
}
