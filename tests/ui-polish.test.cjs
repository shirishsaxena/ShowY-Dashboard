const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = (file) =>
  fs.readFileSync(path.join(__dirname, "../public", file), "utf8");
function load(file, names, globals) {
  const code = source(file)
    .replace(/^import\s[\s\S]*?;\r?$/gm, "")
    .replace(/\bexport (?=(?:function|const)\b)/g, "");
  return vm.runInNewContext(`${code}\n;({${names.join(",")}})`, globals);
}

function fixture(mobile = true) {
  const document = { activeElement: null };
  class Element {
    constructor(tag) {
      this.tagName = tag.toUpperCase();
      this.children = [];
      this.dataset = {};
      this.open = false;
    }
    setAttribute(key, value) {
      if (key === "class") this.className = value;
      if (key === "data-stats-key") this.dataset.statsKey = value;
      if (key === "open") this.open = true;
      this[key] = key === "open" ? true : value;
    }
    append(...children) {
      for (const child of children)
        if (child instanceof Element) child.parentElement = this;
      this.children.push(...children);
    }
    replaceChildren(...children) {
      this.children = [];
      this.append(...children);
    }
    replaceWith(node) {
      const parent = this.parentElement;
      const index = parent.children.indexOf(this);
      if (node.parentElement) {
        const siblings = node.parentElement.children;
        siblings.splice(siblings.indexOf(node), 1);
      }
      parent.children[index] = node;
      node.parentElement = parent;
      this.parentElement = null;
    }
    get lastChild() {
      return this.children.at(-1);
    }
    get childElementCount() {
      return this.children.filter((n) => n instanceof Element).length;
    }
    contains(node) {
      return (
        node === this ||
        this.children.some((c) => c instanceof Element && c.contains(node))
      );
    }
    querySelector(selector) {
      const tag = selector.split(" ").at(-1);
      const matches = (el) =>
        tag === "details.stats-details"
          ? el.tagName === "DETAILS"
          : el.tagName === tag.toUpperCase();
      for (const child of this.children) {
        if (!(child instanceof Element)) continue;
        if (matches(child)) return child;
        const found = child.querySelector(selector);
        if (found) return found;
      }
      return null;
    }
    focus() {
      document.activeElement = this;
    }
  }
  const h = (tag, attrs = {}, ...children) => {
    const el = new Element(tag);
    for (const [key, value] of Object.entries(attrs))
      if (value != null && value !== false) el.setAttribute(key, value);
    el.append(
      ...children.flat(Infinity).filter((v) => v != null && v !== false),
    );
    return el;
  };
  document.createElementNS = (_, tag) => h(tag);
  const section = h("section");
  const stats = {
    mem: { used: 4, total: 8 },
    cpu: 20,
    cores: 4,
    load: [0],
    disks: [{ label: "Disk", used: 1, total: 4 }],
    uptime: 100,
    net: { rxRate: 1, txRate: 2, rx: 3, tx: 4, ifaces: ["eth0"] },
    availability: { enabled: false },
    temps: [{ name: "CPU", kind: "cpu", temp: 45 }],
  };
  const state = { query: "" };
  const globals = {
    document,
    window: { matchMedia: () => ({ matches: mobile }) },
    state,
    sourceOf: () => ({ stats }),
    $: () => section,
    h,
    fill: (el, ...children) => el.replaceChildren(
      ...children.flat(Infinity).filter((v) => v != null && v !== false),
    ),
    svg: () => h("svg"),
    fmtBytes: String,
    fmtUptime: String,
    fmtDuration: String,
    fmtDateTime: String,
    fmtPercent: String,
    plural: String,
    openAvailability: () => {},
  };
  return {
    ...globals,
    section,
    stats,
    ...load("js/view/stats.js", ["renderStats"], globals),
  };
}

test("mobile keeps system and optional stats directly visible", () => {
  const f = fixture();
  f.renderStats({ id: "one", local: true });
  assert.equal(f.section.children[0].className, "stat-card system");
  assert.equal(f.section.querySelector("details.stats-details"), null);
  assert.deepEqual(
    Array.from(f.section.children, (c) => c.className),
    ["stat-card system", "stat-card network", "stat-card availability", "stat-card sensors"],
  );
});

