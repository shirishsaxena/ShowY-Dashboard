"use strict";

// On-demand snapshots only. No CLI fallback, following, or Docker mutations.
const http = require("http");
const { stripVTControlCharacters } = require("util");
const { DOCKER_SOCKET } = require("./env");
const { HttpError } = require("./http");

const MAX_BYTES = 1024 * 1024;
const TIMEOUT = 8000;
let active = 0;

/** Bound both memory and total request time, including slowly trickling bodies. */
function readSocket(path, { signal, truncate = false } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let deadline;
    let req;
    const finish = (err, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      signal?.removeEventListener("abort", abort);
      if (err) reject(err);
      else resolve(result);
      req?.destroy();
    };
    const abort = () => finish(new HttpError(499, "Log request cancelled"));
    if (signal?.aborted) return abort();
    signal?.addEventListener("abort", abort, { once: true });
    try {
      req = http.request(
        { socketPath: DOCKER_SOCKET, path, method: "GET" },
        (res) => {
          res.on("error", () =>
            finish(new HttpError(503, "Docker log response interrupted")),
          );
          res.on("aborted", () =>
            finish(new HttpError(503, "Docker log response interrupted")),
          );
          if (res.statusCode !== 200) {
            const status = res.statusCode;
            return finish(
              new HttpError(
                status === 404 ? 404 : status === 403 ? 403 : 502,
                status === 404
                  ? "Container no longer exists. Refresh the dashboard."
                  : status === 403
                    ? "Docker denied access to container logs"
                    : "Docker could not read logs. Check the container's logging driver and Docker permissions.",
              ),
            );
          }
          let size = 0;
          const chunks = [];
          res.on("data", (chunk) => {
            if (settled) return;
            const remaining = MAX_BYTES - size;
            chunks.push(chunk.subarray(0, remaining));
            size += Math.min(chunk.length, remaining);
            if (chunk.length > remaining) {
              finish(
                truncate
                  ? null
                  : new HttpError(502, "Docker metadata response too large"),
                { body: Buffer.concat(chunks, size), truncated: true },
              );
            }
          });
          res.on("end", () =>
            finish(null, {
              body: Buffer.concat(chunks, size),
              truncated: false,
            }),
          );
        },
      );
      req.on("error", () =>
        finish(
          new HttpError(
            503,
            "Docker socket unavailable. Container logs require Engine socket access.",
          ),
        ),
      );
      deadline = setTimeout(
        () =>
          finish(
            new HttpError(504, "Docker log request timed out. Try again."),
          ),
        TIMEOUT,
      );
      deadline.unref?.();
      req.end();
    } catch {
      finish(new HttpError(503, "Docker socket unavailable"));
    }
  });
}

/** Docker non-TTY logs use 8-byte stdout/stderr frame headers; TTY logs are raw. */
function decodeLogs(body, tty, truncated) {
  if (tty) return body.toString("utf8");
  const chunks = [];
  let offset = 0;
  while (offset < body.length) {
    if (body.length - offset < 8) {
      if (truncated) break;
      throw new HttpError(502, "Incomplete Docker log frame");
    }
    if (![1, 2].includes(body[offset]) || body.readUIntBE(offset + 1, 3) !== 0)
      throw new HttpError(502, "Invalid Docker log format");
    const length = body.readUInt32BE(offset + 4);
    offset += 8;
    const end = offset + length;
    if (end > body.length && !truncated)
      throw new HttpError(502, "Incomplete Docker log frame");
    chunks.push(body.subarray(offset, Math.min(end, body.length)));
    offset = end;
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function getContainerLogs(id, { tail = 250, signal } = {}) {
  // Full immutable IDs avoid name reuse and cannot inject API paths or CLI flags.
  if (typeof id !== "string" || !/^[a-f0-9]{64}$/.test(id))
    throw new HttpError(400, "A full container ID is required");
  if (![100, 250, 500].includes(tail))
    throw new HttpError(400, "Choose 100, 250, or 500 log lines");
  if (active >= 4)
    throw new HttpError(429, "Too many log requests. Try again shortly.");
  active++;
  try {
    const metadata = await readSocket(`/containers/${id}/json`, { signal });
    let info;
    try {
      info = JSON.parse(metadata.body.toString("utf8"));
    } catch {
      throw new HttpError(502, "Invalid Docker container metadata");
    }
    if (typeof info?.Config?.Tty !== "boolean")
      throw new HttpError(502, "Invalid Docker container metadata");
    const { body, truncated } = await readSocket(
      `/containers/${id}/logs?stdout=1&stderr=1&timestamps=1&follow=0&tail=${tail}`,
      { signal, truncate: true },
    );
    // Renderable text only; no terminal escape sequences or active HTML.
    const text = stripVTControlCharacters(
      decodeLogs(body, info.Config.Tty, truncated),
    ).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
    // stdout/stderr may each contribute up to tail lines. Bound the combined view.
    const lines = text.split("\n");
    if (lines.at(-1) === "") lines.pop();
    return {
      id,
      tail,
      text: lines.slice(-tail).join("\n"),
      truncated,
      fetchedAt: Date.now(),
    };
  } finally {
    active--;
  }
}

module.exports = { getContainerLogs };
