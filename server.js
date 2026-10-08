'use strict';
// Homelab dashboard server - zero dependencies (Node 18+).
// Serves the UI, stores the config as JSON (editable from the UI) and reports
// Docker containers, host stats and service up/down status.

const http = require('http');
const fsp = require('fs').promises;
const path = require('path');

const { VERSION, PORT, PUBLIC_DIR, CONFIG_FILE, PASSWORD, LOCK_VIEW } = require('./lib/env');
const { HttpError, SECURITY_HEADERS, send, readJson } = require('./lib/http');
const { readConfig, writeConfig, sanitizeConfig } = require('./lib/config');
const auth = require('./lib/auth');
const { getStats } = require('./lib/system');
const { getContainers, getContainerStats } = require('./lib/docker');
const { getHealth, invalidateHealth } = require('./lib/health');
const { readClip, writeClip, deleteEntry, clearClip, saveClipSettings } = require('./lib/clip');
const { handleIcon, iconCacheInfo, clearIconCache } = require('./lib/icons');
const remotes = require('./lib/remotes');
const availability = require('./lib/availability');
const serverinfo = require('./lib/serverinfo');
const tunables = require('./lib/tunables');
const { getStorage } = require('./lib/storage');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

// ---------- API ----------

/** Reachable without logging in. */
const PUBLIC_ROUTES = {
  'GET /api/auth': (req, res) => send(res, 200, auth.authStatus(req)),
  'POST /api/login': auth.handleLogin,
  'POST /api/logout': auth.handleLogout,
  // Other dashboards, with this one's share token.
  'GET /api/peer': remotes.handlePeer,
  'GET /api/peer/info': remotes.handlePeerInfo,
};

/** Wraps a route that changes something: needs a login when a password is set. */
const editOnly = (handler) => async (req, res) => {
  if (!auth.isAuthenticated(req)) return send(res, 401, { error: 'Login required' });
  return handler(req, res);
};

/** Need view access (a login when DASHBOARD_LOCK_VIEW is on). */
const ROUTES = {
  'GET /api/config': async (req, res) => send(res, 200, { config: await readConfig(), version: VERSION, tunables: tunables.clientValues() }),
  'GET /api/tunables': async (req, res) => send(res, 200, tunables.list()),
  'PUT /api/tunables': editOnly(async (req, res) => {
    const items = await tunables.save((await readJson(req)).values);
    send(res, 200, { items, client: tunables.clientValues() });
  }),
  'GET /api/docker': async (req, res) => send(res, 200, await getContainers()),
  'GET /api/docker/stats': async (req, res) => send(res, 200, await getContainerStats({ fresh: req.url.includes('fresh=1') })),
  'GET /api/stats': async (req, res) => send(res, 200, await getStats()),
  'GET /api/health': async (req, res) => send(res, 200, await getHealth({ fresh: req.url.includes('fresh=1') })),
  'PUT /api/config': async (req, res) => {
    if (!auth.isAuthenticated(req)) return send(res, 401, { error: 'Login required' });
    const config = sanitizeConfig(await readJson(req));
    await writeConfig(config);
    invalidateHealth();
    send(res, 200, { config });
  },
  'GET /api/clip': async (req, res) => send(res, 200, await readClip()),
  'PUT /api/clip': editOnly(async (req, res) => send(res, 200, await writeClip(await readJson(req)))),
  'DELETE /api/clip': editOnly(async (req, res) => send(res, 200, await clearClip())),
  'DELETE /api/clip/entry': editOnly(async (req, res) => send(res, 200, await deleteEntry(await readJson(req)))),
  'PUT /api/clip/settings': editOnly(async (req, res) => send(res, 200, await saveClipSettings(await readJson(req)))),
  'GET /api/storage': async (req, res) => send(res, 200, await getStorage()),
  'GET /api/icon': handleIcon,
  'GET /api/icons': async (req, res) => send(res, 200, await iconCacheInfo()),
  'DELETE /api/icons': async (req, res) => {
    if (!auth.isAuthenticated(req)) return send(res, 401, { error: 'Login required' });
    send(res, 200, await clearIconCache());
  },
  'GET /api/availability': async (req, res) => send(res, 200, await availability.getAvailability({ outages: availability.MAX_OUTAGES })),
  'PUT /api/availability/settings': editOnly(async (req, res) => send(res, 200, await availability.saveSettings(await readJson(req)))),
  'DELETE /api/availability': editOnly(async (req, res) => send(res, 200, await availability.clearHistory())),
  'GET /api/info': async (req, res) => send(res, 200, await serverinfo.getServerInfo()),
  'GET /api/info/settings': async (req, res) => send(res, 200, await serverinfo.getSettings()),
  'PUT /api/info/settings': editOnly(async (req, res) => send(res, 200, await serverinfo.saveSettings(await readJson(req)))),
  'GET /api/remotes/info': async (req, res) =>
    send(res, 200, await remotes.getRemoteInfo(new URL(req.url, 'http://x').searchParams.get('id') || '')),
  'GET /api/remotes': async (req, res) => {
    const query = new URL(req.url, 'http://x').searchParams;
    send(res, 200, await remotes.getRemotes({ fresh: query.get('fresh') || '', only: query.get('id') || '' }));
  },
  'GET /api/remotes/settings': editOnly(async (req, res) => send(res, 200, await remotes.remoteSettings())),
  'PUT /api/remotes/settings': editOnly(async (req, res) => send(res, 200, await remotes.saveRemotes(await readJson(req)))),
  'PUT /api/share': editOnly(async (req, res) => send(res, 200, await remotes.setSharing(Boolean((await readJson(req)).enabled)))),
  'PUT /api/remotes/interval': editOnly(async (req, res) => send(res, 200, await remotes.setRefreshInterval(await readJson(req)))),
};

