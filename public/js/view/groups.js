// Service groups: collapsible sections (view mode) and editable boxes (edit mode).

import { state, prefs, setPref } from '../state.js';
import { $, h, fill, svg, iconBtn, dragHandle } from '../dom.js';
import { duplicateHosts, containerFor } from '../status.js';
import * as actions from '../actions.js';
import { openServiceEditor } from '../dialogs/service.js';
import { serviceCard } from './cards.js';
import { groupUsageNode } from './usage.js';

const collapseKey = (server, group) => `${server.id}::${group}`;

/** Collapse/expand one group in place - no full re-render, so nothing else redraws. */
function toggleCollapsed(section, key) {
  const collapsed = !prefs.collapsed.has(key);
  if (collapsed) prefs.collapsed.add(key);
  else prefs.collapsed.delete(key);
  setPref('collapsed', prefs.collapsed);
  section.classList.toggle('collapsed', collapsed);
  section.querySelector('.grid').hidden = collapsed;
  section.querySelector('.group-head').setAttribute('aria-expanded', String(!collapsed));
}

/** Ungrouped services first, then each group in order. Empty sections only show while editing. */
function groupSections(server) {
  const sections = new Map([['', []], ...server.groups.map((g) => [g, []])]);
  for (const svc of server.services) (sections.get(svc.group) || sections.get('')).push(svc);
  return [...sections]
    .map(([name, services]) => ({ name, services }))
    .filter((s) => s.services.length || state.editing);
}

export function renderGroups(server) {
  const dupes = server.local ? duplicateHosts(server) : new Set();
  const hasGroups = server.groups.length > 0;
  fill(
    $('#services'),
    groupSections(server).map(({ name, services }) => {
      const key = collapseKey(server, name);
      // Ungrouped services get a header too once the server has groups.
      const showHeader = Boolean(name) || hasGroups;
      const collapsed = showHeader && !state.editing && prefs.collapsed.has(key);
      return h(
        'section',
        { class: `group${name ? ' named' : ''}${collapsed ? ' collapsed' : ''}`, 'data-id': name },
        showHeader ? groupHeader(server, name, services, collapsed) : null,
        h(
          'div',
          { class: 'grid', 'data-list': '', hidden: collapsed },
          services.map((svc) => serviceCard(svc, server, { dupes })),
          state.editing ? addCard(server, name) : null
        )
      );
    })
  );
}

function groupHeader(server, name, services, collapsed) {
  const title = [h('span', { class: 'group-name' }, name || 'Ungrouped'), h('span', { class: 'count' }, services.length)];
  if (!state.editing) {
    const key = collapseKey(server, name);
    return h(
      'button',
      {
        type: 'button',
        class: 'group-head',
        'aria-expanded': String(!collapsed),
        onclick: (e) => toggleCollapsed(e.currentTarget.closest('.group'), key),
      },
      svg('chevron'),
      title,
      groupUsageNode(services.map((svc) => containerFor(svc, server)), server)
    );
  }
  return h(
    'div',
    { class: 'group-head' },
    name ? dragHandle('drag-handle group-handle') : null,
    title,
    h('span', { class: 'grow' }),
    name ? iconBtn('edit', `Rename ${name}`, () => actions.renameGroup(server.id, name)) : null,
    name ? iconBtn('trash', `Delete ${name}`, () => actions.deleteGroup(server.id, name), 'icon-btn sm danger') : null
  );
}

function addCard(server, group) {
  return h(
    'button',
    { type: 'button', class: 'card add-card', onclick: () => openServiceEditor(server.id, null, { group }) },
    svg('plus'),
    'Add service'
  );
}
