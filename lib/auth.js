"use strict";
// Optional password (DASHBOARD_PASSWORD env var) with HMAC-signed session cookies.

const fsp = require("fs").promises;
const crypto = require("crypto");
const { promisify } = require("util");
const {
  PASSWORD,
  LOCK_VIEW,
  SESSION_KEY_FILE,
  TRUST_PROXY,
  SESSION_DAYS,
  LOGIN_MAX_FAILURES,
  LOGIN_LOCKOUT,
} = require("./env");
const { writeAtomic } = require("./config");
const { send, readJson } = require("./http");
const logger = require("./logger");

const scrypt = promisify(crypto.scrypt);

const COOKIE = "dash_session";
const SESSION_SECONDS = 60 * 60 * 24 * SESSION_DAYS;
const MAX_FAILURES = LOGIN_MAX_FAILURES;
const LOCKOUT_MS = LOGIN_LOCKOUT * 1000;

let sessionSecret = null;
let pwSalt = null;
let pwHash = null;
const loginFailures = new Map(); // ip -> { count, until, expires }
// No queue: leave one global slot available when a shared address uses two.
const MAX_LOGIN_WORK = 3;
const MAX_CLIENT_WORK = 2;
const MAX_FAILURE_RECORDS = 4096;
const FAILURE_TTL_MS = 15 * 60 * 1000;
const MAX_PASSWORD_BYTES = Math.max(1024, Buffer.byteLength(PASSWORD || ""));
const loginWork = new Map();
let activeLoginWork = 0;

function pruneFailures(now) {
  for (const [ip, record] of loginFailures) {
    if (record.expires <= now && !loginWork.has(ip)) loginFailures.delete(ip);
  }
}

async function initAuth() {
  if (!PASSWORD) return;
  // A random key persisted in the data dir keeps logins valid across restarts;
  // mixing in the password means changing the password logs out every session.
  let key = "";
  try {
    key = (await fsp.readFile(SESSION_KEY_FILE, "utf8")).trim();
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
  if (!key) {
    key = crypto.randomBytes(32).toString("hex");
    await writeAtomic(SESSION_KEY_FILE, key);
  }
  sessionSecret = crypto.createHmac("sha256", key).update(PASSWORD).digest();
  pwSalt = crypto.randomBytes(16);
  pwHash = await scrypt(PASSWORD, pwSalt, 64);
}

const sign = (exp) =>
  crypto
    .createHmac("sha256", sessionSecret)
    .update(String(exp))
    .digest("base64url");

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function readCookie(req, name) {
  for (const part of String(req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name)
      return part.slice(i + 1).trim();
  }
  return "";
}

function sessionCookie(req, token) {
  const secure =
    req.socket.encrypted ||
    (TRUST_PROXY && req.headers["x-forwarded-proto"] === "https")
      ? "; Secure"
      : "";
  return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${token ? SESSION_SECONDS : 0}${secure}`;
}

function newSessionToken() {
  const exp = Date.now() + SESSION_SECONDS * 1000;
  return `${exp}.${sign(exp)}`;
}

function isAuthenticated(req) {
  if (!PASSWORD) return true;
  const [exp, sig] = readCookie(req, COOKIE).split(".");
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  return safeEqual(sig, sign(exp));
}

const canView = (req) => !LOCK_VIEW || isAuthenticated(req);

const authStatus = (req) => ({
  passwordSet: Boolean(PASSWORD),
  lockView: LOCK_VIEW,
  authenticated: Boolean(PASSWORD) && isAuthenticated(req),
});

/** Visitor IP. Behind a trusted proxy that's the last X-Forwarded-For entry (the one the proxy added). */
function clientIp(req) {
  const forwarded = TRUST_PROXY
    ? String(req.headers["x-forwarded-for"] || "")
        .split(",")
        .pop()
        .trim()
    : "";
  return forwarded || req.socket.remoteAddress;
}

async function handleLogin(req, res) {
  if (!PASSWORD) {
    await readJson(req);
    return send(res, 200, authStatus(req));
  }
  const ip = clientIp(req);
  const now = Date.now();
  pruneFailures(now);
  const fail = loginFailures.get(ip);
  if (
    (fail && fail.until > now) || activeLoginWork >= MAX_LOGIN_WORK ||
    (loginWork.get(ip) || 0) >= MAX_CLIENT_WORK ||
    (!fail && loginFailures.size >= MAX_FAILURE_RECORDS)
  ) {
    logger.warn("[Auth] Login blocked by rate limit");
    return send(res, 429, {
      error: "Too many attempts. Try again shortly.",
    }, { "Retry-After": String(Math.max(5, Math.ceil(((fail?.until || now) - now) / 1000))) });
  }
  // Reserve before reading the body as well as before derivation. A placeholder
  // reserves failure-table capacity for admitted requests from distinct clients.
  if (!fail) loginFailures.set(ip, { count: 0, until: 0, expires: now + FAILURE_TTL_MS });
  activeLoginWork++;
  loginWork.set(ip, (loginWork.get(ip) || 0) + 1);
  try {
    const body = await readJson(req);
    const password = body?.password;
    if (typeof password !== "string" || Buffer.byteLength(password) > MAX_PASSWORD_BYTES)
      return send(res, 400, { error: "Invalid password input" });

    const ok =
      crypto.timingSafeEqual(await scrypt(password, pwSalt, 64), pwHash);
    if (!ok) {
      logger.warn("[Auth] Login rejected: wrong password");
      // Other attempts may have completed while this password was being checked.
      const current = loginFailures.get(ip);
      if (!current || current.until <= Date.now()) {
        const count = (current?.count || 0) + 1;
        const locked = count >= MAX_FAILURES;
        loginFailures.set(ip, {
          count: locked ? 0 : count,
          until: locked ? Date.now() + LOCKOUT_MS : 0,
          expires: Date.now() + Math.max(FAILURE_TTL_MS, locked ? LOCKOUT_MS : 0),
        });
      }
      return send(res, 401, { error: "Wrong password" });
    }
    // Keep the table reservation until the last admitted request for this IP
    // completes, even when this success resets its failure count.
    loginFailures.set(ip, { count: 0, until: 0, expires: Date.now() + FAILURE_TTL_MS });
    logger.info("[Auth] Login succeeded");
    send(
      res,
      200,
      { ...authStatus(req), authenticated: true },
      { "Set-Cookie": sessionCookie(req, newSessionToken()) },
    );
  } finally {
    activeLoginWork--;
    const remaining = loginWork.get(ip) - 1;
    if (remaining) loginWork.set(ip, remaining);
    else {
      loginWork.delete(ip);
      if (loginFailures.get(ip)?.count === 0 && !loginFailures.get(ip)?.until)
        loginFailures.delete(ip);
    }
  }
}

function handleLogout(req, res) {
  logger.info("[Auth] Logout requested");
  send(
    res,
    200,
    { ...authStatus(req), authenticated: false },
    { "Set-Cookie": sessionCookie(req, "") },
  );
}

module.exports = {
  initAuth,
  isAuthenticated,
  canView,
  authStatus,
  handleLogin,
  handleLogout,
};
