'use strict';
// Dashboard config: stored as JSON in the data dir and validated on every save.

const fsp = require('fs').promises;
const crypto = require('crypto');
const { CONFIG_FILE, DATA_DIR } = require('./env');
const { badRequest } = require('./http');

const DEFAULT_CONFIG = { settings: { title: 'Home Lab', hiddenContainers: [], favorites: [], links: [] }, servers: [] };

async function readConfig() {
  try {
    return JSON.parse(await fsp.readFile(CONFIG_FILE, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return structuredClone(DEFAULT_CONFIG);
    throw err;
  }
}

/** Write via a temp file + rename so a crash never leaves a half-written file. */
async function writeAtomic(file, data) {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  const tmp = `${file}.tmp`;
  await fsp.writeFile(tmp, data, { mode: 0o600 });
  await fsp.rename(tmp, file);
}

async function writeConfig(config) {
  try {
    await fsp.copyFile(CONFIG_FILE, `${CONFIG_FILE}.bak`);
  } catch {
    /* first save - nothing to back up */
  }
  await writeAtomic(CONFIG_FILE, JSON.stringify(config, null, 2));
}

// ---------- Validation ----------

const str = (v, max = 500) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const id = (v) => (typeof v === 'string' && /^[\w-]{1,64}$/.test(v) ? v : crypto.randomUUID());
const list = (v) => (Array.isArray(v) ? v : []);
const unique = (items) => [...new Set(items.filter(Boolean))];

function httpUrl(v, label) {
  const s = str(v, 2000);
  if (!s) return '';
  let url;
  try {
    url = new URL(s);
  } catch {
    throw badRequest(`${label} is not a valid URL`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw badRequest(`${label} must be http(s)`);
  return s;
}

/** Emoji, dashboard-icons name or an http(s) image URL. */
function icon(v) {
  const s = str(v, 2000);
  if (/^[a-z][a-z0-9+.-]*:/i.test(s) && !/^https?:\/\//i.test(s)) throw badRequest('Icon URL must be http(s)');
  return s;
}

const accent = (v) => (typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? v.toLowerCase() : '');

function sanitizeService(svc, serverName) {
  const name = str(svc.name, 100);
  if (!name) throw badRequest(`${serverName}: every service needs a name`);
  return {
    id: id(svc.id),
    name,
    icon: icon(svc.icon),
    url: httpUrl(svc.url, `${name}: URL`),
    altUrl: httpUrl(svc.altUrl, `${name}: public URL`),
    description: str(svc.description),
    notes: str(svc.notes, 2000),
    container: str(svc.container, 200),
    group: str(svc.group, 60),
  };
}

function sanitizeServer(srv) {
  const name = str(srv.name, 100);
  if (!name) throw badRequest('Every server needs a name');
  const services = list(srv.services).map((svc) => sanitizeService(svc, name));
  // Ordered group names; any group used by a service but missing from the list is appended.
  const groups = unique([...list(srv.groups).map((g) => str(g, 60)), ...services.map((s) => s.group)]);
  return {
    id: id(srv.id),
    name,
    icon: icon(srv.icon),
    mainUrl: httpUrl(srv.mainUrl, `${name}: main URL`),
    description: str(srv.description),
    location: str(srv.location, 100),
    specs: str(srv.specs, 200),
    local: Boolean(srv.local),
    groups,
    services,
  };
}

/** Quick action: type 'link' opens a URL, type 'copy' copies a saved text. No status checks. */
function sanitizeLink(link) {
  const name = str(link?.name, 100);
  if (!name) throw badRequest('Every quick action needs a name');
  if (link.type === 'copy') {
    const text = typeof link.text === 'string' ? link.text.slice(0, 2000) : '';
    if (!text.trim()) throw badRequest(`${name}: text to copy is required`);
    return { id: id(link.id), name, type: 'copy', url: '', text, icon: icon(link.icon) };
  }
  const url = httpUrl(link.url, `${name}: URL`);
  if (!url) throw badRequest(`${name}: URL is required`);
  return { id: id(link.id), name, type: 'link', url, text: '', icon: icon(link.icon) };
}

function sanitizeConfig(input) {
  if (!input || typeof input !== 'object' || !Array.isArray(input.servers)) {
    throw badRequest('Config must contain a "servers" array');
  }
  const settings = input.settings || {};
  const servers = input.servers.map(sanitizeServer);
  const serviceIds = new Set(servers.flatMap((s) => s.services.map((svc) => svc.id)));
  return {
    settings: {
      title: str(settings.title, 100) || 'Home Lab',
      accent: accent(settings.accent),
      hiddenContainers: unique(list(settings.hiddenContainers).map((c) => str(c, 200))),
      // Ordered service ids; ones that no longer exist are dropped.
      favorites: unique(list(settings.favorites).filter((f) => typeof f === 'string' && serviceIds.has(f))),
      links: list(settings.links).map(sanitizeLink),
    },
    servers,
  };
}

module.exports = { readConfig, writeConfig, writeAtomic, sanitizeConfig };
