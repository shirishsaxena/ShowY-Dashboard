"use strict";

const { readJson } = require("../lib/http");
const {
  readClip,
  writeClip,
  deleteEntry,
  clearClip,
  saveClipSettings,
} = require("../lib/clip");

module.exports = {
  "GET /api/clip": {
    access: "view",
    body: "none",
    handler: () => readClip(),
  },
  "PUT /api/clip": {
    access: "edit",
    body: "json",
    handler: async (req) => writeClip(await readJson(req)),
  },
  "DELETE /api/clip": {
    access: "edit",
    body: "json",
    handler: () => clearClip(),
  },
  "DELETE /api/clip/entry": {
    access: "edit",
    body: "json",
    handler: async (req) => deleteEntry(await readJson(req)),
  },
  "PUT /api/clip/settings": {
    access: "edit",
    body: "json",
    handler: async (req, res, context) => {
      const result = await saveClipSettings(await readJson(req));
      context.activity = {
        title: "Clipboard history limit updated",
        message: `Keep up to ${result.max} items.`,
      };
      return result;
    },
  },
};
