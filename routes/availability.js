"use strict";

const { readJson } = require("../lib/http");
const availability = require("../lib/availability");

module.exports = {
  "GET /api/availability": {
    access: "view",
    body: "none",
    handler: () =>
      availability.getAvailability({ outages: availability.MAX_OUTAGES }),
  },
  "PUT /api/availability/settings": {
    access: "edit",
    body: "json",
    handler: async (req, res, context) => {
      const result = await availability.saveSettings(await readJson(req));
      context.activity = {
        title: result.enabled
          ? "Availability monitoring enabled"
          : "Availability monitoring paused",
        message: `Heartbeat interval: ${result.interval} minutes. Outage threshold: ${result.threshold} minutes.`,
      };
      return result;
    },
  },
  "DELETE /api/availability": {
    access: "edit",
    body: "json",
    handler: () => availability.clearHistory(),
  },
};
