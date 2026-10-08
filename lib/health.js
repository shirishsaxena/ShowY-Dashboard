'use strict';
// Up/down checks: a plain HTTP(S) GET against every service URL, cached for a short while.
// Any response below 500 (including 401/403 from a login page) counts as "up" - except 404:
// that usually means the URL hit something else (reverse proxy, another app), not the service.

const http = require('http');
const https = require('https');
const { readConfig } = require('./config');
const { get } = require('./tunables');

// Timeout, cache time, forced-refresh gap and parallel checks come from lib/tunables.js (Settings / docker-compose).
const ms = (key) => get(key) * 1000;

let cache = { checkedAt: 0, results: {} };
let pending = null;

function check(url) {
  return new Promise((resolve) => {
    const started = Date.now();
    let target;
    try {
      target = new URL(url);
    } catch {
      return resolve({ state: 'down', error: 'Invalid URL' });
    }
    const client = target.protocol === 'https:' ? https : http;
    const req = client.request(
      target,
      {
        method: 'GET',
        agent: false,
        timeout: ms('healthTimeout'),
        // Reachability only - self-signed certificates are common in a homelab.
        rejectUnauthorized: false,
        headers: { 'User-Agent': 'HomeLab-Dashboard/1.0 (health check)', Accept: '*/*' },
      },
      (res) => {
        const code = res.statusCode;
        res.destroy();
        resolve({ state: code < 500 && code !== 404 ? 'up' : 'error', code, ms: Date.now() - started });
      }
    );
    req.on('timeout', () => req.destroy(new Error('Timed out')));
    req.on('error', (err) => resolve({ state: 'down', error: err.code || err.message }));
    req.end();
  });
}

async function runChecks() {
  const config = await readConfig();
  const services = (config.servers || []).flatMap((s) => s.services || []);
  // Several services may share a URL - check each URL once.
  const urlOf = new Map(services.map((svc) => [svc.id, svc.url || svc.altUrl]).filter(([, url]) => url));
  const urls = [...new Set(urlOf.values())];
  const byUrl = new Map();
  let next = 0;
  const worker = async () => {
    while (next < urls.length) {
      const url = urls[next++];
      byUrl.set(url, await check(url));
    }
  };
  await Promise.all(Array.from({ length: Math.min(get('healthParallel'), urls.length) }, worker));

  const results = {};
  for (const [id, url] of urlOf) results[id] = byUrl.get(url);
  return { checkedAt: Date.now(), results };
}

/**
 * Cached results; a stale cache triggers a new round (callers share one in-flight run).
 * fresh = accept results only a few seconds old (manual refresh button).
 */
async function getHealth({ fresh = false } = {}) {
  if (Date.now() - cache.checkedAt < (fresh ? ms('refreshGap') : ms('healthCache'))) return cache;
  pending ??= runChecks()
    .then((fresh) => (cache = fresh))
    .finally(() => (pending = null));
  return pending;
}

/** Forget cached results (e.g. after the config changed). */
function invalidateHealth() {
  cache = { ...cache, checkedAt: 0 };
}

module.exports = { getHealth, invalidateHealth };
