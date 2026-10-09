"use strict";

const { VERSION } = require("../lib/env");
const { readJson } = require("../lib/http");
const { readConfig, writeConfig, sanitizeConfig } = require("../lib/config");
const { invalidateHealth } = require("../lib/health");
const tunables = require("../lib/tunables");

module.exports = {
  "GET /api/config": {
    access: "view",
    body: "none",
    handler: async () => ({
      config: await readConfig(),
      version: VERSION,
      tunables: tunables.clientValues(),
    }),
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
      const config = sanitizeConfig(await readJson(req));
      await writeConfig(config);
      invalidateHealth();
      return { config };
    },
  },
};
