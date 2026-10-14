"use strict";
// Dashboard config: stored as JSON in the data dir and validated on every save.

const fsp = require("fs").promises;
const crypto = require("crypto");
const { CONFIG_FILE, DATA_DIR } = require("./env");
const { badRequest, HttpError } = require("./http");

const DEFAULT_CONFIG = {
  settings: {
    title: "Home Lab",
    appName: "",
    hiddenContainers: [],
    favorites: [],
    links: [],
  },
  servers: [],
};

let configPending = null;

async function readConfig() {
  if (!configPending) {
    const job = fsp.readFile(CONFIG_FILE, "utf8")
      .then((text) => {
        const config = JSON.parse(text);
        if (!config || typeof config !== "object" || Array.isArray(config))
          throw new Error("Invalid configuration store");
        return config;
      })
      .catch((err) => {
        if (err.code === "ENOENT") return DEFAULT_CONFIG;
        throw err;
      })
      .finally(() => {
        if (configPending === job) configPending = null;
      });
    configPending = job;
  }
  return structuredClone(await configPending);
}

const writes = new Map();

/** Write via a temp file + rename so a crash never leaves a half-written file. */
function writeAtomic(file, data) {
  // Windows also needs same-destination renames to run one at a time.
  const run = (writes.get(file) || Promise.resolve())
    .catch(() => {})
    .then(async () => {
      await fsp.mkdir(DATA_DIR, { recursive: true });
      const tmp = `${file}.${crypto.randomUUID()}.tmp`;
      try {
        await fsp.writeFile(tmp, data, { mode: 0o600, flag: "wx" });
        await fsp.rename(tmp, file);
      } catch (err) {
        await fsp.rm(tmp, { force: true }).catch(() => {});
        throw err;
      }
    });
  writes.set(file, run);
  return run.finally(() => {
    if (writes.get(file) === run) writes.delete(file);
  });
}

let configQueue = Promise.resolve();

// Content token; compare-and-write is coordinated only within this process.
const configRevision = (config) =>
  crypto.createHash("sha256").update(JSON.stringify(config)).digest("hex");

function writeConfig(config, expectedRevision) {
  const data = JSON.stringify(config, null, 2);
  const run = configQueue.then(async () => {
    // Read first so an unreadable or corrupt configuration is not replaced,
    // even by a caller that supplies an entirely new document.
    const current = await readConfig();
    if (expectedRevision !== undefined && expectedRevision !== configRevision(current))
      throw new HttpError(409, "Configuration changed elsewhere. Review the latest configuration and retry.");
    try {
      await fsp.copyFile(CONFIG_FILE, `${CONFIG_FILE}.bak`);
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
      // copyFile can also report ENOENT for a missing backup destination.
      // Ignore it only if the source itself really does not exist.
      try {
        await fsp.stat(CONFIG_FILE);
      } catch (sourceError) {
        if (sourceError.code === "ENOENT") {
          await writeAtomic(CONFIG_FILE, data);
          configPending = null;
          return;
        }
        throw sourceError;
      }
      throw err;
    }
    await writeAtomic(CONFIG_FILE, data);
    configPending = null;
  });
  configQueue = run.catch(() => {});
  return run.then(() => configRevision(JSON.parse(data)));
}

// ---------- Validation ----------

const str = (v, max = 500) =>
  typeof v === "string" ? v.trim().slice(0, max) : "";
const id = (v) =>
  typeof v === "string" && /^[\w-]{1,64}$/.test(v) ? v : crypto.randomUUID();
const list = (v) => (Array.isArray(v) ? v : []);
const unique = (items) => [...new Set(items.filter(Boolean))];

