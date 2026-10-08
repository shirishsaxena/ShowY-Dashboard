// Main render: top bar state, then server switcher, favourites and either the server page or search results.

import { state, activeServer, allServers } from '../state.js';
import { $ } from '../dom.js';
import { plural } from '../utils.js';
import { serviceStatus } from '../status.js';
import { renderSwitcher } from './switcher.js';
import { renderFavorites } from './favorites.js';
import { renderServer } from './server.js';
import { renderSearch } from './search.js';
import { renderLinks } from './links.js';
import { settleLoad } from '../loading.js';

export function render() {
  settleLoad();
  const { settings } = state.config;
  document.title = settings.title;
  $('#summary').textContent = summary();

  const editBtn = $('#editBtn');
  editBtn.setAttribute('aria-pressed', String(state.editing));
  editBtn.querySelector('span').textContent = state.editing ? 'Done' : 'Edit';
  document.body.classList.toggle('editing', state.editing);
  $('#editDock').hidden = !state.editing;
  $('#dockAddService').hidden = $('#dockAddGroup').hidden = !activeServer() || Boolean(activeServer().remote);
  $('#lockBtn').hidden = !(state.auth.passwordSet && state.auth.authenticated);

  renderSwitcher();
  renderFavorites();
  if (state.query) renderSearch();
  else {
    renderServer(activeServer());
    renderLinks();
  }
}

function summary() {
  const servers = allServers();
  let total = 0;
  let up = 0;
  let known = 0;
  for (const server of servers) {
    for (const svc of server.services) {
      total++;
      const level = serviceStatus(svc, server)?.level;
      if (level && level !== 'unknown') known++;
      if (level === 'up') up++;
    }
  }
  // Shown under the server name: dashboard title plus totals across all servers.
  const parts = [state.config.settings.title];
  if (servers.length > 1) parts.push(plural(servers.length, 'server'));
  parts.push(known ? `${up}/${known} online` : plural(total, 'service'));
  return parts.join(' · ');
}
