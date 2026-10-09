"use strict";

const { readJson } = require("../lib/http");
const { getStats } = require("../lib/system");
const { getContainers, getContainerStats } = require("../lib/docker");
const { getHealth } = require("../lib/health");
const { getStorage } = require("../lib/storage");
const serverinfo = require("../lib/serverinfo");

module.exports = {
  "GET /api/docker": {
    access: "view",
    body: "none",
    handler: () => getContainers(),
  },
  "GET /api/docker/stats": {
    access: "view",
    body: "none",
    handler: (req, res, context) =>
      getContainerStats({ fresh: context.fresh }),
  },
  "GET /api/stats": {
    access: "view",
    body: "none",
    handler: () => getStats(),
  },
  "GET /api/health": {
    access: "view",
    body: "none",
    handler: (req, res, context) =>
      getHealth({ fresh: context.fresh }),
  },
  "GET /api/storage": {
    access: "view",
    body: "none",
    handler: () => getStorage(),
  },
  "GET /api/info": {
    access: "view",
    body: "none",
    handler: () => serverinfo.getServerInfo(),
  },
  "GET /api/info/settings": {
    access: "view",
    body: "none",
    handler: () => serverinfo.getSettings(),
  },
  "PUT /api/info/settings": {
    access: "edit",
    body: "json",
    handler: async (req) => serverinfo.saveSettings(await readJson(req)),
  },
};
