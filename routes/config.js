"use strict";

const { VERSION } = require("../lib/env");
const { readJson } = require("../lib/http");
const { readConfig, writeConfig, sanitizeConfig, configRevision } = require("../lib/config");
const { invalidateHealth } = require("../lib/health");
const tunables = require("../lib/tunables");

module.exports = {
  "GET /api/config": {
    access: "view",
    body: "none",
    handler: async () => {
      const config = await readConfig();
      return {
        config,
        revision: configRevision(config),
        version: VERSION,
        tunables: tunables.clientValues(),
      };
    },
  },
  "GET /api/tunables": {
    access: "view",
    body: "none",
    handler: () => tunables.list(),
  },
  "PUT /api/tunables": {
    access: "edit",
    body: "json",
    handler: async (req) => {
      const items = await tunables.save((await readJson(req)).values);
      return { items, client: tunables.clientValues() };
    },
  },
  "PUT /api/config": {
    access: "edit",
    body: "json",
    handler: async (req) => {
      const body = await readJson(req);
      const config = sanitizeConfig(body);
      // Optional for legacy whole-document clients; never persisted in config.
      const revision = await writeConfig(config, body._revision);
      invalidateHealth();
      return { config, revision };
    },
  },
};
