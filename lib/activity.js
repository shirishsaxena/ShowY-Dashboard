"use strict";

// Bounded, persistent activity journal. Never store request bodies or credentials.
const fs = require("fs").promises;
const crypto = require("crypto");
const { ACTIVITY_FILE } = require("./env");
const { writeAtomic } = require("./config");
const logger = require("./logger");
const { HttpError } = require("./http");
const LIMIT = 200;
let entries;
let retired = []; // Minimal replay receipts, not visible history or descriptive text.
let loading;
let queue = Promise.resolve();
let persistenceError = false;

async function init() {
  if (entries) return;
  loading ||= (async () => {
    let data;
    try {
      data = JSON.parse(await fs.readFile(ACTIVITY_FILE, "utf8"));
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
      data = [];
    }
    const visible = Array.isArray(data) ? data : data?.entries;
    const receipts = Array.isArray(data) ? [] : data?.retired;
    if (
      !Array.isArray(visible) ||
      visible.length > LIMIT ||
      visible.some(
        (entry) =>
          !entry ||
          typeof entry.id !== "string" ||
          typeof entry.title !== "string" ||
          !Number.isFinite(entry.at) ||
          !Number.isFinite(entry.updatedAt) ||
          !["pending", "success", "failed", "uncertain"].includes(entry.status),
      )
    )
      throw new Error("Invalid activity history");
    if (
      !Array.isArray(receipts) ||
      receipts.length > LIMIT ||
      receipts.some(
        (entry) =>
          !entry ||
          typeof entry.id !== "string" ||
          !/^[a-f0-9]{64}$/.test(entry.containerId) ||
          !["start", "stop", "restart"].includes(entry.action) ||
          !["success", "failed", "uncertain"].includes(entry.status),
      )
    )
      throw new Error("Invalid activity receipts");
    // A lost process cannot claim that an outstanding Docker request failed or succeeded.
    const recovered = visible.map((entry) =>
      entry.status === "pending"
        ? {
            ...entry,
            status: "uncertain",
            updatedAt: Date.now(),
            message:
              "Dashboard restarted before completion was recorded. Check container state before retrying.",
          }
        : entry,
    );
    if (recovered.some((entry, index) => entry !== visible[index]))
      await writeAtomic(
        ACTIVITY_FILE,
        JSON.stringify({ entries: recovered, retired: receipts }),
      );
    entries = recovered;
    retired = receipts;
  })().catch((err) => {
    loading = null;
    throw err;
  });
  await loading;
}

function mutate(change, { required = true } = {}) {
  const run = queue.then(async () => {
    await init();
    const changed = change(entries);
    // Never evict an outstanding action just because many dashboard edits arrive.
    const pending = changed.filter((entry) => entry.status === "pending");
    const completed = changed
      .filter((entry) => entry.status !== "pending")
      .slice(-(LIMIT - pending.length));
    const keep = new Set([...pending, ...completed]);
    const next = changed.filter((entry) => keep.has(entry));
    const keptIds = new Set(next.map((entry) => entry.id));
    const removed = entries.filter(
      (entry) =>
        !keptIds.has(entry.id) &&
        entry.containerId &&
        entry.status !== "pending",
    );
    const nextRetired = [
      ...retired,
      ...removed.map(({ id, containerId, action, status }) => ({
        id,
        containerId,
        action,
        status,
      })),
    ].slice(-LIMIT);
    try {
      await writeAtomic(
        ACTIVITY_FILE,
        JSON.stringify({ entries: next, retired: nextRetired }),
      );
      persistenceError = false;
    } catch (err) {
      persistenceError = true;
      logger.error("[Activity] Could not persist action history", err);
      if (required) throw err;
      // A completed mutation must never be reported as failed just because journaling failed.
    }
    entries = next;
    retired = nextRetired;
  });
  queue = run.catch(() => {});
  return run;
}

async function snapshot() {
  await queue;
  await init();
  return {
    entries: structuredClone(entries).reverse(),
    retired: structuredClone(retired),
    limit: LIMIT,
    persistenceError,
  };
}

async function add(fields, options) {
  const now = Date.now();
  const entry = {
    id: fields.id || crypto.randomUUID(),
    at: now,
    updatedAt: now,
    title: String(fields.title || "Dashboard action").slice(0, 200),
    status: fields.status || "success",
    message: String(fields.message || "").slice(0, 400),
    ...(fields.containerId
      ? { containerId: fields.containerId, action: fields.action }
      : {}),
  };
  await mutate((items) => {
    if ([...items, ...retired].some((item) => item.id === entry.id))
      throw new HttpError(409, "Action request already recorded");
    return [...items, entry];
  }, options);
  return entry;
}

async function complete(id, status, message) {
  await mutate(
    (items) =>
      items.map((entry) =>
        entry.id === id
          ? {
              ...entry,
              status,
              message: message.slice(0, 400),
              updatedAt: Date.now(),
            }
          : entry,
      ),
    { required: false },
  );
}

async function clear() {
  let removed = 0;
  await mutate((items) => {
    const keep = items.filter((entry) => entry.status === "pending");
    removed = items.length - keep.length;
    return keep;
  });
  return { ...(await snapshot()), removed };
}

// Deliberate allowlist: no login bodies, tokens, clipboard text, URLs, or routine reads.
const ACTIONS = {
  "PUT /api/config": "Dashboard configuration updated",
  "PUT /api/tunables": "Monitoring timings updated",
  "PUT /api/info/settings": "Server information settings updated",
  "PUT /api/clip": "Clipboard item shared",
  "DELETE /api/clip": "Clipboard history cleared",
  "DELETE /api/clip/entry": "Clipboard item deleted",
  "PUT /api/clip/settings": "Clipboard settings updated",
  "DELETE /api/icons": "Icon cache cleared",
  "DELETE /api/logs": "Backend logs cleared",
  "PUT /api/availability/settings": "Availability settings updated",
  "DELETE /api/availability": "Availability history cleared",
  "PUT /api/remotes/settings": "Remote dashboard settings updated",
  "PUT /api/share": "Remote sharing settings updated",
  "PUT /api/remotes/interval": "Remote refresh interval updated",
};

async function recordRequest(key, status, describe) {
  if (!ACTIONS[key]) return;
  try {
    let details;
    // Descriptions come only from trusted handlers after a successful commit.
    // Never describe rejected writes as if the requested changes happened.
    if (status < 400 && describe !== undefined) {
      try {
        details = typeof describe === "function" ? describe() : describe;
      } catch {
        logger.error(
          "[Activity] Could not describe action; using safe summary",
        );
      }
    }
    const fallback = {
      title: ACTIONS[key],
      message: status >= 400 ? `Request failed (HTTP ${status}).` : "",
    };
    const changes = Array.isArray(details) ? details : [details || fallback];
    // Empty details mean a successful no-op. Bulk edits have bounded summaries.
    for (const detail of changes.slice(0, 21)) {
      await add(
        {
          title: detail.title,
          message: detail.message,
          status: status >= 400 ? "failed" : "success",
        },
        { required: false },
      );
    }
  } catch (err) {
    logger.error("[Activity] History unavailable", err);
  }
}

module.exports = { snapshot, add, complete, clear, recordRequest };
