"use strict";
// Runtime settings, all overridable through environment variables (see docker-compose.yml).

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");

function readVersion() {
  try {
    return fs.readFileSync(path.join(ROOT, "VERSION"), "utf8").trim() || "dev";
  } catch {
    return "dev";
  }
}
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT, "data"));
// Buffer's Base64 parser is permissive, so validate the alphabet, padding and
// round-trip explicitly. Never include either password representation in errors.
function readPassword(encoded) {
  if (!encoded) return { password: "", error: "" };
  const error = "DASHBOARD_PASSWORD must be canonical Base64 encoding of a UTF-8 password (standard alphabet, correct padding, no whitespace). Leave it empty to disable password protection.";
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded))
    return { password: "", error };
  const bytes = Buffer.from(encoded, "base64");
  const password = bytes.toString("utf8");
  if (!bytes.length || bytes.toString("base64") !== encoded || !Buffer.from(password, "utf8").equals(bytes))
    return { password: "", error };
  return { password, error: "" };
}
const { password: PASSWORD, error: PASSWORD_ERROR } = readPassword(process.env.DASHBOARD_PASSWORD || "");
const requestedLogLevel = (process.env.LOG_LEVEL || "").trim().toUpperCase();
const LOG_LEVEL = ["DEBUG", "INFO", "WARN", "ERROR"].includes(requestedLogLevel)
  ? requestedLogLevel
  : "INFO";

/** Seconds from an env var; 0 or less turns the updates off. */
function seconds(name, fallback, min) {
  const n = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(n)) return fallback;
  return n <= 0 ? 0 : Math.max(min, Math.round(n));
}

/** A whole number from an env var inside min..max, else the fallback. */
function whole(name, fallback, min, max) {
  const n = Number(process.env[name]);
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
}

module.exports = {
  VERSION: readVersion(),
  PORT: Number(process.env.PORT) || 8080,
  DATA_DIR,
  LOG_DIR: path.resolve(process.env.LOG_DIR || path.join(DATA_DIR, "logs")),
  LOG_FILE: path.basename(process.env.LOG_FILE || "backend.log"),
  LOG_MAX_BYTES: whole("LOG_MAX_BYTES", 10 * 1024 * 1024, 1024, 1024 * 1024 * 1024),
  LOG_LEVEL,
  PUBLIC_DIR: path.join(ROOT, "public"),
  CONFIG_FILE: path.join(DATA_DIR, "config.json"),
  SESSION_KEY_FILE: path.join(DATA_DIR, "session.key"),
  CLIP_FILE: path.join(DATA_DIR, "clipboard.json"),
  ACTIVITY_FILE: path.join(DATA_DIR, "activity.json"),
  AVAILABILITY_FILE: path.join(DATA_DIR, "availability.json"),
  SERVERINFO_FILE: path.join(DATA_DIR, "serverinfo.json"),
  // Timing and limit values changed in Settings (the ones fixed by env vars are in lib/tunables.js).
  TUNABLES_FILE: path.join(DATA_DIR, "tunables.json"),
  // Only contacted when the public IP lookup is switched on in Settings (plain-text reply with the caller's IP).
  PUBLIC_IP_URL: process.env.PUBLIC_IP_URL || "https://api.ipify.org",
  ICON_DIR: path.join(DATA_DIR, "icons"),
  ICON_CACHE_MAX_BYTES: whole("ICON_CACHE_MAX_BYTES", 64 * 1024 * 1024, 0, 1024 * 1024 * 1024),
  // Share token and remote dashboards (with their tokens) - kept out of config.json and exports.
  REMOTES_FILE: path.join(DATA_DIR, "remotes.json"),
  // Optional fixed share token and remote dashboards from docker-compose (see lib/remotes.js).
  SHARE_TOKEN: (process.env.SHARE_TOKEN || "").trim(),
  REMOTE_DASHBOARDS: process.env.REMOTE_DASHBOARDS || "",
  // Seconds between updates of remote dashboards. 0 / empty = chosen in Settings (default 10).
  REMOTE_REFRESH_INTERVAL: seconds("REMOTE_REFRESH_INTERVAL", 0, 3),
  // Each sub-folder of DISKS_DIR is reported as a disk (mount host disks there), otherwise "/" is used.
  DISKS_DIR: process.env.DISKS_DIR || "/disks",
  DOCKER_SOCKET:
    process.env.DOCKER_SOCKET ||
    (process.platform === "win32"
      ? "//./pipe/docker_engine"
      : "/var/run/docker.sock"),
  CONTAINER_STATS_INTERVAL: seconds("CONTAINER_STATS_INTERVAL", 30, 5),
  // Lifecycle control is opt-in and also requires PASSWORD. Never affects socket mounting.
  DOCKER_CONTROL: /^(1|true|yes|on)$/i.test(process.env.DOCKER_CONTROL || ""),
  DOCKER_PROTECTED_CONTAINERS: (process.env.DOCKER_PROTECTED_CONTAINERS || "")
    .split(",").map((value) => value.trim()).filter(Boolean),
  HOST_STATS_INTERVAL: seconds("HOST_STATS_INTERVAL", 5, 2),
  // Host /proc mounted into the container, used for host network traffic.
  HOST_PROC: process.env.HOST_PROC || "/host/proc",
  // Decoded password. Invalid configuration is rejected during auth startup.
  PASSWORD,
  PASSWORD_ERROR,
  // With a password: lock everything behind it (default) or only editing (DASHBOARD_LOCK_VIEW=false).
  LOCK_VIEW:
    Boolean(PASSWORD) &&
    !/^(0|false|no|off)$/i.test(process.env.DASHBOARD_LOCK_VIEW || ""),
  // Explicit topology trust: last X-Forwarded-For entry and HTTPS cookie flag.
  // Enable only if direct access is blocked and the proxy overwrites proto,
  // and appends the actual visitor address to X-Forwarded-For.
  TRUST_PROXY: /^(1|true|yes|on)$/i.test(process.env.TRUST_PROXY || ""),
  // Login protection (env only, not in Settings: someone who can edit shouldn't be able to weaken it).
  SESSION_DAYS: whole("SESSION_DAYS", 30, 1, 365), // how long a login lasts
  LOGIN_MAX_FAILURES: whole("LOGIN_MAX_FAILURES", 5, 1, 100), // wrong passwords before the lockout
  LOGIN_LOCKOUT: whole("LOGIN_LOCKOUT", 60, 5, 86400), // lockout length in seconds
};
