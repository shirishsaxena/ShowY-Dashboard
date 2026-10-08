// Service status: Docker container state (local servers) combined with HTTP up/down checks.

import { sourceOf } from './state.js';
import { h } from './dom.js';
import { norm, portOf } from './utils.js';

/** undefined = not applicable, null = no matching container, object = the container. */
export function containerFor(svc, server) {
  const { docker } = sourceOf(server);
  if (!server.local || !docker.available) return undefined;
  const list = docker.containers;
  if (svc.container) return list.find((c) => c.name.toLowerCase() === svc.container.toLowerCase()) || null;
  const port = portOf(svc.url);
  const byPort = port && list.find((c) => c.ports.includes(port));
  if (byPort) return byPort;
  const name = norm(svc.name);
  return list.find((c) => norm(c.name) === name) || null;
}

const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/** Status of a bare container (used for the "not on dashboard" list). */
export function containerStatus(c) {
  const title = `${c.name} · ${c.status}`;
  if (c.state === 'running') return { level: 'up', label: 'Running', title };
  if (c.state === 'restarting' || c.state === 'paused') return { level: 'warn', label: capitalize(c.state), title };
  return { level: 'down', label: 'Stopped', title };
}

function describeCheck(check) {
  if (!check) return '';
  return check.state === 'down' ? `Unreachable (${check.error || 'no response'})` : `HTTP ${check.code} · ${check.ms} ms`;
}

/**
 * { level: 'up' | 'warn' | 'down' | 'unknown', label, title } or null when nothing is known yet.
 * Docker state wins for matched containers; the HTTP check covers everything else.
 */
export function serviceStatus(svc, server) {
  const container = containerFor(svc, server);
  const check = sourceOf(server).health[svc.id];
  const http = describeCheck(check);

  if (container) {
    const st = containerStatus(container);
    st.title = [`Container ${st.title}`, http].filter(Boolean).join('\n');
    if (st.level === 'up' && check?.state === 'down') return { ...st, level: 'warn', label: 'No response' };
    return st;
  }
  if (check) {
    const note = container === null ? '\nNo matching Docker container' : '';
    if (check.state === 'up') return { level: 'up', label: 'Online', title: http + note };
    if (check.state === 'error') {
      const label = check.code === 404 ? 'Not found' : `HTTP ${check.code}`;
      return { level: 'warn', label, title: http + note };
    }
    return { level: 'down', label: 'Offline', title: http + note };
  }
  if (container === null) return { level: 'unknown', label: 'Not in Docker', title: 'No matching container' };
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
    'span',
    { class: `status ${st.level}`, title: st.title, 'aria-label': st.label },
    h('span', { class: 'dot' }),
    h('span', { class: 'status-label' }, st.label)
  );
}

/** host:port pairs used by more than one service of a server (usually a copy-paste mistake). */
export function duplicateHosts(server) {
  const seen = new Map();
  for (const svc of server.services) {
    const key = hostPort(svc.url);
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
