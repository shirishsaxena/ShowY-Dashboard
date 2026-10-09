// DOM helpers: element builder, SVG icons, service icons and toasts.

const ICON_CDN = "https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/png/";
export const ICON_INDEX_URL =
  "https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/tree.json";

export const $ = (sel, root = document) => root.querySelector(sel);

const isContent = (k) => k != null && k !== false && k !== "";
const handlers = new WeakMap();
const stableRoots = new WeakSet();

/** Opt in display-only sections whose h() handlers do not capture their newly built nodes. */
export function preserveEqualChildren(...roots) {
  for (const root of roots) stableRoots.add(root);
}

/** Create an element: h('a', { class: 'x', href, onclick }, ...children). null/false children are skipped. */
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) {
      const events = handlers.get(el) || new Map();
      events.set(k.slice(2), v);
      handlers.set(el, events);
      el.addEventListener(k.slice(2), v);
    } else el.setAttribute(k, v === true ? "" : v);
  }
  el.append(...children.flat(Infinity).filter(isContent));
  return el;
}

function refreshHandlers(current, next) {
  // Equal markup can still have different closures (e.g. updated notes or copy text).
  for (const [type, handler] of handlers.get(current) || [])
    current.removeEventListener(type, handler);
  const events = handlers.get(next);
  for (const [type, handler] of events || [])
    current.addEventListener(type, handler);
  if (events) handlers.set(current, events);
  else handlers.delete(current);
  for (let i = 0; i < current.childNodes.length; i++)
    refreshHandlers(current.childNodes[i], next.childNodes[i]);
}

/** replaceChildren that skips null/false/empty values; opted-in equal sections keep focus. */
export function fill(el, ...kids) {
  const children = kids.flat(Infinity).filter(isContent);
  if (stableRoots.has(el)) {
    const next = children.map((child) =>
      child instanceof Node ? child : document.createTextNode(String(child)),
    );
    const current = [...el.childNodes];
    if (
      current.length === next.length &&
      current.every((child, i) => child.isEqualNode(next[i]))
    ) {
      current.forEach((child, i) => refreshHandlers(child, next[i]));
      return;
    }
  }
  el.replaceChildren(...children);
}

// ---------- SVG icons ----------

const PATHS = {
  external:
    "M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5",
  globe:
    "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18",
  home: "M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z",
  edit: "M4 20h4L19 9l-4-4L4 16v4zM14 6l4 4",
  trash: "M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3",
  plus: "M12 5v14M5 12h14",
  right: "M9 6l6 6-6 6",
  chevron: "M6 9l6 6 6-6",
  pin: "M12 21s-7-6.2-7-11a7 7 0 0 1 14 0c0 4.8-7 11-7 11zM12 12.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z",
  cpu: "M7 7h10v10H7zM9 3v4M15 3v4M9 17v4M15 17v4M3 9h4M3 15h4M17 9h4M17 15h4",
  box: "M21 8l-9-5-9 5v8l9 5 9-5zM3 8l9 5 9-5M12 13v8",
  hide: "M3 3l18 18M10.6 6.1A10 10 0 0 1 12 6c5 0 9 6 9 6a17 17 0 0 1-3 3.4M6.6 6.6C4.3 8.1 3 12 3 12s4 6 9 6a9 9 0 0 0 4.4-1.2M9.9 9.9a3 3 0 0 0 4.2 4.2",
  eye: "M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
  warn: "M12 9v4M12 17h.01M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z",
  grip: "M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01",
  star: "M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z",
  qr: "M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h2v2h-2zM18 14h2M14 20h2M18 18h2v2h-2",
  disk: "M4 6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2zM8 16h.01M12 16h4",
  chip: "M8 8h8v8H8zM10 3v3M14 3v3M10 18v3M14 18v3M3 10h3M3 14h3M18 10h3M18 14h3",
  fan: "M12 12a2 2 0 1 0 0-.01M12 10c0-4 1-7 4-7 2 0 3 2 2 4l-4 4M14 12c4 0 7 1 7 4 0 2-2 3-4 2l-4-4M12 14c0 4-1 7-4 7-2 0-3-2-2-4l4-4M10 12c-4 0-7-1-7-4 0-2 2-3 4-2l4 4",
  cards: "M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z",
  compact:
    "M4 4h4v4H4zM10 4h4v4h-4zM16 4h4v4h-4zM4 10h4v4H4zM10 10h4v4h-4zM16 10h4v4h-4zM4 16h4v4H4zM10 16h4v4h-4zM16 16h4v4h-4z",
  list: "M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01",
  sun: "M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10zM12 1v2M12 21v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M1 12h2M21 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4",
  moon: "M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z",
  auto: "M3 5h18v12H3zM8 21h8M12 17v4",
  download: "M12 3v12M7 10l5 5 5-5M5 21h14",
  clock: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2",
  note: "M6 3h9l4 4v14H6zM14 3v5h5M9 12h7M9 16h5",
  copy: "M9 9h11v11H9zM5 15V4h11",
  info: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 11v5M12 8h.01",
};

