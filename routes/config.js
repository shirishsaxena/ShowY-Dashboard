"use strict";

const { VERSION } = require("../lib/env");
const { readJson } = require("../lib/http");
const {
  readConfig,
  writeConfig,
  sanitizeConfig,
  configRevision,
} = require("../lib/config");
const { invalidateHealth } = require("../lib/health");
const tunables = require("../lib/tunables");
const { describeConfigChanges } = require("../lib/config-activity");

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
    handler: async (req, res, context) => {
      const { values } = await readJson(req);
      const items = await tunables.save(values);
      context.activity = {
        title: "Monitoring timings updated",
        message: items
          .filter((item) => Object.hasOwn(values, item.key))
          .map(
            (item) =>
              `${item.label}: ${item.value}${item.unit ? ` ${item.unit}` : ""}`,
          )
          .join("; "),
      };
      return { items, client: tunables.clientValues() };
    },
  },
  "PUT /api/config": {
    access: "edit",
    body: "json",
    handler: async (req, res, context) => {
      const body = await readJson(req);
      const config = sanitizeConfig(body);
      // Optional for legacy whole-document clients; never persisted in config.
      const { revision, previous } = await writeConfig(config, body._revision, {
        includePrevious: true,
      });
      // Compare canonical views, so legacy/default fields are not mistaken for
      // user edits merely because this is the first save under the current schema.
      context.activity = () =>
        describeConfigChanges(sanitizeConfig(previous), config);
      invalidateHealth();
      return { config, revision };
    },
  },
};