test("history trigger and keyboard focus survive refresh only for the same server", () => {
  const f = fixture();
  const one = { id: "one", local: true };
  const two = { id: "two", local: true };
  f.renderStats(one);
  const button = f.section.querySelector("button");
  button.focus();
  f.renderStats(one);
  assert.equal(f.section.querySelector("button"), button);
  assert.equal(f.document.activeElement, f.section.querySelector("button"));
  f.renderStats(two);
  assert.notEqual(f.section.querySelector("button"), button);
  assert.notEqual(f.document.activeElement, f.section.querySelector("button"));
});

test("desktop shows optional stats directly and omits cards without data", () => {
  const f = fixture(false);
  f.renderStats({ id: "one", local: true });
  assert.equal(f.section.children.length, 4);
  assert.equal(f.section.querySelector("details.stats-details"), null);
  delete f.stats.net;
  delete f.stats.availability;
  delete f.stats.temps;
  f.renderStats({ id: "one", local: true });
  assert.equal(f.section.children.length, 1);
  f.state.query = "search";
  f.renderStats({ id: "one", local: true });
  assert.equal(f.section.hidden, true);
});

test("history trigger identity and busy state survive polls", () => {
  const f = fixture();
  const server = { id: "one", local: true };
  f.renderStats(server);
  const button = f.section.querySelector("button");
  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  button.textContent = "Loading history…";
  f.renderStats(server);
  assert.equal(f.section.querySelector("button"), button);
  assert.equal(button.disabled, true);
  assert.equal(button["aria-busy"], "true");
  assert.equal(button.textContent, "Loading history…");
});

test("freshness is neutral for routine updates and amber for stale data", () => {
  const now = Date.now();
  const state = {
    localAt: now,
    remotesInterval: 10,
    tunables: { localStale: 30 },
  };
  const src = { ok: true, at: now, lastOk: now };
  const { staleness } = load("js/view/server.js", ["staleness"], {
    state,
    sourceOf: () => src,
  });
  assert.equal(staleness({ local: true }).level, "");
  assert.equal(staleness({ local: true }).label, "");
  assert.equal(staleness({ local: true }).since, now);
  state.localAt = now - 31_000;
  assert.equal(staleness({ local: true }).level, "amber");
  assert.equal(staleness({ local: true }).dim, false);
  state.localAt = now;
  state.localError = "A required source failed";
  assert.equal(staleness({ local: true }).label, "Refresh incomplete ·");
  assert.equal(staleness({ local: true }).level, "amber");
  assert.equal(staleness({ remote: "remote" }).level, "");
  // Receipt of a cached snapshot must not reset its last-success age.
  src.lastOk = now - 31_000;
  assert.equal(staleness({ remote: "remote" }).level, "amber");
  assert.equal(staleness({ remote: "remote" }).since, src.lastOk);
  assert.equal(staleness({ remote: "remote" }).dim, true);
  src.ok = false;
  assert.equal(staleness({ remote: "remote" }).level, "red");
});

test("preferred service link is distinguished without changing destinations", () => {
  const f = fixture();
  const { linkChips } = load("js/view/cards.js", ["linkChips"], {
    h: f.h,
    svg: f.svg,
    state: { editing: true },
    safeUrl: (v) => v,
    primaryUrl: (svc) => svc.altUrl,
    hostPort: () => "",
    hostLabel: (v) => v,
    hostOf: (v) => v,
    external: { target: "_blank", rel: "noopener noreferrer" },
  });
  const links = linkChips(
    { url: "http://local/", altUrl: "https://remote/" },
    new Set(),
  );
  assert.equal(links[0].className, "chip");
  assert.equal(links[1].className, "chip primary-link");
  assert.equal(links[1].href, "https://remote/");
  assert.equal(links[1].rel, "noopener noreferrer");
});

test("CSS scopes boot hiding and supplies focus, touch, and quiet freshness styles", () => {
  const css = source("app.css");
  assert.match(css, /body\.booting #appShell/);
  assert.doesNotMatch(css, /body\.booting::after/);
  assert.match(css, /\.boot-spinner\s*\{/);
  assert.match(css, /:is\(button, a, summary\):focus-visible/);
  assert.match(css, /@media \(pointer: coarse\)/);
  assert.match(css, /\.chip\.age\s*\{[^}]*color: var\(--muted\)/);
});
