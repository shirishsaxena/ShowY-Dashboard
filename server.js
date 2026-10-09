"use strict";
// Homelab dashboard server - zero dependencies (Node 18+).

const http = require("http");
const { handleRequest } = require("./http/handler");
const { VERSION, PORT, CONFIG_FILE, PASSWORD, LOCK_VIEW } = require("./lib/env");
const auth = require("./lib/auth");
const availability = require("./lib/availability");
const logger = require("./lib/logger");

function createServer() {
  return http.createServer(handleRequest);
}

async function start() {
  const server = createServer();
  let shuttingDown = false;

  // Stamp a final heartbeat so a quick restart is not recorded as an outage.
  function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("[Lifecycle] Shutdown requested", { signal });
    let finishing = false;
    const finish = async () => {
      if (finishing) return;
      finishing = true;
      availability.flushSync();
      logger.info("[Lifecycle] Shutdown complete");
      await logger.close();
      process.exit(0);
    };
    if (!server.listening) return finish();
    const timeout = setTimeout(finish, 10000);
    timeout.unref();
    server.close(() => {
      clearTimeout(timeout);
      finish();
    });
    server.closeIdleConnections?.();
  }

  const removeSignalHandlers = () => {
    process.removeListener("SIGTERM", shutdown);
    process.removeListener("SIGINT", shutdown);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  server.once("close", removeSignalHandlers);

  try {
    logger.info("[Lifecycle] Starting dashboard", { version: VERSION, config: CONFIG_FILE, logFile: logger.filename });
    await Promise.all([auth.initAuth(), availability.init()]);
    if (shuttingDown) return server;
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(PORT, () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    logger.info(`[HTTP] Dashboard v${VERSION} listening on port ${PORT}`);
    logger.info(
      PASSWORD
        ? `Password: on (${LOCK_VIEW ? "required to view" : "required to edit"})`
        : "Password: off",
    );
    return server;
  } catch (err) {
    removeSignalHandlers();
    throw err;
  }
}

if (require.main === module) {
  process.on("uncaughtException", async (err) => {
    logger.error("[Lifecycle] Uncaught exception", err);
    await logger.close();
    process.exit(1);
  });
  process.on("unhandledRejection", async (err) => {
    logger.error("[Lifecycle] Unhandled rejection", err);
    await logger.close();
    process.exit(1);
  });
  start().catch(async (err) => {
    logger.error("[Lifecycle] Fatal startup error", err);
    await logger.close();
    process.exit(1);
  });
}

module.exports = { createServer, start };
