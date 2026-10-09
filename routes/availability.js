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
    handler: async (req) => availability.saveSettings(await readJson(req)),
  },
  "DELETE /api/availability": {
    access: "edit",
    body: "json",
    handler: () => availability.clearHistory(),
  },
};
