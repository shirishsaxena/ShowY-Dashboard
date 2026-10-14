"use strict";

const { LOCK_VIEW } = require("../lib/env");
const { send } = require("../lib/http");
const { readConfig } = require("../lib/config");

/** The optional install name is public; never expose a locked dashboard's title. */
async function serveManifest(req, res) {
  const { settings = {} } = await readConfig();
  const appName = typeof settings.appName === "string" ? settings.appName.trim().slice(0, 60) : "";
  const title = appName || (LOCK_VIEW ? "Dashboard" : settings.title || "Home Lab");
  const icon = (src, size, purpose = "any") => ({
    src,
    sizes: `${size}x${size}`,
    type: "image/png",
    purpose,
  });
  const manifest = {
    name: title,
    // Do not truncate explicit names: deployment names often differ at the end.
    short_name: appName || title.slice(0, 12),
    id: "/",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#0b0f17",
    theme_color: "#0b0f17",
    icons: [
      icon("/icons/icon-192.png", 192),
      icon("/icons/icon-512.png", 512),
      icon("/icons/icon-maskable-512.png", 512, "maskable"),
    ],
  };
  send(res, 200, JSON.stringify(manifest), {
    "Content-Type": "application/manifest+json",
    "Cache-Control": "no-cache",
  });
}

module.exports = { serveManifest };
