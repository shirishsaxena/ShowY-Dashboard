"use strict";

const { Readable } = require("stream");
const { pipeline } = require("stream/promises");
const logger = require("../lib/logger");
const { HttpError, SECURITY_HEADERS } = require("../lib/http");

module.exports = {
  "GET /api/logs": {
    access: "edit",
    body: "none",
    handler: async (req, res) => {
      logger.info("[Logging] Log download requested");
      let files;
      try { files = await logger.snapshot(); }
      catch (err) {
        logger.error("[Logging] Cannot open log download", err);
        throw new HttpError(503, "Logs unavailable");
      }
      try {
        res.writeHead(200, {
          ...SECURITY_HEADERS,
          "Content-Type": "text/plain; charset=utf-8",
          "Content-Disposition": 'attachment; filename="backend-logs.txt"',
          "Cache-Control": "no-store",
        });
        async function* chunks() {
          for (const { handle, size } of files) {
            if (!size) continue;
            yield* handle.createReadStream({ start: 0, end: size - 1, autoClose: false });
          }
        }
        await pipeline(Readable.from(chunks()), res);
      } catch (err) {
        logger.warn("[Logging] Log download interrupted", err);
      } finally {
        await Promise.all(files.map(({ handle }) => handle.close().catch(() => {})));
      }
    },
  },
  "DELETE /api/logs": {
    access: "edit",
    body: "json",
    handler: async () => {
      try { await logger.clear(); }
      catch (err) {
        logger.error("[Logging] Cannot clear logs", err);
        throw new HttpError(503, "Could not clear logs");
      }
      return { ok: true };
    },
  },
};
