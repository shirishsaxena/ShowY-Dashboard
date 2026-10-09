"use strict";
// Icon cache: the server downloads each icon used in the config once, keeps it in
// DATA_DIR/icons and serves it from there - fast on every device and works offline.

const fsp = require("fs").promises;
const path = require("path");
const crypto = require("crypto");
const { ICON_DIR } = require("./env");
const { readConfig } = require("./config");
const { remoteServers } = require("./remotes");
const { HttpError } = require("./http");

const CDN = "https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/png/";
const MAX_BYTES = 1024 * 1024;
const TIMEOUT_MS = 8000;
const RETRY_MS = 10 * 60_000; // wait this long before retrying an icon that failed

const failed = new Map(); // url -> time of the last failure
const pending = new Map(); // url -> in-flight download

const fileFor = (url) =>
  path.join(
    ICON_DIR,
    crypto.createHash("sha256").update(url).digest("hex").slice(0, 32),
  );

/** Image type from the file's first bytes; the remote Content-Type isn't trusted. */
function sniff(buf) {
  const head = buf.subarray(0, 1024).toString("latin1");
  if (head.startsWith("\x89PNG")) return "image/png";
  if (head.startsWith("\xff\xd8\xff")) return "image/jpeg";
  if (head.startsWith("GIF8")) return "image/gif";
  if (head.startsWith("RIFF") && head.slice(8, 12) === "WEBP")
    return "image/webp";
  if (head.slice(4, 12) === "ftypavif") return "image/avif";
  if (head.startsWith("\x00\x00\x01\x00")) return "image/x-icon";
  if (/<svg[\s>]/i.test(head)) return "image/svg+xml";
  return "";
}

/** Icon value (dashboard-icons name or image URL) -> URL to download, or '' if it isn't one. */
function sourceUrl(icon) {
  if (/^https?:\/\//i.test(icon)) return icon;
  if (/^[a-z0-9][a-z0-9-]{0,100}$/.test(icon)) return `${CDN}${icon}.png`;
  return "";
}

/** Only icons in the saved config or on remote servers get downloaded (mirrors the client's choices). */
async function configIcons() {
  const { settings = {}, servers = [] } = await readConfig();
  const icons = new Set();
  for (const server of [...servers, ...remoteServers()]) {
    icons.add(server.icon);
    for (const svc of server.services || []) icons.add(svc.icon);
  }
  for (const link of settings.links || []) {
    if (link.type === "copy") {
      if (link.icon) icons.add(link.icon); // no site to take a favicon from
      continue;
    }
    try {
      icons.add(link.icon || `${new URL(link.url).origin}/favicon.ico`);
    } catch {
      /* invalid link URL */
    }
  }
  return icons;
}

async function download(url) {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: {
      "User-Agent": "Mozilla/5.0 (home-lab-dashboard icon cache)",
      Accept: "image/*",
    },
  });
  if (!res.ok || Number(res.headers.get("content-length")) > MAX_BYTES) {
    await res.body?.cancel().catch(() => {});
    throw new Error(!res.ok ? `HTTP ${res.status}` : "Too large");
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of res.body) {
    size += chunk.length;
    if (size > MAX_BYTES) throw new Error("Too large");
    chunks.push(chunk);
  }
  const buf = Buffer.concat(chunks, size);
  if (!sniff(buf)) throw new Error("Not an image");
  await fsp.mkdir(ICON_DIR, { recursive: true });
  const file = fileFor(url);
  const tmp = `${file}.tmp`;
  try {
    await fsp.writeFile(tmp, buf);
    await fsp.rename(tmp, file);
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
  return buf;
}

/** Cached copy, or download it (one download per URL at a time). null = unavailable. */
async function loadIcon(url) {
  try {
    return await fsp.readFile(fileFor(url));
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
  if (Date.now() - (failed.get(url) || 0) < RETRY_MS) return null;
  if (!pending.has(url)) {
    const job = download(url)
      .catch(() => {
        failed.set(url, Date.now());
        return null;
      })
      .finally(() => pending.delete(url));
    pending.set(url, job);
  }
  return pending.get(url);
}

/** Resolve an allowed dashboard icon to its cached bytes and representation metadata. */
async function getIcon(icon) {
  const url = sourceUrl(icon);
  if (!url) throw new HttpError(400, "Not an icon name or URL");
  if (!(await configIcons()).has(icon))
    throw new HttpError(403, "Icon is not used on the dashboard");

  const data = await loadIcon(url);
  if (!data) throw new HttpError(404, "Icon unavailable");
  const etag = `"${crypto.createHash("sha1").update(data).digest("base64url")}"`;
  return { data, etag, contentType: sniff(data) };
}

async function listFiles() {
  try {
    return (await fsp.readdir(ICON_DIR)).filter((f) => !f.endsWith(".tmp"));
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
}

async function iconCacheInfo() {
  const files = await listFiles();
  const sizes = await Promise.all(
    files.map((f) =>
      fsp.stat(path.join(ICON_DIR, f)).then(
        (s) => s.size,
        () => 0,
      ),
    ),
  );
  return { count: files.length, bytes: sizes.reduce((a, b) => a + b, 0) };
}

async function clearIconCache() {
  const files = await listFiles();
  await Promise.all(
    files.map((f) => fsp.rm(path.join(ICON_DIR, f), { force: true })),
  );
  failed.clear();
  return { removed: files.length };
}

module.exports = { getIcon, iconCacheInfo, clearIconCache };