function httpUrl(v, label) {
  const s = str(v, 2000);
  if (!s) return "";
  let url;
  try {
    url = new URL(s);
  } catch {
    throw badRequest(`${label} is not a valid URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw badRequest(`${label} must be http(s)`);
  return s;
}

/** Emoji, dashboard-icons name or an http(s) image URL. */
function icon(v) {
  const s = str(v, 2000);
  if (/^[a-z][a-z0-9+.-]*:/i.test(s) && !/^https?:\/\//i.test(s))
    throw badRequest("Icon URL must be http(s)");
  return s;
}

const accent = (v) =>
  typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v) ? v.toLowerCase() : "";

function sanitizeServiceUrls(urls, name) {
  if (!Array.isArray(urls) || urls.length > 50)
    throw badRequest(`${name}: URLs must be an array of at most 50 entries`);
  return Array.from(urls, (entry, index) => {
    const context = `${name}: URL ${index + 1}`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry))
      throw badRequest(`${context} must be a labeled URL object`);
    if (typeof entry.label !== "string" || !entry.label.trim() || entry.label.trim().length > 60)
      throw badRequest(`${context}: label must be 1–60 characters`);
    if (typeof entry.url !== "string" || !entry.url.trim() || entry.url.trim().length > 2000)
      throw badRequest(`${context}: URL must be 1–2000 characters`);
    return { label: entry.label.trim(), url: httpUrl(entry.url, context) };
  });
}

function sanitizeService(svc, serverName) {
  if (!svc || typeof svc !== "object" || Array.isArray(svc))
    throw badRequest(`${serverName}: every service must be an object`);
  const name = str(svc.name, 100);
  if (!name) throw badRequest(`${serverName}: every service needs a name`);
  const typed = Object.hasOwn(svc, "type");
  if (typed && !["docker", "web", "bookmark"].includes(svc.type))
    throw badRequest(`${name}: unsupported service type`);
  const canonical = Object.hasOwn(svc, "urls");
  const urls = canonical ? sanitizeServiceUrls(svc.urls, name) : null;
  const url = canonical ? urls[0]?.url || "" : httpUrl(svc.url, `${name}: URL`);
  const altUrl = canonical ? urls[1]?.url || "" : httpUrl(svc.altUrl, `${name}: public URL`);
  const container = !typed || svc.type === "docker" ? str(svc.container, 200) : "";
  if (svc.type === "docker" && !container)
    throw badRequest(`${name}: Docker services need an explicit container name`);
  if ((svc.type === "web" || svc.type === "bookmark") && !url && !altUrl)
    throw badRequest(`${name}: ${svc.type} services need a URL or alternate URL`);
  return {
    id: id(svc.id),
    ...(typed ? { type: svc.type } : {}),
    name,
    icon: icon(svc.icon),
    ...(canonical ? { urls } : {}),
    url,
    altUrl,
    description: str(svc.description),
    notes: str(svc.notes, 2000),
    container,
    group: str(svc.group, 60),
  };
}

function sanitizeServer(srv) {
  if (!srv || typeof srv !== "object" || Array.isArray(srv))
    throw badRequest("Every server must be an object");
  const name = str(srv.name, 100);
  if (!name) throw badRequest("Every server needs a name");
  const services = list(srv.services).map((svc) => sanitizeService(svc, name));
  // Ordered group names; any group used by a service but missing from the list is appended.
  const groups = unique([
    ...list(srv.groups).map((g) => str(g, 60)),
    ...services.map((s) => s.group),
  ]);
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
  if (!name) throw badRequest("Every quick action needs a name");
  if (link.type === "copy") {
    const text = typeof link.text === "string" ? link.text.slice(0, 2000) : "";
    if (!text.trim()) throw badRequest(`${name}: text to copy is required`);
    return {
      id: id(link.id),
      name,
      type: "copy",
      url: "",
      text,
      icon: icon(link.icon),
    };
  }
  const url = httpUrl(link.url, `${name}: URL`);
  if (!url) throw badRequest(`${name}: URL is required`);
  return {
    id: id(link.id),
    name,
    type: "link",
    url,
    text: "",
    icon: icon(link.icon),
  };
}

function sanitizeConfig(input) {
  if (!input || typeof input !== "object" || !Array.isArray(input.servers)) {
    throw badRequest('Config must contain a "servers" array');
  }
  const settings = input.settings || {};
  const servers = input.servers.map(sanitizeServer);
  const serviceIds = new Set(
    servers.flatMap((s) => s.services.map((svc) => svc.id)),
  );
  return {
    settings: {
      title: str(settings.title, 100) || "Home Lab",
      appName: str(settings.appName, 60),
      accent: accent(settings.accent),
      hiddenContainers: unique(
        list(settings.hiddenContainers).map((c) => str(c, 200)),
      ),
      // Ordered service ids; ones that no longer exist are dropped.
      favorites: unique(
        list(settings.favorites).filter(
          (f) => typeof f === "string" && serviceIds.has(f),
        ),
      ),
      links: list(settings.links).map(sanitizeLink),
    },
    servers,
  };
}

module.exports = { readConfig, writeConfig, writeAtomic, sanitizeConfig, configRevision };
