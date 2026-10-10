"use strict";

const { createContext } = require("./context");
const { serveManifest } = require("../web/manifest");
const { serveStatic } = require("../web/static");
const { HttpError, send } = require("../lib/http");
const { handleApi } = require("./router");
const logger = require("../lib/logger");

async function handleRequest(req, res) {
  const started = process.hrtime.bigint();
  // Never include query strings: peer requests may carry sharing credentials.
  let route = "invalid";
  let failed = false;
  res.once("close", () => {
    const context = {
      method: req.method, route, status: res.statusCode,
      durationMs: Math.round(Number(process.hrtime.bigint() - started) / 1e6),
      aborted: !res.writableEnded,
    };
    if (failed) return;
    if (res.statusCode >= 500) logger.error("[HTTP] Request completed", context);
    else if (res.statusCode >= 400 || context.aborted) logger.warn("[HTTP] Request completed", context);
    // Polling and static reads repeat without state changes. Keep full read traces
    // opt-in without suppressing mutations, failures, or interrupted requests.
    else if (req.method === "GET" || req.method === "HEAD") logger.debug("[HTTP] Request completed", context);
    else logger.info("[HTTP] Request completed", context);
  });
  try {
    let context;
    try {
      context = createContext(req, res);
    } catch {
      return send(res, 400, "Bad request");
    }
    const { pathname } = context;
    route = pathname;
    logger.debug("[HTTP] Incoming request", { method: req.method, route });
    if (pathname.startsWith("/api/")) return await handleApi(context);
    if (req.method !== "GET" && req.method !== "HEAD")
      return send(res, 405, "Method not allowed");
    if (pathname === "/manifest.webmanifest")
      return await serveManifest(req, res);
    return await serveStatic(req, res, pathname);
  } catch (err) {
    if (res.destroyed || res.writableEnded) return;
    if (err instanceof HttpError)
      return send(res, err.status, { error: err.message });
    failed = true;
    logger.error("[HTTP] Request failed", {
      method: req.method, route, status: 500,
      durationMs: Math.round(Number(process.hrtime.bigint() - started) / 1e6),
      error: err,
    });
    const store = route.startsWith("/api/config") ? "Dashboard configuration"
      : route.startsWith("/api/availability") ? "Availability history"
      : route.startsWith("/api/clip") ? "Shared clipboard"
      : /^\/api\/(remotes|share)/.test(route) ? "Remote dashboard settings"
      : route === "/api/info/settings" ? "Server info settings"
      : route.startsWith("/api/tunables") ? "Timing settings" : null;
    const error = store ? `${store} could not be loaded or saved. Check the backend logs.`
      : "Internal server error";
    if (!res.headersSent) send(res, 500, { error });
    else res.destroy();
  }
}

module.exports = { handleRequest };
