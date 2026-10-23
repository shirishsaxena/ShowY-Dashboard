"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ID = "a".repeat(64);
const read = (file) => fs.readFileSync(path.join(__dirname, "..", file), "utf8");
function browserModule(file, names, globals) {
  const code = read(`public/js/${file}`)
    .replace(/^import[\s\S]*?;\r?$/gm, "")
    .replace(/\bexport (?=(?:async )?(?:function|class|const|let)\b)/g, "");
  return vm.runInNewContext(`${code}\n;({ ${names.join(", ")} });`, globals, { filename: file });
}

function deferred() {
  let resolve;
  const promise = new Promise((yes) => { resolve = yes; });
  return { promise, resolve };
}

function domFixture() {
  const nodes = new Map();
  const document = { activeElement: null, listeners: {}, addEventListener(type, callback) { this.listeners[type] = callback; } };
  function element(tag, attrs = {}, ...children) {
    const node = {
      tag, attrs: {}, dataset: {}, style: {}, classes: new Set(), listeners: {},
      children: children.flat(Infinity).filter((item) => item != null && item !== false),
      textContent: "", isConnected: true, offsetWidth: 230, offsetHeight: 100,
      classList: {
        add: (...values) => values.forEach((value) => node.classes.add(value)),
        remove: (...values) => values.forEach((value) => node.classes.delete(value)),
      },
      setAttribute(key, value) {
        this.attrs[key] = String(value);
        if (key.startsWith("data-")) this.dataset[key.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = String(value);
        if (key === "disabled") this.disabled = true;
      },
      addEventListener(type, callback) { this.listeners[type] = callback; },
      emit(type, overrides = {}) {
        return this.listeners[type]?.({ target: this, currentTarget: this, preventDefault() {}, stopPropagation() {}, ...overrides });
      },
      focus() { document.activeElement = this; },
      showModal() { this.open = true; },
      close() { this.open = false; return this.emit("close"); },
      showPopover() { this.popoverOpen = true; return this.emit("toggle"); },
      hidePopover() { this.popoverOpen = false; return this.emit("toggle"); },
      matches(selector) { return selector === ":popover-open" && this.popoverOpen; },
      contains(other) { return this === other || this.children.some((child) => child?.contains?.(other)); },
      getBoundingClientRect() { return { bottom: 790, right: 310 }; },
      querySelectorAll(selector) {
        return this.children.flatMap((child) => typeof child === "object"
          ? [(child.tag === "button" && (!selector.includes(":not(:disabled)") || !child.disabled)) ? child : null, ...child.querySelectorAll(selector)].filter(Boolean) : []);
      },
      querySelector(selector) { return this.querySelectorAll(selector)[0]; },
    };
    for (const [key, value] of Object.entries(attrs)) {
      if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
      else if (value !== false && value != null) node.setAttribute(key, value);
    }
    return node;
  }
  const $ = (id) => {
    if (!nodes.has(id)) nodes.set(id, element("div"));
    return nodes.get(id);
  };
  document.querySelectorAll = () => [...nodes.values()].filter((node) => node.dataset.cardMenuKey);
  return { $, nodes, document, h: element, svg: (name) => element("svg", { name }),
    fill: (node, ...children) => { node.children = children.flat(Infinity).filter(Boolean); } };
}

function logsFixture() {
  const dom = domFixture();
  const requests = [];
  const state = { locked: false };
  const api = browserModule("dialogs/docker-logs.js", ["openContainerLogs", "initDockerLogs"], {
    ...dom, state, AbortController,
    editApi: (method, url, body, options) => {
      const pending = deferred();
      requests.push({ method, url, body, options, ...pending });
      return pending.promise;
    },
  });
  api.initDockerLogs();
  const reply = (request, data = {}) => request.resolve({ res: { ok: true }, data: {
    text: "hello", tail: 250, fetchedAt: Date.now(), ...data,
  } });
  return { ...dom, ...api, requests, state, reply };
}

test("logs load once, render plain text and refresh only on explicit user interaction", async () => {
  const h = logsFixture();
  const first = h.openContainerLogs({ id: ID, name: "my-app" });
  assert.equal(h.$("#dockerLogsDialog").open, true);
  assert.equal(h.$("#dockerLogsName").textContent, "my-app");
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].method, "GET");
  assert.match(h.requests[0].url, /tail=250$/);
  assert.equal(h.$("#dockerLogsRefresh").disabled, true);
  const text = '<script>alert("logs are text")</script>\nerror';
  h.reply(h.requests[0], { text });
  await first;
  assert.equal(h.$("#dockerLogsOutput").textContent, text);
  assert.equal(h.$("#dockerLogsOutput").children.length, 0);
  assert.match(h.$("#dockerLogsStatus").textContent, /Manual refresh only/);
  assert.equal(h.$("#dockerLogsRefresh").disabled, false);
  await new Promise(setImmediate);
  assert.equal(h.requests.length, 1);
  const refresh = h.$("#dockerLogsRefresh").emit("click");
  assert.equal(h.requests.length, 2);
  h.reply(h.requests[1], { truncated: true });
  await refresh;
  assert.match(h.$("#dockerLogsStatus").textContent, /cut short at 1 MiB/);
  h.$("#dockerLogsLines").value = "100";
  const change = h.$("#dockerLogsLines").emit("change");
  assert.match(h.requests[2].url, /tail=100$/);
  h.reply(h.requests[2], { text: "", tail: 100 });
  await change;
  assert.match(h.$("#dockerLogsOutput").textContent, /No log output/);
});

