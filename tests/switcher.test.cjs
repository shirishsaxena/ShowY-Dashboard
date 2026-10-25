"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const source = (file) =>
  fs.readFileSync(path.join(__dirname, "../public", file), "utf8");

function fixture() {
  const document = { activeElement: null };
  class Element {
    constructor(tag = "div") {
      this.tag = tag;
      this.dataset = {};
      this.attrs = {};
      this.children = [];
      this.disabled = false;
      this.open = false;
      this.scrollTop = 0;
      this.classes = new Set();
      this.classList = {
        remove: (name) => this.classes.delete(name),
        toggle: (name, value) =>
          value ? this.classes.add(name) : this.classes.delete(name),
      };
    }
    setAttribute(key, value) {
      this.attrs[key] = value;
      if (key.startsWith("data-"))
        this.dataset[
          key.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())
        ] = value;
      else if (key === "class") this.className = value;
      else this[key] = value;
    }
    querySelectorAll(selector) {
      return this.children.flatMap((child) =>
        typeof child === "string"
          ? []
          : [
              ...(selector.startsWith("button") && child.tag === "button"
                ? [child]
                : []),
              ...child.querySelectorAll(selector),
            ],
      );
    }
    matches() {
      return this.open;
    }
    hidePopover() {
      this.open = false;
    }
    focus() {
      document.activeElement = this;
    }
    get textContent() {
      return (
        this.text ||
        this.children
          .map((child) =>
            typeof child === "string" ? child : child.textContent,
          )
          .join(" ")
      );
    }
    set textContent(value) {
      this.text = value;
    }
  }
  const h = (tag, attrs = {}, ...children) => {
    const el = new Element(tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (value == null || value === false) continue;
      if (key.startsWith("on")) el[key] = value;
      else el.setAttribute(key, value);
    }
    el.children = children
      .flat(Infinity)
      .filter((child) => child != null && child !== false);
    return el;
  };
  const nodes = new Map();
  const $ = (id) => {
    if (!nodes.has(id)) nodes.set(id, new Element());
    return nodes.get(id);
  };
  const local = {
    id: "local",
    name: "Local",
    local: true,
    services: [],
    icon: "",
  };
  const state = {
    config: { settings: { title: "Home Lab" }, servers: [local] },
    remotes: [],
    remotesReady: false,
    remotesError: "",
    activeId: "local",
    query: "find",
    editing: false,
  };
  const allServers = () => [
    ...state.config.servers,
    ...state.remotes.flatMap((remote) => remote.servers),
  ];
  const prefs = new Map();
  let loads = 0;
  let renders = 0;
  const globals = {
    state,
    document,
    $,
    h,
    allServers,
    activeServer: () =>
      allServers().find((server) => server.id === state.activeId) || local,
    sourceOf: (server) =>
      state.remotes.find((remote) => remote.id === server.remote) || state,
    setPref: (key, value) => prefs.set(key, value),
    fill: (node, ...children) => {
      node.children = children
        .flat(Infinity)
        .filter((child) => child != null && child !== false);
    },
    svg: () => h("svg"),
    iconNode: () => h("span"),
    dragHandle: () => h("span"),
    serverCounts: () => ({ up: 0, down: 0, warn: 0 }),
    plural: (count, noun) => `${count} ${noun}${count === 1 ? "" : "s"}`,
    startLoad: () => {
      loads++;
    },
    render: () => {
      renders++;
    },
  };
  const code = source("js/view/switcher.js")
    .replace(/^import\s[\s\S]*?;\r?$/gm, "")
    .replace(/\bexport (?=function\b)/g, "");
  const { renderSwitcher } = vm.runInNewContext(
    `${code}\n;({renderSwitcher})`,
    globals,
  );
  return {
    state,
    local,
    document,
    $,
    prefs,
    renderSwitcher,
    calls: () => ({ loads, renders }),
    buttons: () => $("#serverList").querySelectorAll("button"),
    button: (key) =>
      $("#serverList")
        .querySelectorAll("button")
        .find((button) => button.dataset.switcherKey === key),
    click: (button) => button.onclick({ target: { closest: () => null } }),
  };
}

