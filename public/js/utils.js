// Small helpers: ids, text, URLs and number formatting.

export const clone = (o) => structuredClone(o);
export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
export const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
export const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

export function debounce(fn, ms) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

// ---------- URLs ----------

const isLan = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[::1\]|.*\.(local|lan|home|internal)$)/i.test(
  location.hostname
);

function parseUrl(u) {
  try {
    return new URL(u);
  } catch {
    return null;
  }
}

/** Only http(s) links; "localhost" points at whatever host the dashboard was opened from. */
export function safeUrl(u) {
  const url = u ? parseUrl(u) : null;
  if (!url || (url.protocol !== 'http:' && url.protocol !== 'https:')) return '';
  if (url.hostname === 'localhost') url.hostname = location.hostname;
  return url.href;
}

export const portOf = (u) => Number(parseUrl(u)?.port) || null;
export const hostOf = (u) => parseUrl(u)?.hostname || '';

/** Short label for a link chip: ":8096" for URLs with a port, otherwise the host name. */
export function hostLabel(u) {
  const url = parseUrl(u);
  if (!url) return u;
  return url.port ? `:${url.port}` : url.hostname;
}

/** On remote access (e.g. phone on mobile data) prefer the public URL when available. */
export const primaryUrl = (svc) => safeUrl(!isLan && svc.altUrl ? svc.altUrl : svc.url || svc.altUrl);

// ---------- Formatting ----------

/** 512 B, 182 MB, 8.2 GB, 1.4 TB */
export function fmtBytes(bytes) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i === 0 || n >= 100 ? 0 : 1)} ${units[i]}`;
}

export function fmtUptime(sec) {
  const d = Math.floor(sec / 86400);
  const hrs = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return d ? `${d}d ${hrs}h` : hrs ? `${hrs}h ${m}m` : `${m}m`;
}

/** "25 min", "1 h 5 min", "2 d 3 h" - for outage lengths. */
export function fmtDuration(ms) {
  const mins = Math.max(1, Math.round(ms / 60_000));
  if (mins < 60) return `${mins} min`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return mins % 60 ? `${hrs} h ${mins % 60} min` : `${hrs} h`;
  return hrs % 24 ? `${Math.floor(hrs / 24)} d ${hrs % 24} h` : `${Math.floor(hrs / 24)} d`;
}

/** "Oct 5, 08:10" (with the year when it isn't this year). */
export function fmtDateTime(ms) {
  const d = new Date(ms);
  const opts = { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' };
  if (d.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
  return d.toLocaleString(undefined, opts);
}

/** 99.95 -> "99.95%", 100 -> "100%", unknown -> "—" */
export const fmtPercent = (pct) => (pct == null ? '—' : `${Number(Number(pct).toFixed(2))}%`);

/** "12 sec ago", "3 min ago", "1.5 hours ago" */
export function fmtAgo(ms) {
  const sec = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (sec < 60) return `${sec} sec ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)} min ago`;
  return `${(sec / 3600).toFixed(1)} hours ago`;
}
