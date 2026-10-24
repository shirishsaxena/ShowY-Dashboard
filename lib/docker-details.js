"use strict";

// Fresh, one-container-only inspection and usage. Never expose a raw inspect response.
const { dockerGet, parseStats } = require("./docker");
const { HttpError } = require("./http");
const MAX_BYTES = 1024 * 1024;
let active = 0;
const text = (value, max = 256) => typeof value === "string" ? value.slice(0, max) : "";
const number = (value) => Number.isFinite(value) && value >= 0 ? value : 0;

function safeError(err) {
  if (err.name === "AbortError" || err.code === "ABORT_ERR") return new HttpError(499, "Container preview request cancelled");
  if (err.statusCode === 404) return new HttpError(404, "Container no longer exists. Refresh the dashboard and reopen its preview.");
  if (err.statusCode === 403) return new HttpError(403, "Docker denied access to container details");
  if (err.code === "DOCKER_RESPONSE_TOO_LARGE") return new HttpError(502, "Container details exceed the response size limit");
  if (/timeout/i.test(err.message)) return new HttpError(504, "Container details request timed out. Try refreshing again.");
  return new HttpError(503, "Container details unavailable. Check Docker Engine socket access.");
}

function details(info) {
  const host = info.HostConfig || {};
  const config = info.Config;
  const state = info.State;
  const network = info.NetworkSettings || {};
  const ports = [];
  for (const [container, bindings] of Object.entries(network.Ports || {}).slice(0, 100)) {
    const published = Array.isArray(bindings) ? bindings.slice(0, 100) : [];
    if (!published.length) ports.push({ container: text(container), address: "", host: "" });
    else for (const binding of published) ports.push({
      container: text(container), address: text(binding.HostIp), host: text(binding.HostPort),
    });
  }
  return {
    id: info.Id, name: text(info.Name).replace(/^\//, ""), image: text(config.Image), imageId: text(info.Image),
    createdAt: text(info.Created), state: text(state.Status),
    startedAt: text(state.StartedAt), finishedAt: text(state.FinishedAt),
    exitCode: Number.isInteger(state.ExitCode) ? state.ExitCode : null,
    oomKilled: Boolean(state.OOMKilled), restartCount: number(info.RestartCount),
    health: text(state.Health?.Status) || "Not configured",
    failingStreak: number(state.Health?.FailingStreak),
    hostname: text(config.Hostname), user: text(config.User) || "Default (root)",
    restartPolicy: text(host.RestartPolicy?.Name) || "no",
    maximumRetryCount: number(host.RestartPolicy?.MaximumRetryCount),
    memoryLimit: number(host.Memory),
    cpuLimit: number(host.NanoCpus) / 1e9 || (number(host.CpuQuota) > 0 && number(host.CpuPeriod) > 0 ? host.CpuQuota / host.CpuPeriod : 0),
    cpuShares: number(host.CpuShares), cpuSet: text(host.CpusetCpus),
    privileged: Boolean(host.Privileged), readOnlyRootfs: Boolean(host.ReadonlyRootfs),
    runtime: text(host.Runtime), networkMode: text(host.NetworkMode), logDriver: text(host.LogConfig?.Type),
    composeProject: text(config.Labels?.["com.docker.compose.project"]),
    composeService: text(config.Labels?.["com.docker.compose.service"]),
    ports: ports.slice(0, 100),
    networks: Object.entries(network.Networks || {}).slice(0, 100).map(([name, item]) => ({
      name: text(name), address: text(item.IPAddress), gateway: text(item.Gateway),
      ipv6: text(item.GlobalIPv6Address), mac: text(item.MacAddress),
    })),
    mounts: (Array.isArray(info.Mounts) ? info.Mounts : []).slice(0, 100).map((mount) => ({
      type: text(mount.Type), destination: text(mount.Destination), writable: Boolean(mount.RW),
    })),
  };
}

function usage(stats) {
  if (!stats || !stats.cpu_stats || !stats.memory_stats) throw new Error("Invalid Docker usage response");
  const base = parseStats(stats);
  const io = stats.blkio_stats?.io_service_bytes_recursive;
  const ioBytes = (op) => Array.isArray(io) && io.length
    ? io.filter((item) => String(item.op).toLowerCase() === op).reduce((sum, item) => sum + number(item.value), 0) : null;
  return {
    ...base, rx: stats.networks ? base.rx : null, tx: stats.networks ? base.tx : null,
    memoryPercent: base.memLimit > 0 ? Math.round(base.mem / base.memLimit * 1000) / 10 : null,
    blockRead: ioBytes("read"), blockWrite: ioBytes("write"),
    pids: Number.isFinite(stats.pids_stats?.current) ? number(stats.pids_stats.current) : null,
  };
}

async function getContainerDetails(id, { signal } = {}) {
  if (typeof id !== "string" || !/^[a-f0-9]{64}$/.test(id))
    throw new HttpError(400, "A full container ID is required");
  if (active >= 4) throw new HttpError(429, "Too many container preview requests. Try again shortly.");
  active++;
  try {
    const options = { signal, maxBytes: MAX_BYTES };
    let info;
    try { info = await dockerGet(`/containers/${id}/json`, 5000, options); }
    catch (err) { throw safeError(err); }
    if (info?.Id !== id || !info.Config || typeof info.State?.Status !== "string")
      throw new HttpError(502, "Invalid Docker container metadata");
    const container = details(info);
    let stats = null;
    let usageError = "Usage is available for running containers only.";
    if (info.State.Status === "running" && !info.State.Paused) {
      try {
        stats = usage(await dockerGet(`/containers/${id}/stats?stream=false`, 8000, options));
        usageError = "";
      } catch (err) {
        if (signal?.aborted) throw safeError(err);
        usageError = safeError(err).message;
      }
    }
    return { container, usage: stats, usageError, fetchedAt: Date.now() };
  } finally {
    active--;
  }
}

module.exports = { getContainerDetails };
