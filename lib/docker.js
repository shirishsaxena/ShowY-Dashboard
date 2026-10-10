"use strict";
const logger = require("./logger");
let dockerState = "";

function logDockerState(state, error) {
  if (dockerState === state) return;
  dockerState = state;
  if (state === "unavailable") logger.warn("[Docker] Integration unavailable", error);
  else logger.info("[Docker] Integration available", { source: state });
}
// Docker containers via the Engine API (unix socket), falling back to the docker CLI.
// Also per-container usage (CPU, memory, network) from the stats endpoint, cached.

const http = require("http");
const { setTimeout, clearTimeout } = require("timers");
const { execFile } = require("child_process");
const { DOCKER_SOCKET, CONTAINER_STATS_INTERVAL } = require("./env");
const { get } = require("./tunables");

const uniqueSorted = (ports) =>
  [...new Set(ports.filter(Boolean))].sort((a, b) => a - b);

/** GET a Docker Engine API path and parse the JSON reply. */
function dockerGet(apiPath, timeout = 5000) {
  let deadline;
  return new Promise((resolve, reject) => {
    const req = http.request(
      { socketPath: DOCKER_SOCKET, path: apiPath, method: "GET", timeout },
      (res) => {
        let data = "";
        res.on("error", reject);
        res.on("aborted", () => reject(new Error("Docker API response aborted")));
        res.setEncoding("utf8");
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          if (res.statusCode >= 400)
            return reject(new Error(`Docker API returned ${res.statusCode}`));
          try {
            resolve(JSON.parse(data));
          } catch (err) {
            reject(err);
          }
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("Docker API timeout")));
    req.on("error", reject);
    // Socket timeouts only measure inactivity. Bound DNS/connect/body time too,
    // so a trickling Engine response cannot hold a pool worker indefinitely.
    deadline = setTimeout(() => req.destroy(new Error("Docker API timeout")), timeout);
    deadline.unref?.();
    req.end();
  }).finally(() => clearTimeout(deadline));
}