const pending = (id) => ({
  id,
  name: `${id} dashboard`,
  loading: true,
  servers: [],
});
const ready = (id) => ({
  ...pending(id),
  ok: true,
  loading: false,
  servers: [
    { id: `${id}:host`, name: `${id} server`, remote: id, services: [] },
  ],
});

test("selector opens during discovery and local selection is never blocked", () => {
  const f = fixture();
  f.renderSwitcher();
  assert.equal(f.$("#serverBtn").disabled, false);
  assert.match(f.$("#serverMenuStatus").textContent, /Discovering/);
  f.$("#serverMenu").open = true;
  f.click(f.button("server:local"));
  assert.equal(f.$("#serverMenu").open, false);
  assert.equal(f.state.activeId, "local");
  assert.equal(f.state.query, "");
  assert.equal(f.$("#search").value, "");
  assert.equal(f.prefs.get("tab"), "local");
  assert.deepEqual(f.calls(), { loads: 1, renders: 1 });
});

test("each pending remote has its own named disabled loading row", () => {
  const f = fixture();
  f.state.remotes = [pending("slow"), pending("fast")];
  f.renderSwitcher();
  assert.equal(f.button("server:local").disabled, false);
  for (const id of ["slow", "fast"]) {
    const button = f.button(`remote:${id}`);
    assert.equal(button.disabled, true);
    assert.equal(button.attrs["aria-busy"], "true");
    assert.match(button.textContent, new RegExp(`${id} dashboard.*Connecting`));
    assert.equal(button.children.at(-1).className, "server-item-spinner");
    assert.equal(button.onclick, undefined);
  }
  assert.match(f.$("#serverMenuStatus").textContent, /2 loading/);
});

test("a ready remote becomes selectable while another remote is still loading", () => {
  const f = fixture();
  f.state.remotes = [pending("slow"), ready("fast")];
  f.renderSwitcher();
  assert.equal(f.$("#serverBtn").disabled, false);
  assert.equal(f.button("remote:slow").disabled, true);
  const fast = f.button("server:fast:host");
  assert.equal(fast.disabled, false);
  f.click(fast);
  assert.equal(f.state.activeId, "fast:host");
  assert.equal(f.prefs.get("tabName"), "fast server");
});

test("known remote servers remain selectable and show updating state on later polls", () => {
  const f = fixture();
  f.state.remotes = [{ ...ready("cached"), loading: true }];
  f.renderSwitcher();
  const button = f.button("server:cached:host");
  assert.equal(button.disabled, false);
  assert.match(button.textContent, /Updating/);
  assert.equal(button.children.at(-1).className, "server-item-spinner");
});

test("a failed unresolved remote stops spinning and explains how to retry", () => {
  const f = fixture();
  f.state.remotes = [
    { ...pending("failed"), loading: false, error: "Timed out" },
  ];
  f.renderSwitcher();
  const button = f.button("remote:failed");
  assert.equal(button.attrs["aria-busy"], undefined);
  assert.match(button.textContent, /Unavailable.*Refresh/);
  assert.equal(button.children.at(-1).className, "dot down");
  assert.equal(f.$("#serverBtn").disabled, false);
});

test("peer completion preserves the open selector's keyboard focus and scroll", () => {
  const f = fixture();
  f.state.remotes = [pending("remote")];
  f.renderSwitcher();
  f.$("#serverMenu").open = true;
  f.$("#serverMenu").scrollTop = 80;
  const old = f.button("server:local");
  old.focus();
  f.state.remotes = [ready("remote")];
  f.renderSwitcher();
  assert.notEqual(f.document.activeElement, old);
  assert.equal(f.document.activeElement, f.button("server:local"));
  assert.equal(f.$("#serverMenu").scrollTop, 80);
});

test("selector keyboard navigation skips disabled remotes and wraps enabled rows", () => {
  const f = fixture();
  f.state.remotes = [pending("slow"), ready("fast")];
  f.renderSwitcher();
  f.button("server:local").focus();
  let prevented = 0;
  const press = (key) =>
    f.$("#serverMenu").onkeydown({
      key,
      preventDefault() {
        prevented++;
      },
    });
  press("ArrowDown");
  assert.equal(f.document.activeElement, f.button("server:fast:host"));
  press("ArrowDown");
  assert.equal(f.document.activeElement, f.button("server:local"));
  press("End");
  assert.equal(f.document.activeElement, f.button("server:fast:host"));
  press("Home");
  assert.equal(f.document.activeElement, f.button("server:local"));
  press("ArrowUp");
  assert.equal(f.document.activeElement, f.button("server:fast:host"));
  assert.equal(prevented, 5);
});

