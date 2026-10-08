// Every change to the config goes through here: optimistic update, save, roll back on error.

import { state, prefs, setPref, findServer, normalizeConfig } from './state.js';
import { api } from './api.js';
import { toast } from './dom.js';
import { clone, uid } from './utils.js';
import { render } from './view/render.js';
import { ask } from './dialogs/ask.js';
import { promptLogin } from './dialogs/login.js';

/** Make sure we may edit; prompts for the password if one is set. */
export async function ensureCanEdit() {
  if (!state.auth.passwordSet || state.auth.authenticated) return true;
  return promptLogin();
}

async function putConfig(cfg) {
  for (;;) {
    const { res, data } = await api('PUT', '/api/config', cfg);
    if (res.status === 401) {
      state.auth.authenticated = false;
      if (!(await promptLogin())) throw new Error('Not saved — password required');
      continue;
    }
    if (!res.ok) throw new Error(data.error || `Save failed (${res.status})`);
    return normalizeConfig(data.config);
  }
}

export async function save(next, message = 'Saved') {
  const prev = state.config;
  state.config = next;
  render();
  try {
    state.config = await putConfig(next);
    render();
    toast(message);
    document.dispatchEvent(new CustomEvent('config-saved'));
    return true;
  } catch (err) {
    state.config = prev;
    render();
    toast(err.message, true);
    return false;
  }
}

/** Apply `mutate` to a copy of the config and save it. */
function update(mutate, message) {
  const next = clone(state.config);
  mutate(next);
  return save(next, message);
}

const serverIn = (cfg, id) => cfg.servers.find((s) => s.id === id);
const byIds = (ids) => (a, b) => ids.indexOf(a.id) - ids.indexOf(b.id);

// ---------- Ordering ----------

export const reorderServers = (ids) => update((c) => c.servers.sort(byIds(ids)), 'Order saved');

export const reorderFavorites = (ids) => update((c) => (c.settings.favorites = ids), 'Order saved');

export const reorderGroups = (serverId, names) => update((c) => (serverIn(c, serverId).groups = names), 'Order saved');

/** New order + group membership after a drag: lists = [{ group, ids }] in page order. */
export function arrangeServices(serverId, lists) {
  return update((c) => {
    const server = serverIn(c, serverId);
    const byId = new Map(server.services.map((s) => [s.id, s]));
    const placed = lists.flatMap(({ group, ids }) => ids.map((id) => ({ ...byId.get(id), group })));
    const placedIds = new Set(placed.map((s) => s.id));
    server.services = [...placed, ...server.services.filter((s) => !placedIds.has(s.id))];
  }, 'Order saved');
}

// ---------- Services ----------

export function toggleFavorite(svcId) {
  const on = !state.config.settings.favorites.includes(svcId);
  return update((c) => {
    const favs = c.settings.favorites.filter((f) => f !== svcId);
    c.settings.favorites = on ? [...favs, svcId] : favs;
  }, on ? 'Pinned to favourites' : 'Unpinned');
}

/** Create or update a service, possibly moving it to another server. */
export function saveService({ fromServerId, toServerId, svcId, fields, pinned }) {
  return update((c) => {
    const svc = { id: svcId || uid(), ...fields };
    const from = serverIn(c, fromServerId);
    const to = serverIn(c, toServerId);
    const idx = svcId ? from.services.findIndex((s) => s.id === svcId) : -1;
    if (idx >= 0 && from === to) to.services[idx] = svc;
    else {
      if (idx >= 0) from.services.splice(idx, 1);
      to.services.push(svc);
    }
    if (svc.group && !to.groups.includes(svc.group)) to.groups.push(svc.group);
    const favs = c.settings.favorites;
    if (pinned && !favs.includes(svc.id)) favs.push(svc.id);
    if (!pinned) c.settings.favorites = favs.filter((f) => f !== svc.id);
  }, svcId ? 'Service updated' : 'Service added');
}

/** Resolves to true when the service was deleted. */
export async function deleteService(serverId, svcId) {
  const svc = findServer(serverId)?.services.find((s) => s.id === svcId);
  if (!svc) return false;
  const ok = await ask({ title: 'Delete service?', message: `“${svc.name}” will be removed from the dashboard.`, okLabel: 'Delete', danger: true });
  if (!ok) return false;
  return update((c) => {
    const server = serverIn(c, serverId);
    server.services = server.services.filter((s) => s.id !== svcId);
  }, 'Service deleted');
}

// ---------- Groups ----------

