// CPU / memory / network of a running container, shown on its card.

import { sourceOf } from '../state.js';
import { h } from '../dom.js';
import { fmtBytes } from '../utils.js';

const item = (label, value) => h('span', { class: 'usage-item' }, h('span', { class: 'usage-label' }, label), h('span', { class: 'usage-value' }, value));

/** null when the container isn't running or there are no numbers yet. server: where it runs (default: here). */
export function usageNode(container, server) {
  const src = sourceOf(server);
  const u = container?.state === 'running' ? src.usage.stats[container.name] : null;
  if (!u) return null;
  // Without a memory limit Docker reports the host's total memory as the limit.
  const hostMem = src.stats?.mem.total;
  const limited = u.memLimit > 0 && hostMem && u.memLimit < hostMem;
  return h(
    'div',
    { class: 'usage' },
    item('CPU', `${u.cpu}%`),
    item('RAM', limited ? `${fmtBytes(u.mem)} / ${fmtBytes(u.memLimit)}` : fmtBytes(u.mem)),
    item('NET', `↓ ${fmtBytes(u.rx)}  ↑ ${fmtBytes(u.tx)}`)
  );
}

/** Combined CPU / RAM of the running containers behind a group's services; null if none. */
export function groupUsageNode(containers, server) {
  const { usage } = sourceOf(server);
  const names = new Set(containers.filter((c) => c?.state === 'running').map((c) => c.name));
  const stats = [...names].map((name) => usage.stats[name]).filter(Boolean);
  if (!stats.length) return null;
  const cpu = Math.round(stats.reduce((sum, u) => sum + u.cpu, 0) * 10) / 10;
  const mem = stats.reduce((sum, u) => sum + u.mem, 0);
  return h(
    'span',
    { class: 'group-usage', title: `Combined usage of ${stats.length} running container${stats.length === 1 ? '' : 's'}` },
    h('span', { class: 'usage-label' }, 'CPU'),
    h('span', { class: 'usage-value' }, `${cpu}%`),
    h('span', { class: 'usage-label' }, 'RAM'),
    h('span', { class: 'usage-value' }, fmtBytes(mem))
  );
}
