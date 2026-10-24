"use strict";

const activity = require("../lib/activity");
const control = require("../lib/docker-control");
const { readJson, send, HttpError } = require("../lib/http");
const { TRUST_PROXY } = require("../lib/env");

function requireSameOrigin(req) {
  const scheme = req.socket.encrypted || (TRUST_PROXY && req.headers["x-forwarded-proto"] === "https") ? "https:" : "http:";
  let origin;
  try { origin = new URL(req.headers.origin); } catch { /* rejected below */ }
  if (!origin || origin.origin !== `${scheme}//${req.headers.host}` ||
      (req.headers["sec-fetch-site"] && req.headers["sec-fetch-site"] !== "same-origin"))
    throw new HttpError(403, "This action requires a same-origin request");
}

module.exports = {
  "GET /api/activity": {
    access: "edit", body: "none",
    handler: async () => ({ ...(await activity.snapshot()), control: control.controlState() }),
  },
  "DELETE /api/activity": {
    access: "edit", body: "json",
    handler: async (req) => {
      requireSameOrigin(req);
      await readJson(req);
      return { ...(await activity.clear()), control: control.controlState() };
    },
  },
  "POST /api/docker/action": {
    access: "edit", body: "json",
    handler: async (req, res) => {
      requireSameOrigin(req);
      const entry = await control.submit(await readJson(req));
      send(res, entry.status === "pending" ? 202 : 200, { entry });
    },
  },
};