export async function addGroup(serverId) {
  const name = await ask({ title: 'New group', label: 'Group name', placeholder: 'Media, Downloads, Tools…', okLabel: 'Add group' });
  if (!name) return;
  if (findServer(serverId).groups.includes(name)) return toast(`“${name}” already exists`, true);
  await update((c) => serverIn(c, serverId).groups.push(name), 'Group added');
}

export async function renameGroup(serverId, oldName) {
  const name = await ask({ title: 'Rename group', label: 'Group name', value: oldName, okLabel: 'Rename' });
  if (!name || name === oldName) return;
  if (findServer(serverId).groups.includes(name)) return toast(`“${name}” already exists`, true);
  const ok = await update((c) => {
    const server = serverIn(c, serverId);
    server.groups = server.groups.map((g) => (g === oldName ? name : g));
    for (const svc of server.services) if (svc.group === oldName) svc.group = name;
  }, 'Group renamed');
  // Keep the collapsed state under the new name.
  const oldKey = `${serverId}::${oldName}`;
  if (ok && prefs.collapsed.delete(oldKey)) {
    prefs.collapsed.add(`${serverId}::${name}`);
    setPref('collapsed', prefs.collapsed);
  }
}

export async function deleteGroup(serverId, name) {
  const server = findServer(serverId);
  const count = server.services.filter((s) => s.group === name).length;
  const ok = await ask({
    title: `Delete “${name}”?`,
    message: count ? `Its ${count} service${count === 1 ? '' : 's'} will move to “Ungrouped”.` : 'The group is empty.',
    okLabel: 'Delete group',
    danger: true,
  });
  if (!ok) return;
  await update((c) => {
    const target = serverIn(c, serverId);
    target.groups = target.groups.filter((g) => g !== name);
    for (const svc of target.services) if (svc.group === name) svc.group = '';
  }, 'Group deleted');
}

// ---------- Servers ----------

/** Create (serverId = null) or update a server. Resolves to true on success. */
export async function saveServer(serverId, fields) {
  const id = serverId || uid();
  const ok = await update((c) => {
    if (serverId) Object.assign(serverIn(c, serverId), fields);
    else c.servers.push({ id, ...fields, groups: [], services: [] });
  }, serverId ? 'Server updated' : 'Server added');
  if (ok && !serverId) {
    state.activeId = id;
    setPref('tab', id);
    render();
  }
  return ok;
}

export async function deleteServer(serverId) {
  const server = findServer(serverId);
  const ok = await ask({
    title: `Delete “${server.name}”?`,
    message: `The server and its ${server.services.length} service${server.services.length === 1 ? '' : 's'} will be removed.`,
    okLabel: 'Delete server',
    danger: true,
  });
  if (!ok) return false;
  return update((c) => (c.servers = c.servers.filter((s) => s.id !== serverId)), 'Server deleted');
}

// ---------- Links ----------

export const reorderLinks = (ids) => update((c) => c.settings.links.sort(byIds(ids)), 'Order saved');

/** Create (linkId = null) or update a quick action (fields.type: 'link' opens a URL, 'copy' copies a text). */
export function saveLink(linkId, fields) {
  return update((c) => {
    const links = c.settings.links;
    const i = links.findIndex((l) => l.id === linkId);
    if (i >= 0) links[i] = { ...links[i], ...fields };
    else links.push({ id: uid(), ...fields });
  }, linkId ? 'Quick action updated' : 'Quick action added');
}

/** Resolves to true when the link was deleted. */
export async function deleteLink(linkId) {
  const link = state.config.settings.links.find((l) => l.id === linkId);
  if (!link) return false;
  const ok = await ask({ title: 'Delete quick action?', message: `“${link.name}” will be removed from the dashboard.`, okLabel: 'Delete', danger: true });
  return ok && update((c) => (c.settings.links = c.settings.links.filter((l) => l.id !== linkId)), 'Quick action deleted');
}

// ---------- Settings & containers ----------

export const saveSettings = (settings) => update((c) => Object.assign(c.settings, settings), 'Settings saved');

export const hideContainer = (name) =>
  update((c) => (c.settings.hiddenContainers = [...new Set([...c.settings.hiddenContainers, name])]), `${name} hidden`);

export const unhideContainer = (name) =>
  update((c) => (c.settings.hiddenContainers = c.settings.hiddenContainers.filter((n) => n !== name)), `${name} visible again`);

export async function importConfig(parsed) {
  if (!parsed || !Array.isArray(parsed.servers)) {
    toast('That file is not a dashboard backup', true);
    return false;
  }
  const ok = await ask({ title: 'Import backup?', message: 'This replaces the whole dashboard with the imported file.', okLabel: 'Replace', danger: true });
  return ok && save(normalizeConfig(parsed), 'Imported');
}
