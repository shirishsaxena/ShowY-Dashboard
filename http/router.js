"use strict";

const routes = require("../routes/index");
const auth = require("../lib/auth");
const { send } = require("../lib/http");
const logger = require("../lib/logger");

async function handleApi(context) {
  const { req, res, pathname } = context;
  const route = routes[`${req.method} ${pathname}`];
  // Preserve validation before matching/auth, including unsupported API methods.
  const body = route ? route.body : req.method === "GET" ? "none" : "json";
  if (
    body === "json" &&
    !String(req.headers["content-type"] || "").startsWith("application/json")
  ) {
    return send(res, 415, { error: "Expected application/json" });
  }
  if (!route) return send(res, 404, { error: "Not found" });
  if (route.access !== "public") {
    if (!auth.canView(req)) {
      logger.debug("[Auth] View access denied", { method: req.method, pathname });
      return send(res, 401, { error: "Locked" });
    }
    if (route.access === "edit" && !auth.isAuthenticated(req)) {
      logger.debug("[Auth] Edit access denied", { method: req.method, pathname });
      return send(res, 401, { error: "Login required" });
    }
  }
  const result = await route.handler(req, res, context);
  if (!res.headersSent && result !== undefined) {
    return send(res, 200, result);
  }
}

module.exports = { handleApi };
