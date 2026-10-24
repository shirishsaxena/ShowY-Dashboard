"use strict";

const { readJson } = require("../lib/http");
const { getStats } = require("../lib/system");
const { getContainers, getContainerStats } = require("../lib/docker");
const { getContainerLogs } = require("../lib/docker-logs");
const { getContainerDetails } = require("../lib/docker-details");
const { controlState, protectedTarget } = require("../lib/docker-control");
const { getHealth } = require("../lib/health");
const { getStorage } = require("../lib/storage");
const serverinfo = require("../lib/serverinfo");

module.exports = {
  "GET /api/docker": {
    access: "view",
    body: "none",
    handler: async () => {
      const result = await getContainers();
      return {
        ...result,
        control: controlState(),
        containers: result.containers.map((container) => ({
          ...container,
          protected:
            container.protected ||
            protectedTarget(container.id || "", container.name),
        })),
      };
    },
  },
  "GET /api/docker/stats": {
    access: "view",
    body: "none",
    handler: (req, res, context) => getContainerStats({ fresh: context.fresh }),
  },
  "GET /api/docker/logs": {
    // Logs can contain secrets: require the same access as backend log downloads.
    access: "edit",
    body: "none",
    handler: async (req, res, { query }) => {
      const controller = new AbortController();
      const abort = () => controller.abort();
      res.once("close", abort);
      try {
        return await getContainerLogs(query.get("id"), {
          tail: query.has("tail") ? Number(query.get("tail")) : 250,
          signal: controller.signal,
        });
      } finally {
        res.removeListener("close", abort);
      }
    },
  },
  "GET /api/docker/details": {
    // Only explicitly whitelisted metadata, consistent with viewable Docker usage.
    access: "view",
    body: "none",
    handler: async (req, res, { query }) => {
      const controller = new AbortController();
      const abort = () => controller.abort();
      res.once("close", abort);
      try {
        return await getContainerDetails(query.get("id"), {
          signal: controller.signal,
        });
      } finally {
        res.removeListener("close", abort);
      }
    },
  },
  "GET /api/stats": {
    access: "view",
    body: "none",
    handler: () => getStats(),
  },
  "GET /api/health": {
    access: "view",
    body: "none",
    handler: (req, res, context) => getHealth({ fresh: context.fresh }),
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
