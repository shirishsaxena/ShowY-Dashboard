"use strict";

const { readJson, HttpError } = require("../lib/http");
const remotes = require("../lib/remotes");
const { getServerInfo } = require("../lib/serverinfo");

async function authorizePeer(req) {
  const token = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization || "")?.[1] || "";
  if (!(await remotes.peerAuthorized(token))) {
    throw new HttpError(401, "Invalid share token");
  }
}

module.exports = {
  "GET /api/remotes/info": {
    access: "view",
    body: "none",
    handler: (req, res, context) =>
      remotes.getRemoteInfo(context.query.get("id") || ""),
  },
  "GET /api/remotes": {
    access: "view",
    body: "none",
    handler: (req, res, context) => {
      const { query } = context;
      return remotes.getRemotes({
        fresh: query.get("fresh") || "",
        only: query.get("id") || "",
      });
    },
  },
  "GET /api/remotes/settings": {
    access: "edit",
    body: "none",
    handler: () => remotes.remoteSettings(),
  },
  "PUT /api/remotes/settings": {
    access: "edit",
    body: "json",
    handler: async (req) => remotes.saveRemotes(await readJson(req)),
  },
  "PUT /api/share": {
    access: "edit",
    body: "json",
    handler: async (req) => remotes.setSharing(Boolean((await readJson(req)).enabled)),
  },
  "PUT /api/remotes/interval": {
    access: "edit",
    body: "json",
    handler: async (req) => remotes.setRefreshInterval(await readJson(req)),
  },
  // Other dashboards, with this one's share token.
  "GET /api/peer": {
    access: "public",
    body: "none",
    handler: async (req, res, context) => {
      await authorizePeer(req);
      return remotes.getPeerData({ fresh: context.fresh });
    },
  },
  "GET /api/peer/info": {
    access: "public",
    body: "none",
    handler: async (req) => {
      await authorizePeer(req);
      return getServerInfo();
    },
  },
};
