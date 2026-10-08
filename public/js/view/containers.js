// Docker containers that are not on the dashboard (local servers only).

import { state, prefs, setPref } from '../state.js';
import { $, h, fill, svg, iconBtn, iconNode, external } from '../dom.js';
import { hostOf, plural } from '../utils.js';
import { containerFor, containerStatus, statusNode } from '../status.js';
import * as actions from '../actions.js';
import { openServiceEditor } from '../dialogs/service.js';
import { usageNode, groupUsageNode } from './usage.js';

export function renderUnlisted(server) {
  const section = $('#unlisted');
  if (!server.local || server.remote || !state.docker.available) {
    section.hidden = true;
    return;
  }
  const matched = new Set();
  for (const s of state.config.servers.filter((x) => x.local)) {
    for (const svc of s.services) {
      const c = containerFor(svc, s);
      if (c) matched.add(c.name);
    }
  }
  const hidden = new Set(state.config.settings.hiddenContainers);
  const runningFirst = (a, b) => (a.state === 'running' ? 0 : 1) - (b.state === 'running' ? 0 : 1) || a.name.localeCompare(b.name);
  const unmatched = state.docker.containers.filter((c) => !matched.has(c.name));
  const visible = unmatched.filter((c) => !hidden.has(c.name)).sort(runningFirst);
  const hiddenOnes = unmatched.filter((c) => hidden.has(c.name)).sort(runningFirst);
  if (!visible.length && !hiddenOnes.length) {
    section.hidden = true;
    return;
  }

  const host = hostOf(server.mainUrl) || location.hostname;
  const toggleHidden = () => {
    state.showHidden = !state.showHidden;
    renderUnlisted(server); // only this section changes
  };
  const details = h(
    'details',
    { open: prefs.unlistedOpen },
    h(
      'summary',
      {},
      svg('right'),
      svg('box'),
      visible.length ? `${plural(visible.length, 'Docker container')} not on the dashboard` : 'All visible containers are on the dashboard',
      groupUsageNode(visible)
    ),
    visible.length ? h('div', { class: 'grid' }, visible.map((c) => containerCard(c, server, host, false))) : null,
    hiddenOnes.length
      ? h(
          'button',
          { type: 'button', class: 'btn sm ghost show-hidden', onclick: toggleHidden },
          svg(state.showHidden ? 'hide' : 'eye'),
          `${state.showHidden ? 'Hide' : 'Show'} ${plural(hiddenOnes.length, 'hidden container')}`
        )
      : null,
    state.showHidden && hiddenOnes.length ? h('div', { class: 'grid' }, hiddenOnes.map((c) => containerCard(c, server, host, true))) : null
  );
  details.addEventListener('toggle', () => setPref('unlistedOpen', details.open));
  fill(section, details);
  section.hidden = false;
}

function containerCard(c, server, host, isHidden) {
  const guess = c.image.split('/').pop().split(/[:@]/)[0];
  const add = async () => {
    if (!(await actions.ensureCanEdit())) return;
    openServiceEditor(server.id, null, {
      name: c.name.replace(/[-_]+/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase()),
      icon: guess,
      url: c.ports[0] ? `http://${host}:${c.ports[0]}` : '',
      container: c.name,
    });
  };
  return h(
    'article',
    { class: `card${isHidden ? ' is-hidden' : ''}` },
    h(
      'div',
      { class: 'top' },
      iconNode(guess, c.name),
      h('div', { class: 'text' }, h('h3', { class: 'name', title: c.name }, c.name), h('div', { class: 'image', title: c.image }, c.image)),
      statusNode(containerStatus(c))
    ),
    usageNode(c),
    h(
      'div',
      { class: 'links' },
      c.ports.map((p) => h('a', { class: 'chip', href: `http://${host}:${p}`, ...external }, `:${p}`)),
      h('span', { class: 'grow' }),
      isHidden
        ? iconBtn('eye', 'Unhide', () => actions.unhideContainer(c.name))
        : iconBtn('hide', 'Hide from this list', () => actions.hideContainer(c.name)),
      h('button', { type: 'button', class: 'btn sm primary', onclick: add }, svg('plus'), 'Add')
    )
  );
}
