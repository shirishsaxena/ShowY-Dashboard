"use strict";

const { getIcon, iconCacheInfo, clearIconCache } = require("../lib/icons");
const { SECURITY_HEADERS } = require("../lib/http");

async function handleIcon(req, res, context) {
  const { data, etag, contentType } = await getIcon(context.query.get("icon") || "");
  const headers = {
    ...SECURITY_HEADERS,
    // SVGs must remain sandboxed even when opened directly.
    "Content-Security-Policy":
      "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    "Content-Type": contentType,
    "Cache-Control": "no-cache",
    ETag: etag,
  };
  if (req.headers["if-none-match"] === etag) {
    res.writeHead(304, headers);
    return res.end();
  }
  res.writeHead(200, headers);
  res.end(data);
}

module.exports = {
  "GET /api/icon": {
    access: "view",
    body: "none",
    handler: handleIcon,
  },
  "GET /api/icons": {
    access: "view",
    body: "none",
    handler: () => iconCacheInfo(),
  },
  "DELETE /api/icons": {
    access: "edit",
    body: "json",
    handler: () => clearIconCache(),
  },
};