test("a single local-only server stops offering an empty selector after discovery", () => {
  const f = fixture();
  f.state.remotesReady = true;
  f.$("#serverMenu").open = true;
  f.renderSwitcher();
  assert.equal(f.$("#serverBtn").disabled, true);
  assert.equal(f.$("#serverMenu").open, false);
});

test("mobile server popover fills the padded viewport and has accessible status", () => {
  assert.match(
    source("css/responsive.css"),
    /\.menu\.server-menu\s*\{\s*width: calc\(100vw - 28px\);/,
  );
  assert.match(
    source("css/controls.css"),
    /\.server-item-spinner\s*\{[^}]*animation: spin/,
  );
  assert.match(
    source("index.html"),
    /id="serverMenu"[^>]*role="dialog"[^>]*aria-labelledby="serverMenuTitle"/,
  );
  assert.match(
    source("index.html"),
    /id="serverMenuStatus"[^>]*role="status"[^>]*aria-live="polite"/,
  );
});

test("saved remote loading reveals navigation without bypassing the lock screen", () => {
  const code = source("js/main.js");
  const reveal = code.slice(
    code.indexOf("function revealDashboard()"),
    code.indexOf("let starting = false"),
  );
  const f = fixture();
  f.state.loading = { kind: "remote", blocking: true, stage: "connecting" };
  const classes = [];
  const { revealDashboard } = vm.runInNewContext(
    `${reveal};({revealDashboard})`,
    {
      state: f.state,
      $: f.$,
      document: {
        body: { classList: { remove: (...values) => classes.push(...values) } },
      },
    },
  );
  f.$("#appShell").hidden = true;
  f.$("#appShell").inert = true;
  f.state.locked = true;
  revealDashboard();
  assert.equal(f.$("#appShell").hidden, true);
  f.state.locked = false;
  revealDashboard();
  assert.equal(f.$("#appShell").hidden, false);
  assert.equal(f.$("#appShell").inert, false);
  assert.equal(f.$("#bootScreen").hidden, true);
  assert.ok(classes.includes("booting"));
});

test("server popover focuses its current row and stays inside the viewport after resize", () => {
  const code = source("js/main.js");
  const anchor = code.slice(
    code.indexOf("function anchorMenu("),
    code.indexOf("function initEditDock()"),
  );
  const listeners = new Map();
  const windowEvents = new Map();
  let focused = false;
  const active = {
    focus() {
      focused = true;
    },
  };
  const menu = {
    id: "serverMenu",
    offsetWidth: 332,
    style: {},
    addEventListener: (name, fn) => listeners.set(name, fn),
    matches: () => true,
    querySelector: () => active,
  };
  const attributes = new Map();
  const button = {
    getBoundingClientRect: () => ({ left: 14, right: 346, bottom: 68 }),
    setAttribute: (name, value) => attributes.set(name, value),
  };
  const globals = {
    innerWidth: 360,
    innerHeight: 800,
    window: { addEventListener: (name, fn) => windowEvents.set(name, fn) },
  };
  const { anchorMenu } = vm.runInNewContext(
    `${anchor};({anchorMenu})`,
    globals,
  );
  anchorMenu(menu, button, "left");
  listeners.get("toggle")({ newState: "open" });
  assert.equal(attributes.get("aria-expanded"), "true");
  assert.equal(focused, true);
  assert.equal(menu.style.left, "14px");
  assert.equal(menu.style.top, "76px");
  assert.equal(menu.style.maxHeight, "716px");
  globals.innerHeight = 120;
  windowEvents.get("resize")();
  assert.equal(menu.style.maxHeight, "36px");
  listeners.get("toggle")({ newState: "closed" });
  assert.equal(attributes.get("aria-expanded"), "false");
});
