"use strict";

const http = require("http");
const os = require("os");
const { setTimeout: delay } = require("timers/promises");
const {
  DOCKER_SOCKET,
  DOCKER_CONTROL,
  DOCKER_PROTECTED_CONTAINERS,
  PASSWORD,
} = require("./env");
const { HttpError } = require("./http");
const activity = require("./activity");
const logger = require("./logger");
const active = new Map();
const jobs = new Set();
const ID = /^[a-f0-9]{64}$/;

function controlState() {
  return {
    enabled: Boolean(DOCKER_CONTROL && PASSWORD),
    reason: !DOCKER_CONTROL
      ? "Container control is disabled. Enable DOCKER_CONTROL in deployment settings."
      : !PASSWORD
        ? "Set a dashboard password before enabling container control."
        : "",
    busy: [...active.values()].map(({ id, action, requestId }) => ({
      id,
      action,
      requestId,
    })),
  };
}

function protectedTarget(id, name, config = {}) {
  const host = os.hostname();
  const protectedNames = [
    "showy-dashboard",
    "showy-dashy",
    ...(DOCKER_PROTECTED_CONTAINERS || []),
  ];
  return (
    protectedNames.includes(name) ||
    protectedNames.includes(id) ||
    config.Labels?.["showy.protected"] === "true" ||
    config.Hostname === host ||
    (host.length >= 12 && id.startsWith(host))
  );
}

function engine(method, path, timeout = 5000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer;
    let req;
    const fail = (status, message, uncertain = method === "POST") => {
      const err = new HttpError(status, message);
      err.uncertain = uncertain;
      finish(err);
    };
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      error ? reject(error) : resolve(result);
      req?.destroy();
    };
    req = http.request({ socketPath: DOCKER_SOCKET, path, method }, (res) => {
      res.on("error", () => fail(503, "Docker response interrupted"));
      res.on("aborted", () => fail(503, "Docker response interrupted"));
      if (![200, 204, 304].includes(res.statusCode))
        return fail(
          res.statusCode === 404 ? 404 : res.statusCode === 409 ? 409 : 502,
          res.statusCode === 404
            ? "Container no longer exists"
            : res.statusCode === 409
              ? "Container state changed. Refresh before trying again."
              : "Docker rejected the request. Check Docker permissions and backend logs.",
          false,
        );
      let size = 0;
      const chunks = [];
      res.on("data", (chunk) => {
        if (settled) return;
        size += chunk.length;
        if (size > 1024 * 1024) return fail(502, "Docker response too large");
        chunks.push(chunk);
      });
      res.on("end", () => {
        if (method === "POST") return finish(null, { status: res.statusCode });
        try {
          finish(null, JSON.parse(Buffer.concat(chunks).toString("utf8")));
        } catch {
          fail(502, "Invalid Docker response");
        }
      });
    });
    req.on("error", () => fail(503, "Docker socket unavailable"));
    timer = setTimeout(() => fail(504, "Docker request timed out"), timeout);
    timer.unref?.();
    req.end();
  });
}

function checkTarget(info, id, action) {
  if (info.Id !== id || !info.State || !info.Config)
    throw new HttpError(502, "Invalid Docker container metadata");
  const name = String(info.Name || "").replace(/^\//, "");
  if (protectedTarget(id, name, info.Config))
    throw new HttpError(
      403,
      "This container is protected from dashboard lifecycle actions",
    );
  const status = info.State.Status;
  if (
    info.State.Paused ||
    info.State.Restarting ||
    !(action === "start"
      ? ["created", "exited"].includes(status)
      : status === "running")
  )
    throw new HttpError(
      409,
      "This action is not available in the container's current state. Refresh first.",
    );
  return name || id.slice(0, 12);
}

async function perform(job, before) {
  let status = "failed";
  let message = "Action failed";
  let acknowledged = false;
  try {
    await engine(
      "POST",
      `/containers/${job.id}/${job.action}${job.action === "start" ? "" : "?t=10"}`,
      25000,
    );
    acknowledged = true;
    const until = Date.now() + 15000;
    do {
      const after = await engine("GET", `/containers/${job.id}/json`);
      const stable =
        after.State && !after.State.Paused && !after.State.Restarting;
      const confirmed =
        stable &&
        (job.action === "stop"
          ? ["exited", "created"].includes(after.State.Status)
          : after.State.Status === "running" &&
            (job.action !== "restart" ||
              (after.State.StartedAt &&
                after.State.StartedAt !== before.State.StartedAt)));
      if (confirmed) {
        status = "success";
        message =
          job.action === "stop"
            ? "Container stopped."
            : "Container is running. Application readiness is checked separately.";
        break;
      }
      await delay(500);
    } while (Date.now() < until);
    if (status !== "success") {
      status = "uncertain";
      message =
        "Docker accepted the action, but the expected state was not confirmed. Check the container before retrying.";
    }
  } catch (err) {
    status = err.uncertain || acknowledged ? "uncertain" : "failed";
    message =
      status === "uncertain"
        ? "The action may still complete. Check container state before retrying; it was not automatically retried."
        : err instanceof HttpError
          ? err.message
          : "Container action failed. Check the backend logs.";
    logger.warn("[Docker] Lifecycle request did not complete normally", {
      id: job.id,
      action: job.action,
      status,
    });
  }
  try {
    await activity.complete(job.requestId, status, message);
    logger.info("[Docker] Lifecycle action completed", {
      id: job.id,
      action: job.action,
      status,
    });
  } finally {
    active.delete(job.id);
  }
}

async function submit(body) {
  const capability = controlState();
  if (!capability.enabled) throw new HttpError(403, capability.reason);
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw new HttpError(400, "Invalid container action");
  const { id, action, requestId } = body;
  if (
    typeof id !== "string" ||
    !ID.test(id) ||
    !["start", "stop", "restart"].includes(action) ||
    typeof requestId !== "string" ||
    !/^[a-zA-Z0-9-]{12,64}$/.test(requestId)
  )
    throw new HttpError(400, "Invalid container action or request ID");
  const history = await activity.snapshot();
  const existing = [...history.entries, ...(history.retired || [])].find(
    (entry) => entry.id === requestId,
  );
  if (existing) {
    if (existing.containerId !== id || existing.action !== action)
      throw new HttpError(
        409,
        "Request ID already belongs to a different action",
      );
    return existing; // Safe replay of the same accepted request; never repeat a mutation.
  }
  if (active.has(id))
    throw new HttpError(
      409,
      "An action is already in progress for this container",
    );
  if ([...active.values()].some((job) => job.requestId === requestId))
    throw new HttpError(409, "This request is already being submitted");
  if (active.size >= 4)
    throw new HttpError(429, "Too many container actions in progress");
  const job = { id, action, requestId };
  active.set(id, job);
  try {
    const info = await engine("GET", `/containers/${id}/json`);
    const name = checkTarget(info, id, action);
    // Commit intent before sending any mutation. A storage failure must prevent the action.
    const entry = await activity.add({
      id: requestId,
      containerId: id,
      action,
      title: `${action[0].toUpperCase()}${action.slice(1)} container: ${name}`,
      status: "pending",
      message: "Action in progress",
    });
    const task = perform(job, info)
      .catch((err) =>
        logger.error("[Docker] Could not finalize action history", err),
      )
      .finally(() => jobs.delete(task));
    jobs.add(task);
    return entry;
  } catch (err) {
    active.delete(id);
    throw err;
  }
}

module.exports = { controlState, submit, protectedTarget };
