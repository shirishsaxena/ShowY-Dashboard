"use strict";

const fsp = require("fs").promises;
const path = require("path");
const { pipeline } = require("stream/promises");
const { PUBLIC_DIR } = require("../lib/env");
const { SECURITY_HEADERS, send } = require("../lib/http");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

async function serveStatic(req, res, pathname) {
  let relativePath;
  try {
    relativePath = decodeURIComponent(pathname);
  } catch {
    return send(res, 400, "Bad request");
  }
  if (relativePath.endsWith("/")) relativePath += "index.html";
  const file = path.join(PUBLIC_DIR, path.normalize(relativePath));
  if (!file.startsWith(PUBLIC_DIR + path.sep))
    return send(res, 403, "Forbidden");

  let stat;
  try {
    stat = await fsp.stat(file);
    if (!stat.isFile()) throw new Error("Not a file");
  } catch {
    return send(res, 404, "Not found");
  }
  const etag = `W/"${stat.size.toString(36)}-${Math.floor(stat.mtimeMs).toString(36)}"`;
  const headers = {
    ...SECURITY_HEADERS,
    "Content-Type":
      MIME[path.extname(file).toLowerCase()] || "application/octet-stream",
    "Cache-Control": "no-cache",
    ETag: etag,
  };
  if (req.headers["if-none-match"] === etag) {
    res.writeHead(304, headers);
    return res.end();
  }
  if (req.method === "HEAD") {
    res.writeHead(200, headers);
    return res.end();
  }
  const handle = await fsp.open(file, "r");
  try {
    res.writeHead(200, headers);
    await pipeline(handle.createReadStream(), res);
  } finally {
    await handle.close();
  }
}

module.exports = { serveStatic };