export function svg(name) {
  const NS = "http://www.w3.org/2000/svg";
  const el = document.createElementNS(NS, "svg");
  el.setAttribute("viewBox", "0 0 24 24");
  el.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(NS, "path");
  path.setAttribute("d", PATHS[name]);
  el.append(path);
  return el;
}

export function iconBtn(name, label, onclick, cls = "icon-btn sm") {
  return h(
    "button",
    { type: "button", class: cls, title: label, "aria-label": label, onclick },
    svg(name),
  );
}

/** Attributes for links that open in a new tab. */
export const external = { target: "_blank", rel: "noopener noreferrer" };

export const dragHandle = (cls = "drag-handle") =>
  h(
    "span",
    { class: cls, title: "Drag to reorder", "aria-hidden": "true" },
    svg("grip"),
  );

// ---------- Service / server icons ----------

function colorFor(text) {
  let hash = 0;
  for (const ch of String(text)) hash = (hash * 31 + ch.charCodeAt(0)) | 0;
  return `hsl(${Math.abs(hash) % 360} 55% 45%)`;
}

const isIconSlug = (v) => /^[a-z0-9][a-z0-9-]*$/.test(v);
export const iconSlugUrl = (slug) => `${ICON_CDN}${slug}.png`;

// Icon URLs that failed to load: later renders show the letter straight away instead of flashing.
const brokenIcons = new Set();
// Icons the server's cache couldn't provide (unsaved preview, self-signed HTTPS…): load them directly.
const uncached = new Set();
let cacheBust = "";

/** After the server's icon cache was cleared: fetch every icon again. */
export function resetIconCache() {
  cacheBust = `&v=${Date.now()}`;
  brokenIcons.clear();
  uncached.clear();
}

/** Emoji, image URL or dashboard-icons slug; falls back to a coloured first letter. */
export function iconNode(icon, name, cls = "icon") {
  const box = h("div", { class: cls });
  const value = String(icon || "").trim();
  const letter = () => {
    box.replaceChildren(
      h(
        "span",
        { class: "letter" },
        (String(name).trim()[0] || "?").toUpperCase(),
      ),
    );
    box.style.background = colorFor(name);
  };
  const remote = /^https?:\/\//i.test(value)
    ? value
    : isIconSlug(value)
      ? iconSlugUrl(value)
      : "";
  const src = remote || (value.startsWith("/") ? value : "");
  if (src && !brokenIcons.has(src)) {
    let cached = Boolean(remote) && !uncached.has(remote);
    const img = h("img", {
      src: cached
        ? `/api/icon?icon=${encodeURIComponent(value)}${cacheBust}`
        : src,
      alt: "",
      referrerpolicy: "no-referrer",
    });
    img.addEventListener("error", () => {
      if (cached) {
        cached = false;
        uncached.add(remote);
        img.src = src;
        return;
      }
      brokenIcons.add(src);
      letter();
    });
    box.append(img);
  } else if (value && !src) box.append(value);
  else letter();
  return box;
}

// ---------- Toast ----------

let toastTimer;
export function toast(msg, isError = false) {
  const el = $("#toast");
  el.textContent = msg;
  el.className = `toast show${isError ? " error" : ""}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(
    () => (el.className = "toast"),
    isError ? 4000 : 2000,
  );
}
