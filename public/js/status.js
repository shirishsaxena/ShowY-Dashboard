// Service status: Docker container state (local servers) combined with HTTP up/down checks.

import { sourceOf } from "./state.js";
import { h } from "./dom.js";
import { norm, portOf, monitoringUrl } from "./utils.js";

// API loads replace container arrays. Cache indexes for each snapshot, including remotes,
// and let old snapshots be collected. Preserve the first match in Docker's list order.
const containerIndexes = new WeakMap();

function indexContainers(list) {
  let index = containerIndexes.get(list);
  if (index) return index;
  index = { names: new Map(), ports: new Map(), normalized: new Map() };
  for (const container of list) {
    const name = container.name.toLowerCase();
    const normalized = norm(container.name);
    if (!index.names.has(name)) index.names.set(name, container);
    if (!index.normalized.has(normalized))
      index.normalized.set(normalized, container);
    for (const port of container.ports) {
      if (!index.ports.has(port)) index.ports.set(port, container);
    }
  }
  containerIndexes.set(list, index);
  return index;
}

/** undefined = not applicable, null = no matching container, object = the container. */
export function containerFor(svc, server) {
  if (Object.hasOwn(svc, "type") && svc.type !== "docker") return undefined;
  const { docker } = sourceOf(server);
  if (!server.local || !docker.available) return undefined;
  const index = indexContainers(docker.containers);
  if (svc.container)
    return index.names.get(svc.container.toLowerCase()) || null;
  if (svc.type === "docker") return null;
  const port = portOf(monitoringUrl(svc));
  const byPort = port && index.ports.get(port);
  if (byPort) return byPort;
  return index.normalized.get(norm(svc.name)) || null;
}

const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/** Status of a bare container (used for the "not on dashboard" list). */
export function containerStatus(c) {
  const title = `${c.name} · ${c.status}`;
  if (c.state === "running") return { level: "up", label: "Running", title };
  if (c.state === "restarting" || c.state === "paused")
    return { level: "warn", label: capitalize(c.state), title };
  return { level: "down", label: "Stopped", title };
}

function describeCheck(check) {
  if (!check) return "";
  return check.state === "down"
    ? `Unreachable (${check.error || "no response"})`
    : `HTTP ${check.code} · ${check.ms} ms`;
}

/**
 * { level: 'up' | 'warn' | 'down' | 'unknown' | 'neutral', label, title } or null.
 * Typed Docker requires container evidence; legacy entries retain HTTP fallback.
 */
export function serviceStatus(svc, server) {
  if (svc.type === "bookmark")
    return { level: "neutral", label: "Bookmark", title: "Saved link · not monitored" };
  if (Object.hasOwn(svc, "type") && !["docker", "web"].includes(svc.type))
    return { level: "unknown", label: "Unknown type", title: "Unsupported service type" };
  const container = containerFor(svc, server);
  const check = (!Object.hasOwn(svc, "type") && !Object.hasOwn(svc, "urls")) || monitoringUrl(svc)
    ? sourceOf(server).health[svc.id] : null;
  const http = describeCheck(check);

  if (container) {
    const st = containerStatus(container);
    st.title = [`Container ${st.title}`, http].filter(Boolean).join("\n");
    if (st.level === "up" && check?.state === "down")
      return { ...st, level: "warn", label: "No response" };
    return st;
  }
  if (svc.type === "docker")
    return {
      level: "unknown",
      label: container === null ? "Not in Docker" : "Docker unavailable",
      title: [container === null ? "No matching container" : "Docker state unavailable on this server", http]
        .filter(Boolean).join("\n"),
    };
  if (check) {
    const note = container === null ? "\nNo matching Docker container" : "";
    if (check.state === "up")
      return { level: "up", label: "Online", title: http + note };
    if (check.state === "error") {
      const label = check.code === 404 ? "Not found" : `HTTP ${check.code}`;
      return { level: "warn", label, title: http + note };
    }
    return { level: "down", label: "Offline", title: http + note };
  }
  if (container === null)
    return {
      level: "unknown",
      label: "Not in Docker",
      title: "No matching container",
    };
  return null;
}

export function serverCounts(server) {
  const counts = { up: 0, warn: 0, down: 0 };
  for (const svc of server.services) {
    const level = serviceStatus(svc, server)?.level;
    if (level in counts) counts[level]++;
  }
  return counts;
}

export function statusNode(st) {
  return h(
    "span",
    { class: `status ${st.level}`, title: st.title, "aria-label": st.label },
    h("span", { class: "dot" }),
    h("span", { class: "status-label" }, st.label),
  );
}

/** host:port pairs used by more than one service of a server (usually a copy-paste mistake). */
export function duplicateHosts(server) {
  const seen = new Map();
  for (const svc of server.services) {
    const key = hostPort(monitoringUrl(svc));
    if (key) seen.set(key, (seen.get(key) || 0) + 1);
  }
  return new Set([...seen].filter(([, n]) => n > 1).map(([k]) => k));
}

export function hostPort(u) {
  try {
    const url = new URL(u);
    return url.port ? url.host : null;
  } catch {
    return null;
  }
}
