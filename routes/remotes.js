"use strict";

const { readJson, HttpError } = require("../lib/http");
const remotes = require("../lib/remotes");
const { getServerInfo } = require("../lib/serverinfo");

async function authorizePeer(req) {
  const token =
    /^Bearer\s+(\S+)$/i.exec(req.headers.authorization || "")?.[1] || "";
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
        directory: query.get("directory") === "1",
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
    handler: async (req, res, context) => {
      const result = await remotes.saveRemotes(await readJson(req));
      context.activity = {
        title: "Remote dashboard connections saved",
        message: `${result.remotes.length} dashboard connections configured. URLs and tokens are not recorded in history.`,
      };
      return result;
    },
  },
  "PUT /api/share": {
    access: "edit",
    body: "json",
    handler: async (req, res, context) => {
      const result = await remotes.setSharing(
        Boolean((await readJson(req)).enabled),
      );
      context.activity = {
        title: result.shareToken
          ? "Remote sharing enabled"
          : "Remote sharing disabled",
        message: result.shareToken
          ? "A new share token was generated. Token not recorded in history."
          : "Peer dashboards can no longer read using this dashboard's saved share token.",
      };
      return result;
    },
  },
  "PUT /api/remotes/interval": {
    access: "edit",
    body: "json",
    handler: async (req, res, context) => {
      const result = await remotes.setRefreshInterval(await readJson(req));
      context.activity = {
        title: "Remote refresh interval updated",
        message: `Refresh remote dashboards every ${result.refreshInterval} seconds.`,
      };
      return result;
    },
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
