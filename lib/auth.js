'use strict';
// Optional password (DASHBOARD_PASSWORD env var) with HMAC-signed session cookies.

const fsp = require('fs').promises;
const crypto = require('crypto');
const { promisify } = require('util');
const { PASSWORD, LOCK_VIEW, SESSION_KEY_FILE, TRUST_PROXY, SESSION_DAYS, LOGIN_MAX_FAILURES, LOGIN_LOCKOUT } = require('./env');
const { writeAtomic } = require('./config');
const { send, readJson } = require('./http');

const scrypt = promisify(crypto.scrypt);

const COOKIE = 'dash_session';
const SESSION_SECONDS = 60 * 60 * 24 * SESSION_DAYS;
const MAX_FAILURES = LOGIN_MAX_FAILURES;
const LOCKOUT_MS = LOGIN_LOCKOUT * 1000;

let sessionSecret = null;
let pwSalt = null;
let pwHash = null;
const loginFailures = new Map(); // ip -> { count, until }

async function initAuth() {
  if (!PASSWORD) return;
  // A random key persisted in the data dir keeps logins valid across restarts;
  // mixing in the password means changing the password logs out every session.
  let key = '';
  try {
    key = (await fsp.readFile(SESSION_KEY_FILE, 'utf8')).trim();
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  if (!key) {
    key = crypto.randomBytes(32).toString('hex');
    await writeAtomic(SESSION_KEY_FILE, key);
  }
  sessionSecret = crypto.createHmac('sha256', key).update(PASSWORD).digest();
  pwSalt = crypto.randomBytes(16);
  pwHash = await scrypt(PASSWORD, pwSalt, 64);
}

const sign = (exp) => crypto.createHmac('sha256', sessionSecret).update(String(exp)).digest('base64url');

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function readCookie(req, name) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return '';
}

function sessionCookie(req, token) {
  const secure = req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${token ? SESSION_SECONDS : 0}${secure}`;
}

function newSessionToken() {
  const exp = Date.now() + SESSION_SECONDS * 1000;
  return `${exp}.${sign(exp)}`;
}

function isAuthenticated(req) {
  if (!PASSWORD) return true;
  const [exp, sig] = readCookie(req, COOKIE).split('.');
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
  const forwarded = TRUST_PROXY ? String(req.headers['x-forwarded-for'] || '').split(',').pop().trim() : '';
  return forwarded || req.socket.remoteAddress;
}

async function handleLogin(req, res) {
  const ip = clientIp(req);
  const fail = loginFailures.get(ip);
  if (fail && fail.until > Date.now()) {
    return send(res, 429, { error: 'Too many attempts. Try again in a minute.' });
  }
  const { password } = await readJson(req);
  if (!PASSWORD) return send(res, 200, authStatus(req));

  const ok = typeof password === 'string' && crypto.timingSafeEqual(await scrypt(password, pwSalt, 64), pwHash);
  if (!ok) {
    const count = (fail?.count || 0) + 1;
    const locked = count >= MAX_FAILURES;
    loginFailures.set(ip, { count: locked ? 0 : count, until: locked ? Date.now() + LOCKOUT_MS : 0 });
    return send(res, 401, { error: 'Wrong password' });
  }
  loginFailures.delete(ip);
  send(res, 200, { ...authStatus(req), authenticated: true }, { 'Set-Cookie': sessionCookie(req, newSessionToken()) });
}

function handleLogout(req, res) {
  send(res, 200, { ...authStatus(req), authenticated: false }, { 'Set-Cookie': sessionCookie(req, '') });
}

module.exports = { initAuth, isAuthenticated, canView, authStatus, handleLogin, handleLogout };
