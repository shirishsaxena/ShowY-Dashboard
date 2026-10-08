'use strict';
// Small HTTP helpers shared by the routes.

const MAX_BODY = 1024 * 1024;

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': [
    "default-src 'self'",
    "img-src 'self' https: http: data:",
    "style-src 'self' 'unsafe-inline'",
    "script-src 'self'",
    // jsDelivr: the dashboard-icons index used by the icon picker.
    "connect-src 'self' https://cdn.jsdelivr.net",
    "worker-src 'self'",
    "manifest-src 'self'",
    "frame-ancestors 'none'",
  ].join('; '),
};

/** An error whose message is safe to show to the client. */
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const badRequest = (message) => new HttpError(400, message);

function send(res, status, body, headers = {}) {
  const isJson = typeof body !== 'string' && !Buffer.isBuffer(body);
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Type': isJson ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(isJson ? JSON.stringify(body) : body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new HttpError(413, 'Request body too large'));
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const raw = await readBody(req);
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    throw badRequest('Invalid JSON');
  }
}

module.exports = { SECURITY_HEADERS, HttpError, badRequest, send, readJson };
