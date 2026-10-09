"use strict";

const fs = require("fs");
const path = require("path");
const { inspect } = require("util");
const { LOG_DIR, LOG_FILE, LOG_MAX_BYTES, LOG_LEVEL } = require("./env");
const levels = { DEBUG: 10, INFO: 20, WARN: 30, ERROR: 40 };
const enabled = (level) => levels[level] >= levels[LOG_LEVEL];

// A single writer owns file changes. No long-lived handles survive rotation/clear.
const filename = path.join(LOG_DIR, LOG_FILE === "." || LOG_FILE === ".." ? "backend.log" : LOG_FILE);
const backup = `${filename}.1`;
let queue = Promise.resolve();
let pendingBytes = 0;
let closed = false;
let lastFailure = 0;
let retryAfter = 0;

function line(level, message, context) {
  const details = context === undefined ? "" : ` ${inspect(context, { depth: 5, breakLength: Infinity, maxArrayLength: 30, maxStringLength: 16384 })}`;
  return `${new Date().toISOString()} ${level} ${message}${details}\n`;
}

function output(level, text) {
  (level === "ERROR" ? process.stderr : process.stdout).write(text);
}

function failure(err) {
  retryAfter = Date.now() + 5000;
  if (Date.now() - lastFailure < 5000) return;
  lastFailure = Date.now();
  output("ERROR", line("ERROR", "[Logging] File logging failed; console logging continues", err));
}

function serialize(work) {
  const job = queue.then(work);
  queue = job.catch(() => {});
  return job;
}

async function ensureFile() {
  await fs.promises.mkdir(LOG_DIR, { recursive: true, mode: 0o700 });
  await fs.promises.appendFile(filename, "", { mode: 0o600 });
}

function log(level, message, context) {
  if (!enabled(level)) return;
  const text = line(level, message, context);
  output(level, text);
  if (closed || Date.now() < retryAfter) return;
  const bytes = Buffer.byteLength(text);
  if (pendingBytes + bytes > 1024 * 1024) {
    failure(new Error("File logging queue full; entries dropped from disk only"));
    return;
  }
  pendingBytes += bytes;
  serialize(async () => {
    await ensureFile();
    const stat = await fs.promises.stat(filename);
    if (stat.size && stat.size + bytes > LOG_MAX_BYTES) {
      await fs.promises.rm(backup, { force: true });
      await fs.promises.rename(filename, backup);
      if (enabled("INFO")) {
        const rotated = line("INFO", "[Logging] Rotated active log");
        output("INFO", rotated);
        await fs.promises.appendFile(filename, rotated, { mode: 0o600 });
      }
    }
    await fs.promises.appendFile(filename, text, { mode: 0o600 });
  }).catch(failure).finally(() => { pendingBytes -= bytes; });
}

async function clear() {
  await serialize(async () => {
    await ensureFile();
    await fs.promises.rm(backup, { force: true });
    await fs.promises.unlink(filename);
    const text = enabled("INFO") ? line("INFO", "[Logging] Logs cleared") : "";
    await fs.promises.appendFile(filename, text, { mode: 0o600 });
    if (text) output("INFO", text);
    retryAfter = 0;
  });
}

// Open both files and capture sizes while the writer is paused. Downloads use
// their own descriptors, so later rotation cannot replace the selected files.
async function snapshot() {
  return serialize(async () => {
    await ensureFile();
    const files = [];
    try {
      for (const name of [backup, filename]) {
        let handle;
        try { handle = await fs.promises.open(name, "r"); }
        catch (err) { if (err.code === "ENOENT") continue; throw err; }
        const file = { handle, size: 0 };
        files.push(file);
        file.size = (await handle.stat()).size;
      }
      return files;
    } catch (err) {
      await Promise.all(files.map(({ handle }) => handle.close()));
      throw err;
    }
  });
}

async function close() {
  closed = true;
  await queue;
}

module.exports = {
  info: (message, context) => log("INFO", message, context),
  warn: (message, context) => log("WARN", message, context),
  error: (message, context) => log("ERROR", message, context),
  debug: (message, context) => log("DEBUG", message, context),
  clear, snapshot, close, filename,
};