test("closing logs aborts retrieval, erases sensitive text and ignores old responses after reopening", async () => {
  const h = logsFixture();
  const source = h.h("button", { "data-card-menu-key": "service:one" });
  h.nodes.set("source", source);
  source.focus();
  const first = h.openContainerLogs({ id: ID, name: "one" });
  h.$("#dockerLogsDialog").close();
  assert.equal(h.requests[0].options.signal.aborted, true);
  assert.equal(h.requests[0].options.current(), false);
  assert.equal(h.$("#dockerLogsOutput").textContent, "");
  assert.equal(h.document.activeElement, source);
  const second = h.openContainerLogs({ id: "b".repeat(64), name: "two" });
  h.reply(h.requests[0], { text: "obsolete secret" });
  await first;
  assert.equal(h.$("#dockerLogsOutput").textContent, "");
  assert.equal(h.$("#dockerLogsRefresh").disabled, true);
  h.reply(h.requests[1], { text: "current secret" });
  await second;
  assert.equal(h.$("#dockerLogsOutput").textContent, "current secret");
  h.$("#dockerLogsDialog").close();
  assert.equal(h.$("#dockerLogsOutput").textContent, "");
  assert.equal(h.$("#dockerLogsName").textContent, "");
});

test("logs report access cancellation, Docker errors and malformed responses without retaining output", async () => {
  const h = logsFixture();
  for (const result of [null, { res: { ok: false, status: 404 }, data: { error: "Container removed" } },
    { res: { ok: true }, data: {} }]) {
    const pending = h.openContainerLogs({ id: ID, name: "one" });
    h.requests.at(-1).resolve(result);
    await pending;
    assert.equal(h.$("#dockerLogsOutput").textContent, "");
    assert.equal(h.$("#dockerLogsRefresh").disabled, false);
    if (!result) assert.match(h.$("#dockerLogsStatus").textContent, /cancelled/);
    else {
      assert.equal(h.$("#dockerLogsError").hidden, false);
      assert.match(h.$("#dockerLogsError").textContent, /Container removed|Invalid log response/);
    }
  }
});

test("card menu handles tap, keyboard navigation, viewport bounds and focus after card replacement", async () => {
  const dom = domFixture();
  const calls = [];
  const window = { addEventListener() {} };
  const menu = browserModule("view/card-menu.js", ["cardMenuButton", "containerLogItem", "initCardMenu"], {
    ...dom, window, innerWidth: 320, innerHeight: 800,
    toast: (message) => calls.push(message), openContainerLogs: (container) => calls.push(container.id),
  });
  menu.initCardMenu();
  const items = [menu.containerLogItem({ id: ID, name: "app" }),
    { label: "Edit service", icon: "edit", run: () => calls.push("edit") }];
  const button = menu.cardMenuButton("app", "service:app", items);
  dom.nodes.set("source", button);
  let prevented = false;
  button.emit("click", { preventDefault() { prevented = true; } });
  const pop = dom.$("#cardMenu");
  assert.equal(prevented, true);
  assert.equal(pop.popoverOpen, true);
  assert.equal(button.attrs["aria-expanded"], "true");
  assert.equal(pop.style.top, "692px");
  assert.equal(dom.document.activeElement, pop.children[0]);
  pop.emit("keydown", { key: "ArrowDown" });
  assert.equal(dom.document.activeElement, pop.children[1]);
  pop.emit("keydown", { key: "Home" });
  assert.equal(dom.document.activeElement, pop.children[0]);
  const replacement = menu.cardMenuButton("app", "service:app", items);
  button.isConnected = false;
  dom.nodes.set("source", replacement);
  await pop.children[0].emit("click");
  assert.equal(pop.popoverOpen, false);
  assert.equal(dom.document.activeElement, replacement);
  assert.equal(calls[0], ID);
  replacement.emit("click");
  pop.emit("keydown", { key: "Escape" });
  assert.equal(dom.document.activeElement, replacement);
  assert.equal(pop.popoverOpen, false);
  assert.equal(menu.containerLogItem(null).disabled, true);
  assert.equal(menu.containerLogItem({ id: "short" }).disabled, true);
});

test("only local Docker service cards get log/edit menus, including missing containers", async () => {
  const dom = domFixture();
  const menus = [];
  const edits = [];
  let allowed = false;
  let container = { id: ID, name: "app" };
  const { serviceCard } = browserModule("view/cards.js", ["serviceCard"], {
    ...dom, state: { editing: false }, isFavorite: () => false,
    serviceUrls: () => [], primaryUrl: () => "", monitoringUrl: () => "", hostPort: () => "",
    containerFor: (svc) => svc.type === "web" ? undefined : container,
    serviceStatus: () => null, statusNode: () => null, iconNode: () => null,
    usageNode: () => null, external: {},
    actions: { ensureCanEdit: async () => allowed },
    openServiceEditor: (...args) => edits.push(args),
    containerLogItem: (value) => ({ label: "Show logs", disabled: !value }),
    cardMenuButton: (name, key, items) => { menus.push({ name, key, items }); return null; },
  });
  const svc = { id: "svc", type: "docker", name: "app" };
  const local = { id: "host", local: true };
  serviceCard(svc, local);
  assert.equal(menus.length, 1);
  assert.equal(menus[0].items[0].label, "Show logs");
  await menus[0].items[1].run();
  assert.equal(edits.length, 0);
  allowed = true;
  await menus[0].items[1].run();
  assert.deepEqual(edits, [["host", "svc"]]);
  serviceCard(svc, { ...local, remote: "peer" });
  serviceCard(svc, { ...local, local: false });
  serviceCard({ ...svc, type: "web" }, local);
  assert.equal(menus.length, 1);
  container = null;
  serviceCard(svc, local);
  assert.equal(menus.length, 2);
  assert.equal(menus[1].items[0].disabled, true);
  assert.equal(menus[1].items[1].label, "Edit service");
});