async function handleApi(req, res, pathname) {
  // JSON-only writes + SameSite=Strict cookie protect against CSRF.
  if (req.method !== 'GET' && !String(req.headers['content-type'] || '').startsWith('application/json')) {
    return send(res, 415, { error: 'Expected application/json' });
  }
  const key = `${req.method} ${pathname}`;
  if (PUBLIC_ROUTES[key]) return PUBLIC_ROUTES[key](req, res);
  if (!ROUTES[key]) return send(res, 404, { error: 'Not found' });
  if (!auth.canView(req)) return send(res, 401, { error: 'Locked' });
  return ROUTES[key](req, res);
}

// ---------- Web app ----------

/** PWA manifest; the title is only exposed when viewing doesn't need a login. */
async function serveManifest(req, res) {
  const title = LOCK_VIEW ? 'Dashboard' : (await readConfig()).settings?.title || 'Home Lab';
  const icon = (src, size, purpose = 'any') => ({ src, sizes: `${size}x${size}`, type: 'image/png', purpose });
  const manifest = {
    name: title,
    short_name: title.slice(0, 12),
    id: '/',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    background_color: '#0b0f17',
    theme_color: '#0b0f17',
    icons: [
      icon('/icons/icon-192.png', 192),
      icon('/icons/icon-512.png', 512),
      icon('/icons/icon-maskable-512.png', 512, 'maskable'),
    ],
  };
  send(res, 200, JSON.stringify(manifest), { 'Content-Type': 'application/manifest+json', 'Cache-Control': 'no-cache' });
}

async function serveStatic(req, res, pathname) {
  let rel;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    return send(res, 400, 'Bad request');
  }
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.join(PUBLIC_DIR, path.normalize(rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 403, 'Forbidden');

  let stat;
  try {
    stat = await fsp.stat(file);
    if (!stat.isFile()) throw new Error('Not a file');
  } catch {
    return send(res, 404, 'Not found');
  }
  const etag = `W/"${stat.size.toString(36)}-${Math.floor(stat.mtimeMs).toString(36)}"`;
  const headers = {
    ...SECURITY_HEADERS,
    'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'Cache-Control': 'no-cache',
    ETag: etag,
  };
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, headers);
    return res.end();
  }
  if (req.method === 'HEAD') {
    res.writeHead(200, headers);
    return res.end();
  }
  const data = await fsp.readFile(file);
  res.writeHead(200, headers);
  res.end(data);
}

// ---------- Server ----------

const server = http.createServer(async (req, res) => {
  try {
    let pathname;
    try {
      ({ pathname } = new URL(req.url, 'http://localhost'));
    } catch {
      return send(res, 400, 'Bad request');
    }
    if (pathname.startsWith('/api/')) return await handleApi(req, res, pathname);
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
    if (pathname === '/manifest.webmanifest') return await serveManifest(req, res);
    return await serveStatic(req, res, pathname);
  } catch (err) {
    if (err instanceof HttpError) return send(res, err.status, { error: err.message });
    console.error(err);
    if (!res.headersSent) send(res, 500, { error: 'Internal server error' });
  }
});

// A clean stop stamps a last heartbeat, so a quick restart is not recorded as an outage.
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    availability.flushSync();
    process.exit(0);
  });
}

Promise.all([auth.initAuth(), availability.init()]).then(() => {
  server.listen(PORT, () => {
    console.log(`Dashboard v${VERSION} running on http://localhost:${PORT}`);
    console.log(`Config: ${CONFIG_FILE}`);
    console.log(PASSWORD ? `Password: on (${LOCK_VIEW ? 'required to view' : 'required to edit'})` : 'Password: off');
  });
});