async function viaSocket() {
  const list = await dockerGet("/containers/json?all=1");
  return list.map((c) => ({
    name: (c.Names?.[0] || c.Id.slice(0, 12)).replace(/^\//, ""),
    image: c.Image,
    state: c.State,
    status: c.Status,
    ports: uniqueSorted((c.Ports || []).map((p) => p.PublicPort)),
  }));
}

function viaCli() {
  return new Promise((resolve, reject) => {
    execFile(
      "docker",
      ["ps", "-a", "--no-trunc", "--format", "{{json .}}"],
      { timeout: 8000 },
      (err, stdout) => {
        if (err) return reject(err);
        try {
          const lines = stdout.split("\n").filter((l) => l.trim());
          resolve(
            lines.map((line) => {
              const c = JSON.parse(line);
              return {
                name: c.Names,
                image: c.Image,
                state:
                  c.State || (/^Up/i.test(c.Status) ? "running" : "exited"),
                status: c.Status,
                ports: uniqueSorted(
                  [...String(c.Ports || "").matchAll(/:(\d+)->/g)].map((m) =>
                    Number(m[1]),
                  ),
                ),
              };
            }),
          );
        } catch (e) {
          reject(e);
        }
      },
    );
  });
}

async function collectContainers() {
  try {
    const containers = await viaSocket();
    logDockerState("socket");
    return { available: true, source: "socket", containers };
  } catch (socketErr) {
    try {
      const containers = await viaCli();
      logDockerState("cli");
      return { available: true, source: "cli", containers };
    } catch (cliErr) {
      logDockerState("unavailable", { socket: socketErr, cli: cliErr });
      return {
        available: false,
        error: `Docker not reachable (${socketErr.message})`,
        containers: [],
      };
    }
  }
}

let containersPending = null;

function getContainers() {
  containersPending ||= collectContainers().finally(
    () => (containersPending = null),
  );
  return containersPending;
}

// ---------- Container usage ----------

/** Engine version and counts for the Server info panel (nothing about paths, labels or the environment). */
async function getDockerInfo() {
  try {
    const [v, i] = await Promise.all([
      dockerGet("/version"),
      dockerGet("/info"),
    ]);
    return {
      available: true,
      version: String(v.Version || ""),
      apiVersion: String(v.ApiVersion || ""),
      running: i.ContainersRunning ?? null,
      stopped: i.ContainersStopped ?? null,
      total: i.Containers ?? null,
      images: i.Images ?? null,
      storageDriver: String(i.Driver || ""),
    };
  } catch {
    return { available: false, error: "Docker not reachable" };
  }
}

/** CPU = share of the whole host (like the host CPU tile), memory excludes page cache (like `docker stats`). */
function parseStats(s) {
  const cpu = s.cpu_stats || {};
  const pre = s.precpu_stats || {};
  const cpuDelta =
    (cpu.cpu_usage?.total_usage || 0) - (pre.cpu_usage?.total_usage || 0);
  const sysDelta = (cpu.system_cpu_usage || 0) - (pre.system_cpu_usage || 0);
  const mem = s.memory_stats || {};
  const cache = mem.stats?.inactive_file ?? mem.stats?.total_inactive_file ?? 0;
  let rx = 0;
  let tx = 0;
  for (const n of Object.values(s.networks || {})) {
    rx += n.rx_bytes || 0;
    tx += n.tx_bytes || 0;
  }
  return {
    cpu:
      sysDelta > 0 && cpuDelta > 0
        ? Math.round((cpuDelta / sysDelta) * 1000) / 10
        : 0,
    mem: Math.max(0, (mem.usage || 0) - cache),
    memLimit: mem.limit || 0,
    rx,
    tx,
  };
}

async function collectStats() {
  const list = await dockerGet("/containers/json"); // running only
  const names = list.map((c) =>
    (c.Names?.[0] || c.Id.slice(0, 12)).replace(/^\//, ""),
  );
  const stats = {};
  let failed = 0;
  let next = 0;
  const worker = async () => {
    while (next < names.length) {
      const name = names[next++];
      try {
        // stream=false waits ~1 s so the reply includes the previous CPU sample.
        stats[name] = parseStats(
          await dockerGet(
            `/containers/${encodeURIComponent(name)}/stats?stream=false`,
            8000,
          ),
        );
      } catch (err) {
        // A removed container needs no sample. Other failures must not be
        // disguised as successfully collected empty/partial usage.
        if (!/Docker API returned 404\b/.test(err.message)) failed++;
      }
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(get("dockerParallel"), names.length) },
      worker,
    ),
  );
  if (failed) throw new Error(`Could not collect usage for ${failed} container(s)`);
  return stats;
}

let usage = { collectedAt: 0, stats: {} };
let usageCheckedAt = 0;
let usageError = "";
let pending = null;

/**
 * Cached usage of running containers, refreshed at most every CONTAINER_STATS_INTERVAL seconds
 * (fresh = refresh button: accept data only a few seconds old).
 */
async function getContainerStats({ fresh = false } = {}) {
  const interval = CONTAINER_STATS_INTERVAL;
  if (!interval) return { interval, stats: {} };
  const maxAge = fresh ? get("refreshGap") * 1000 : interval * 1000 - 1000;
  if (Date.now() - usageCheckedAt >= maxAge) {
    pending ??= collectStats()
      .then((stats) => {
        usage = { collectedAt: Date.now(), stats };
        usageError = "";
      })
      .catch((err) => {
        // Preserve the last successful sample; an attempted collection is not an update.
        usageError = err.message || "Container usage unavailable";
      })
      .finally(() => {
        usageCheckedAt = Date.now();
        pending = null;
      });
    await pending;
  }
  return { interval, ...usage, ok: !usageError, error: usageError };
}

module.exports = { getContainers, getContainerStats, getDockerInfo };
