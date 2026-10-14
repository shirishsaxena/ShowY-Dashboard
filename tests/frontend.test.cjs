const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const publicDir = path.resolve(__dirname, "../public");
const source = (file) => fs.readFileSync(path.join(publicDir, file), "utf8");
const flush = () => new Promise(setImmediate);

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

// Evaluate browser modules with explicit dependency stubs, without dependencies or VM flags.
function browserModule(file, names, globals = {}) {
  const code = source(file)
    .replace(/^import[\s\S]*?;\r?$/gm, "")
    .replace(/\bexport (?=(?:async )?(?:function|class|const|let)\b)/g, "");
  return vm.runInNewContext(`${code}\n;({ ${names.join(", ")} });`, globals, {
    filename: file,
  });
}

class Element {
  constructor(kind = "") {
    this.kind = kind;
    this.children = [];
    this.listeners = new Map();
    this.dataset = {};
    this.style = {};
    this.classes = new Set();
    this.classList = {
      add: (...names) => names.forEach((name) => this.classes.add(name)),
      remove: (...names) => names.forEach((name) => this.classes.delete(name)),
    };
  }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(fn);
  }
  removeEventListener(type, fn) {
    this.listeners.get(type)?.delete(fn);
  }
  emit(type, event) {
    for (const fn of [...(this.listeners.get(type) || [])]) fn(event);
  }
  append(...children) {
    for (const child of children) this.insertBefore(child, null);
  }
  insertBefore(child, before) {
    child.remove();
    const index = before ? this.children.indexOf(before) : this.children.length;
    this.children.splice(index, 0, child);
    child.parentElement = this;
  }
  remove() {
    if (this.parentElement) {
      const children = this.parentElement.children;
      children.splice(children.indexOf(this), 1);
      this.parentElement = null;
    }
  }
  get nextSibling() {
    const siblings = this.parentElement.children;
    return siblings[siblings.indexOf(this) + 1] || null;
  }
  matches(selector) {
    return this.kind === selector;
  }
  closest(selector) {
    return this.matches(selector)
      ? this
      : this.parentElement?.closest(selector);
  }
  contains(node) {
    return node === this || this.children.some((child) => child.contains(node));
  }
  cloneNode() {
    return new Element(this.kind);
  }
  getBoundingClientRect() {
    return { left: 0, top: 0, width: 100, height: 50 };
  }
}

function serviceTypeHarness() {
  const stateModule = browserModule("js/state.js", ["state", "sourceOf", "normalizeConfig", "allServers"], {
    localStorage: { getItem: () => null },
  });
  const utils = browserModule("js/utils.js", ["norm", "portOf", "plural", "serviceUrls", "monitoringUrl", "primaryUrl"], {
    URL, location: { hostname: "localhost" },
  });
  const h = (tag, attrs, ...children) => ({ tag, attrs, children: children.flat(Infinity).filter((x) => x != null) });
  const status = browserModule("js/status.js", ["containerFor", "containerStatus", "serviceStatus", "serverCounts", "statusNode", "duplicateHosts"], {
    ...utils, sourceOf: stateModule.sourceOf, h, URL,
  });
  const { state } = stateModule;
  state.docker = { available: true, containers: [
    { name: "app", state: "running", status: "Up", ports: [8080] },
    { name: "stopped", state: "exited", status: "Exited", ports: [] },
  ] };
  return { ...stateModule, ...utils, ...status, h };
}

test("typed matching excludes web/bookmarks and Docker has no automatic fallback; legacy remains", () => {
  const h = serviceTypeHarness();
  const server = { local: true };
  const base = { id: "svc", name: "app", url: "http://host:8080" };
  assert.equal(h.containerFor(base, server).name, "app");
  assert.equal(h.containerFor({ ...base, name: "other" }, server).name, "app");
  assert.equal(h.containerFor({ ...base, url: "" }, server).name, "app");
  assert.equal(h.containerFor({ ...base, type: "docker" }, server), null);
  assert.equal(h.containerFor({ ...base, type: "docker", container: "missing" }, server), null);
  assert.equal(h.containerFor({ ...base, type: "docker", container: "APP" }, server).name, "app");
  for (const type of ["web", "bookmark", "future", "", null])
    assert.equal(h.containerFor({ ...base, type, container: "app" }, server), undefined);
  h.state.docker.available = false;
  assert.equal(h.containerFor({ ...base, type: "docker", container: "app" }, server), undefined);
});

test("typed statuses ignore cached bookmark health, use HTTP-only web and require Docker evidence", () => {
  const h = serviceTypeHarness();
  const server = { local: true };
  const svc = { id: "svc", name: "app", url: "http://host:8080", container: "app" };
  h.state.health.svc = { state: "down", error: "refused" };
  const bookmark = h.serviceStatus({ ...svc, type: "bookmark" }, server);
  assert.equal(bookmark.level, "neutral");
  assert.equal(bookmark.label, "Bookmark");
  assert.doesNotMatch(bookmark.title, /HTTP|Docker|refused/);
  assert.equal(h.statusNode(bookmark).attrs.class, "status neutral");
  assert.equal(h.serviceStatus({ ...svc, type: "web" }, server).level, "down");
  assert.doesNotMatch(h.serviceStatus({ ...svc, type: "web" }, server).title, /Docker|Container/);
  assert.equal(h.serviceStatus({ ...svc, type: "docker" }, server).level, "warn");
  h.state.health.svc = { state: "up", code: 200, ms: 2 };
  assert.equal(h.serviceStatus({ ...svc, type: "docker" }, server).level, "up");
  assert.equal(h.serviceStatus({ ...svc, type: "docker", container: "stopped" }, server).level, "down");
  for (const container of ["", "missing"]) {
    assert.equal(h.serviceStatus({ ...svc, type: "docker", container }, server).level, "unknown");
    assert.equal(h.serviceStatus({ ...svc, container: "missing" }, server).level, "up");
  }
  h.state.docker.available = false;
  assert.equal(h.serviceStatus({ ...svc, type: "docker" }, server).label, "Docker unavailable");
  assert.equal(h.serviceStatus({ ...svc, type: "web" }, server).level, "up");
  assert.equal(h.serviceStatus(svc, server).level, "up");
  h.state.docker.available = true;
  assert.equal(h.serviceStatus({ ...svc, type: "docker" }, { local: false }).level, "unknown");
  for (const type of [null, "", "tcp"])
    assert.equal(h.serviceStatus({ ...svc, type }, server).label, "Unknown type");
  h.state.health.svc = { state: "error", code: 404, ms: 1 };
  assert.equal(h.serviceStatus({ ...svc, type: "web" }, server).label, "Not found");
  delete h.state.health.svc;
  assert.equal(h.serviceStatus({ ...svc, type: "web" }, server), null);
});

test("type transitions immediately ignore stale health/resources and remote types use their own source", () => {
  const h = serviceTypeHarness();
  const svc = { id: "svc", name: "app", type: "docker", container: "app", url: "http://host:8080" };
  const server = { local: true, services: [svc] };
  h.state.health.svc = { state: "up", code: 200, ms: 1 };
  assert.equal(h.serviceStatus(svc, server).level, "up");
  svc.type = "bookmark";
  assert.equal(h.containerFor(svc, server), undefined);
  assert.equal(h.serviceStatus(svc, server).level, "neutral");
  svc.type = "web";
  assert.equal(h.containerFor(svc, server), undefined);
  assert.equal(h.serviceStatus(svc, server).label, "Online");
  svc.type = "docker";
  svc.container = "missing";
  assert.equal(h.serviceStatus(svc, server).level, "unknown");
  const remote = { id: "remote", docker: { available: true, containers: [
    { name: "app", state: "exited", status: "Exited", ports: [8080] },
  ] }, health: { svc: { state: "down", error: "remote failure" } } };
  h.state.remotes = [remote];
  server.remote = "remote";
  svc.container = "app";
  assert.equal(h.serviceStatus(svc, server).level, "down");
  svc.type = "web";
  assert.match(h.serviceStatus(svc, server).title, /remote failure/);
  svc.type = "bookmark";
  assert.equal(h.serviceStatus(svc, server).level, "neutral");
  const normalized = h.normalizeConfig({ servers: [server] });
  assert.equal(normalized.servers[0].services[0].type, "bookmark");
});

test("summary and server counts exclude bookmarks from health while retaining truthful service totals", () => {
  const h = serviceTypeHarness();
  const server = { id: "host", local: true, services: [
    { id: "web", name: "Web", type: "web", url: "http://web.test" },
    { id: "bookmark", name: "Bookmark", type: "bookmark", url: "http://link.test" },
    { id: "docker", name: "Docker", type: "docker", container: "missing" },
  ] };
  h.state.config.servers = [server];
  h.state.health = { web: { state: "up", code: 200 }, bookmark: { state: "down" } };
  const { summary } = browserModule("js/view/render.js", ["summary"], h);
  assert.equal(JSON.stringify(h.serverCounts(server)), JSON.stringify({ up: 1, warn: 0, down: 0 }));
  assert.match(summary(), /3 services · 1\/1 online/);
  server.services = [server.services[1]];
  assert.match(summary(), /1 service$/);
  assert.doesNotMatch(summary(), /online/);
});

test("unlisted discovery ignores Web/Bookmark membership and adds explicitly bound Docker services", async () => {
  const status = serviceTypeHarness();
  status.state.docker.containers = [{ name: "app", image: "app:latest", state: "running", status: "Up", ports: [8080] }];
  const server = { id: "host", local: true, mainUrl: "http://host.test", services: [
    { id: "web", type: "web", name: "app", container: "app", url: "http://host:8080" },
    { id: "bookmark", type: "bookmark", name: "app", container: "app", url: "http://host:8080" },
  ] };
  status.state.config.servers = [server];
  const section = {};
  const adds = [];
  const nodes = [];
  const { renderUnlisted } = browserModule("js/view/containers.js", ["renderUnlisted"], {
    ...status,
    h: (tag, attrs, ...children) => {
      const node = { tag, attrs, children: children.flat(Infinity), addEventListener() {} };
      nodes.push(node);
      return node;
    },
    $: () => section, fill: (node, contents) => { node.contents = contents; },
    prefs: { unlistedOpen: true }, setPref() {}, hostOf: () => "host.test",
    location: { hostname: "localhost" }, svg: () => null, iconNode: () => null,
    iconBtn: () => null, external: {}, usageNode: () => null, groupUsageNode: () => null,
    actions: { ensureCanEdit: async () => true },
    openServiceEditor: (...args) => adds.push(args),
  });
  renderUnlisted(server);
  assert.equal(section.hidden, false);
  assert.match(JSON.stringify(section.contents), /1 Docker container/);
  const add = nodes.find((node) => node.tag === "button" && node.children.includes("Add"));
  assert.ok(add);
  await add.attrs.onclick();
  assert.equal(adds[0][2].type, "docker");
  assert.equal(adds[0][2].container, "app");
  server.services.push({ id: "docker", name: "Docker", type: "docker", container: "app" });
  renderUnlisted(server);
  assert.equal(section.hidden, true);
  server.services.at(-1).container = "missing";
  renderUnlisted(server);
  assert.equal(section.hidden, false);
  delete server.services.at(-1).type;
  delete server.services.at(-1).container;
  server.services.at(-1).name = "app";
  renderUnlisted(server);
  assert.equal(section.hidden, true);
});

test("remote browser loading preserves service types, legacy omission and originating health", () => {
  const h = serviceTypeHarness();
  const { remoteEntry } = browserModule("js/api.js", ["remoteEntry"], {
    state: h.state, normalizeConfig: h.normalizeConfig,
  });
  const remote = remoteEntry({ id: "peer", name: "Peer", ok: true, age: 0, lastOk: 1,
    docker: h.state.docker, usage: { stats: {} }, health: { bookmark: { state: "down" } },
    servers: [{ id: "host", local: true, services: [
      { id: "bookmark", name: "Bookmark", type: "bookmark", url: "https://link.test" },
      { id: "web", name: "Web", type: "web", url: "https://web.test" },
      { id: "docker", name: "Docker", type: "docker", container: "app" },
      { id: "legacy", name: "Legacy" },
    ] }],
  }, 1);
  h.state.remotes = [remote];
  const server = remote.servers[0];
  assert.equal(server.remote, "peer");
  assert.equal(server.services[0].type, "bookmark");
  assert.equal(server.services[1].type, "web");
  assert.equal(server.services[2].type, "docker");
  assert.equal(Object.hasOwn(server.services[3], "type"), false);
  assert.equal(h.serviceStatus(server.services[0], server).level, "neutral");
  assert.equal(h.serviceStatus(server.services[2], server).level, "up");
});

test("URL helpers preserve legacy LAN/public selection but canonical first wins everywhere", () => {
  for (const hostname of ["localhost", "192.168.1.2", "dashboard.example.com"]) {
    const helpers = browserModule("js/utils.js", ["serviceUrls", "monitoringUrl", "primaryUrl"], { URL, location: { hostname } });
    const svc = { url: "http://local.test:8080", altUrl: "https://public.test" };
    assert.equal(helpers.primaryUrl(svc), hostname === "dashboard.example.com" ? "https://public.test/" : "http://local.test:8080/");
    assert.equal(helpers.monitoringUrl(svc), svc.url);
    assert.deepEqual(Array.from(helpers.serviceUrls(svc), (entry) => entry.label), ["Local", "Public"]);
    svc.urls = [{ label: "VPN", url: "http://vpn.test:8000" }, { label: "Admin", url: "https://admin.test" }, { label: "Third", url: "https://third.test" }];
    assert.equal(helpers.primaryUrl(svc), "http://vpn.test:8000/");
    assert.equal(helpers.monitoringUrl(svc), "http://vpn.test:8000");
    assert.equal(helpers.serviceUrls(svc).length, 3);
    for (const urls of [[], null, {}, [{ label: "Bad", url: "javascript:bad" }, ...svc.urls]]) {
      assert.equal(helpers.primaryUrl({ ...svc, urls }), "");
      assert.equal(helpers.monitoringUrl({ ...svc, urls }), "");
    }
    const unsafe = { urls: [null, { label: "Unsafe", url: "data:text/html,hi" }, { label: "Good", url: "https://good.test" }] };
    assert.deepEqual(Array.from(helpers.serviceUrls(unsafe), (entry) => entry.url), ["https://good.test/"]);
    assert.equal(helpers.primaryUrl({ urls: [{ label: "Local", url: "http://localhost:8080" }] }), `http://${hostname}:8080/`);
    assert.equal(helpers.monitoringUrl({ urls: [{ label: "Local", url: "http://localhost:8080" }] }), "http://localhost:8080");
  }
});

test("legacy Docker port matching and duplicate hosts use only the primary monitored URL", () => {
  const h = serviceTypeHarness();
  const svc = { id: "svc", name: "Unmatched", url: "http://stale.test:9000",
    urls: [{ label: "Primary", url: "http://app.test:8080" }, { label: "Other", url: "http://other.test:9000" }] };
  const server = { local: true, services: [svc, { id: "other", urls: [{ label: "Other", url: "http://app.test:8080/path" }] }] };
  assert.equal(h.containerFor(svc, server).name, "app");
  assert.equal(h.duplicateHosts(server).has("app.test:8080"), true);
  svc.urls.reverse();
  assert.equal(h.containerFor(svc, server), null);
  assert.equal(h.duplicateHosts(server).size, 0);
  h.state.health.svc = { state: "up", code: 200, ms: 1 };
  for (const type of [undefined, "docker", "web"])
    assert.notEqual(h.serviceStatus({ ...svc, ...(type ? { type } : {}), urls: [], container: "missing" }, server)?.level, "up");
});

function serviceEditorHarness() {
  const input = (attrs = {}) => {
    const el = new Element();
    el.value = "";
    Object.assign(el, attrs);
    el.setCustomValidity = (message) => { el.validationMessage = message; };
    el.focus = () => { el.focused = true; };
    return el;
  };
  const fields = Object.fromEntries(["type", "name", "icon", "description", "notes", "container", "group", "favorite", "serverId"].map((key) => [key, input()]));
  const nodes = new Map();
  const $ = (selector) => {
    if (!nodes.has(selector)) nodes.set(selector, new Element());
    return nodes.get(selector);
  };
  const form = $("#serviceForm");
  form.reset = () => { for (const el of Object.values(fields)) { el.value = ""; el.checked = false; } };
  $("#serviceDialog").showModal = () => {};
  $("#serviceDialog").close = () => {};
  const saved = [];
  const server = { id: "host", name: "Host", groups: ["Apps"], services: [] };
  const utils = browserModule("js/utils.js", ["safeUrl"], { URL, location: { hostname: "localhost" } });
  const editor = browserModule("js/dialogs/service.js", ["initServiceForm", "openServiceEditor"], {
    ...utils,
    $, field: (form, name) => fields[name], value: (form, name) => fields[name].value.trim(),
    h: (tag, attrs, ...children) => {
      const node = input({ tag, ...attrs, children });
      for (const [key, handler] of Object.entries(attrs))
        if (key.startsWith("on")) node.addEventListener(key.slice(2), handler);
      return node;
    },
    fill: (node, children) => { node.options = children; },
    state: { config: { servers: [server] }, docker: { containers: [{ name: "app", image: "app" }] } },
    findServer: () => server, isFavorite: () => true,
    pendingForm: async (form, fn) => fn(), iconPicker: () => ({ reset() {} }),
    actions: { saveService: async (data) => { saved.push(data); return true; } },
  });
  const rows = () => Array.from($("#serviceUrls").options, (node) => ({
    label: node.children[0].children[1], url: node.children[1].children[1],
    primary: node.children[2].children[0], remove: node.children[2].children[1],
  }));
  form.reportValidity = () => [...Object.values(fields), ...rows().flatMap((row) => [row.label, row.url])]
    .every((el) => el.disabled || (!el.validationMessage && (!el.required || el.value.trim())));
  editor.initServiceForm();
  const submit = () => [...form.listeners.get("submit")][0]({ preventDefault() {} });
  return { ...editor, fields, server, saved, submit, $, rows };
}

test("service editor saves and reopens 3+ labeled URLs with add/remove/primary and type transitions", async () => {
  const h = serviceEditorHarness();
  h.server.services = [{ id: "svc", name: "Legacy", url: "http://local.test", altUrl: "https://public.test" }];
  h.openServiceEditor("host", "svc");
  assert.deepEqual(h.rows().map((row) => row.label.value), ["Local", "Public"]);
  assert.equal(Object.hasOwn(h.server.services[0], "urls"), false);
  for (const [label, url] of [["<Admin & panel>", "https://admin.test"], ["VPN", "http://vpn.test"]]) {
    h.$("#serviceAddUrl").emit("click");
    const row = h.rows().at(-1);
    assert.equal(row.label.focused, true);
    row.label.value = label;
    row.url.value = url;
    row.url.emit("input");
  }
  h.rows()[2].primary.emit("click");
  assert.equal(h.rows()[0].label.value, "<Admin & panel>");
  assert.equal(h.rows()[0].primary.disabled, true);
  h.rows()[1].remove.emit("click");
  assert.equal(h.rows().length, 3);
  h.$("#serviceAddUrl").emit("click"); // blank trailing row is not persisted
  await h.submit();
  const fields = h.saved.at(-1).fields;
  assert.equal(fields.urls.length, 3);
  assert.equal(fields.url, "https://admin.test");
  assert.equal(fields.altUrl, "https://public.test");
  assert.deepEqual(Array.from(fields.urls, (row) => row.label), ["<Admin & panel>", "Public", "VPN"]);
  h.server.services[0] = { id: "svc", ...fields, url: "https://stale.test" };
  h.openServiceEditor("host", "svc");
  assert.deepEqual(h.rows().map((row) => row.url.value), ["https://admin.test", "https://public.test", "http://vpn.test"]);
  for (const type of ["bookmark", "web", "docker"]) {
    h.fields.type.value = type;
    h.fields.container.value = "app";
    h.fields.type.emit("change");
    await h.submit();
    assert.equal(h.saved.at(-1).fields.urls.length, 3);
    assert.equal(h.saved.at(-1).fields.container, type === "docker" ? "app" : "");
  }
  h.rows()[0].remove.emit("click");
  await h.submit();
  assert.equal(h.saved.at(-1).fields.url, "https://public.test");
  h.rows()[1].remove.emit("click");
  await h.submit();
  assert.equal(h.saved.at(-1).fields.altUrl, "");
  h.rows()[0].remove.emit("click");
  await h.submit();
  assert.equal(h.saved.at(-1).fields.urls.length, 0);
  assert.equal(h.saved.at(-1).fields.url, "");
  for (const type of ["web", "bookmark"]) {
    h.fields.type.value = type;
    h.fields.type.emit("change");
    const before = h.saved.length;
    await h.submit();
    assert.equal(h.saved.length, before);
  }
});

test("editor rejects partial/unsafe/oversized entries, limits rows, and preserves raw invalid URLs for correction", async () => {
  const h = serviceEditorHarness();
  h.openServiceEditor("host", null, { type: "docker", container: "app" });
  for (const [label, url] of [["Only label", ""], ["", "https://app.test"], ["Bad", "ftp://app.test"],
    ["Bad", "https://"], ["x".repeat(61), "https://app.test"], ["Long", `https://app.test/${"x".repeat(2000)}`]]) {
    const row = h.rows()[0];
    row.label.value = label;
    row.url.value = url;
    row.url.emit("input");
    await h.submit();
    assert.equal(h.saved.length, 0);
  }
  h.server.services = [{ id: "svc", name: "Raw", type: "web", urls: [{ label: "Fix", url: "javascript:bad" }] }];
  h.openServiceEditor("host", "svc");
  assert.equal(h.rows()[0].url.value, "javascript:bad");
  assert.match(h.rows()[0].url.validationMessage, /HTTP/);
  while (h.rows().length < 50) h.$("#serviceAddUrl").emit("click");
  assert.equal(h.$("#serviceAddUrl").disabled, true);
  h.$("#serviceAddUrl").emit("click");
  assert.equal(h.rows().length, 50);
  h.rows()[49].remove.emit("click");
  assert.equal(h.$("#serviceAddUrl").disabled, false);
});

test("service editor defaults, legacy ordinary edits, discovery and type transitions preserve metadata", async () => {
  const h = serviceEditorHarness();
  h.openServiceEditor("host");
  assert.equal(h.fields.type.value, "web");
  assert.equal(h.fields.type.options.some((o) => o.value === ""), false);
  assert.equal(h.rows()[0].url.required, true);
  assert.equal(h.fields.container.disabled, true);
  h.rows()[0].url.value = "https://example.test";
  h.rows()[0].url.emit("input");
  assert.equal(h.rows()[0].url.required, false);
  h.rows()[0].url.value = "ftp://example.test";
  h.rows()[0].url.emit("input");
  assert.match(h.rows()[0].url.validationMessage, /HTTP/);
  h.openServiceEditor("host", null, { type: "docker", name: "app", container: "app" });
  assert.equal(h.fields.type.value, "docker");
  assert.equal(h.fields.container.required, true);
  assert.equal(h.rows()[0].url.required, false);
  await h.submit();
  assert.equal(h.saved.at(-1).fields.container, "app");
  assert.equal(h.saved.at(-1).fields.type, "docker");
  h.server.services = [{ id: "svc", name: "Legacy", container: "app", group: "Apps", notes: "keep", icon: "🌐", url: "http://app.test", description: "description" }];
  h.openServiceEditor("host", "svc");
  assert.equal(h.fields.type.value, "");
  assert.equal(h.fields.container.required, false);
  await h.submit();
  assert.equal(Object.hasOwn(h.saved.at(-1).fields, "type"), false);
  assert.equal(h.saved.at(-1).fields.container, "app");
  h.fields.type.value = "bookmark";
  h.fields.type.emit("change");
  await h.submit();
  const converted = h.saved.at(-1);
  assert.equal(converted.fields.type, "bookmark");
  assert.equal(converted.fields.container, "");
  assert.equal(converted.fields.group, "Apps");
  assert.equal(converted.fields.notes, "keep");
  assert.equal(converted.fields.icon, "🌐");
  assert.equal(converted.pinned, true);
  h.server.services[0] = { id: "svc", ...converted.fields };
  h.openServiceEditor("host", "svc");
  assert.equal(h.fields.type.options.some((o) => o.value === ""), false);
  h.fields.type.value = "docker";
  h.fields.type.emit("change");
  assert.match(h.fields.container.validationMessage, /explicit/);
  h.fields.container.value = "app";
  h.fields.container.emit("input");
  assert.equal(h.fields.container.validationMessage, "");
  h.server.services[0].type = "future";
  h.openServiceEditor("host", "svc");
  assert.equal(h.fields.type.value, "unsupported");
  assert.match(h.fields.type.validationMessage, /supported/);
  assert.equal(h.fields.type.options.some((o) => o.value === ""), false);
});

for (const name of ["SecurityError", "QuotaExceededError"]) {
  test(`preferences remain usable when storage throws ${name}`, () => {
    const error = Object.assign(new Error(name), { name });
    const { setPref, prefs } = browserModule(
      "js/state.js",
      ["setPref", "prefs"],
      {
        localStorage: {
          getItem: () => null,
          setItem: () => {
            throw error;
          },
        },
      },
    );
    for (const [key, value] of [
      ["accent", "#123456"],
      ["theme", "light"],
      ["layout", "list"],
      ["tab", "server"],
      ["clipSeen", 42],
    ]) {
      assert.doesNotThrow(() => setPref(key, value));
      assert.equal(prefs[key], value);
    }
  });
}

test("preferences still persist values and collapsed sets", () => {
  const saved = new Map();
  const { setPref, prefs } = browserModule(
    "js/state.js",
    ["setPref", "prefs"],
    {
      localStorage: {
        getItem: () => null,
        setItem: (key, value) => saved.set(key, value),
      },
    },
  );
  prefs.collapsed.add("server::group");
  setPref("collapsed", prefs.collapsed);
  setPref("theme", "dark");
  assert.equal(saved.get("dash.collapsed"), '["server::group"]');
  assert.equal(saved.get("dash.theme"), '"dark"');
});

function worker(overrides = {}) {
  const handlers = {};
  const values = vm.runInNewContext(
    `${source("sw.js")}\n;({ CACHE, SHELL });`,
    {
      URL,
      Response,
      location: { origin: "https://dashboard.test" },
      self: {
        addEventListener: (type, fn) => {
          handlers[type] = fn;
        },
        skipWaiting: () => {},
        clients: { claim: () => {} },
        ...overrides.self,
      },
      caches: overrides.caches,
      fetch: overrides.fetch,
    },
    { filename: "sw.js" },
  );
  function dispatch(type, request) {
    const waits = [];
    let response;
    handlers[type]({
      request,
      waitUntil: (promise) => waits.push(promise),
      respondWith: (promise) => {
        response = promise;
      },
    });
    return { response, done: Promise.all(waits), waits };
  }
  return { ...values, dispatch };
}

test("worker precaches the complete local module graph and shell before activation", async () => {
  let assets;
  let skipped = false;
  const adding = deferred();
  const sw = worker({
    caches: {
      open: async () => ({
        addAll: (urls) => {
          assets = [...urls];
          return adding.promise;
        },
      }),
    },
    self: {
      skipWaiting: () => {
        skipped = true;
      },
    },
  });
  const event = sw.dispatch("install");
  await flush();
  assert.equal(skipped, false);
  assert.equal(new Set(assets).size, assets.length);
  for (const url of assets) {
    assert.ok(!url.startsWith("/api/"));
    if (url !== "/manifest.webmanifest") {
      assert.ok(
        fs.existsSync(
          path.join(publicDir, url === "/" ? "index.html" : url.slice(1)),
        ),
        url,
      );
    }
  }
  for (const url of [
    "/",
    "/app.css",
    "/favicon.svg",
    "/manifest.webmanifest",
    "/icons/icon-192.png",
  ]) {
    assert.ok(assets.includes(url), url);
  }
  const visited = new Set();
  function checkModule(url) {
    if (visited.has(url)) return;
    visited.add(url);
    assert.ok(assets.includes(url), `Missing shell module: ${url}`);
    for (const match of source(url.slice(1)).matchAll(
      /\bfrom\s+['"]([^'"]+)['"]/g,
    )) {
      checkModule(path.posix.resolve(path.posix.dirname(url), match[1]));
    }
  }
  checkModule("/js/main.js");
  for (const url of require("./helpers/styles.cjs").styleUrls()) {
    assert.ok(assets.includes(url), `Missing shell stylesheet: ${url}`);
  }
  adding.resolve();
  await event.done;
  assert.equal(skipped, true);
});

test("failed shell precaching rejects installation without replacing the active worker", async () => {
  let skipped = false;
  const sw = worker({
    caches: {
      open: async () => ({
        addAll: async () => {
          throw new Error("missing shell");
        },
      }),
    },
    self: {
      skipWaiting: () => {
        skipped = true;
      },
    },
  });
  await assert.rejects(sw.dispatch("install").done, /missing shell/);
  assert.equal(skipped, false);
});

test("worker activation deletes only obsolete dashboard caches", async () => {
  const deleted = [];
  let claimed = false;
  const sw = worker({
    caches: {
      keys: async () => [
        sw.CACHE,
        "dashboard-v1",
        "showy-dashboard-v1",
        "other-app-v1",
      ],
      delete: async (key) => {
        deleted.push(key);
      },
    },
    self: {
      clients: {
        claim: () => {
          claimed = true;
        },
      },
    },
  });
  await sw.dispatch("activate").done;
  assert.deepEqual(deleted.sort(), ["dashboard-v1", "showy-dashboard-v1"]);
  assert.equal(claimed, true);
});

const request = (pathname, extra = {}) => ({
  url: `https://dashboard.test${pathname}`,
  method: "GET",
  mode: "cors",
  ...extra,
});

test("worker extends cache-write lifetime without delaying the network response", async () => {
  const writing = deferred();
  let copy;
  const response = new Response("shell");
  const sw = worker({
    fetch: async () => response,
    caches: {
      open: async () => ({
        put: (req, value) => {
          copy = value;
          return writing.promise;
        },
      }),
    },
  });
  const event = sw.dispatch("fetch", request("/app.css"));
  assert.equal(event.waits.length, 1);
  assert.equal(await event.response, response);
  let finished = false;
  event.done.then(() => {
    finished = true;
  });
  await flush();
  assert.equal(finished, false);
  assert.equal(await copy.text(), "shell");
  writing.resolve();
  await event.done;
  assert.equal(await response.text(), "shell");
});

for (const failure of ["open", "put"]) {
  test(`worker tolerates cache ${failure} failures with a successful network response`, async () => {
    const response = new Response("online");
    const sw = worker({
      fetch: async () => response,
      caches: {
        open: async () => {
          if (failure === "open") throw new Error("storage denied");
          return {
            put: async () => {
              throw new Error("quota");
            },
          };
        },
      },
    });
    const event = sw.dispatch("fetch", request("/app.css"));
    assert.equal(await event.response, response);
    await event.done;
  });
}

test("worker leaves API, cross-origin and non-GET requests alone", async () => {
  const sw = worker({
    fetch: () => {
      throw new Error("must not fetch");
    },
  });
  for (const req of [
    request("/api/config"),
    request("/app.css", { method: "POST" }),
    request("/", { url: "https://other.test/" }),
  ]) {
    const event = sw.dispatch("fetch", req);
    assert.equal(event.response, undefined);
    assert.equal(event.waits.length, 0);
    await event.done;
  }
});

test("worker offline fallback uses only its own cache and only navigations get HTML", async () => {
  const shell = new Response("offline shell");
  const css = new Response("offline CSS");
  const opened = [];
  const sw = worker({
    fetch: async () => {
      throw new Error("offline");
    },
    caches: {
      open: async (key) => {
        opened.push(key);
        return {
          match: async (req) =>
            req === "/"
              ? shell
              : req.url.endsWith("/app.css")
                ? css
                : undefined,
        };
      },
    },
  });
  for (const [req, expected] of [
    [request("/app.css"), css],
    [request("/elsewhere", { mode: "navigate" }), shell],
  ]) {
    const event = sw.dispatch("fetch", req);
    assert.equal(await event.response, expected);
    await event.done;
  }
  const missing = sw.dispatch("fetch", request("/missing.js"));
  assert.equal((await missing.response).type, "error");
  await missing.done;
  assert.ok(opened.every((key) => key === sw.CACHE));
});

test("worker handles offline cache denial and does not cache HTTP errors", async () => {
  const sw = worker({
    fetch: async () => {
      throw new Error("offline");
    },
    caches: {
      open: async () => {
        throw new Error("denied");
      },
    },
  });
  const offline = sw.dispatch("fetch", request("/"));
  assert.equal((await offline.response).type, "error");
  await offline.done;
  const unavailable = new Response("unavailable", { status: 503 });
  const online = worker({
    fetch: async () => unavailable,
    caches: {
      open: () => {
        assert.fail("HTTP errors must not be cached");
      },
    },
  }).dispatch("fetch", request("/"));
  assert.equal(await online.response, unavailable);
  await online.done;
});

function clipboardHarness({
  modal = false,
  open = false,
  command = () => true,
  clipboard,
} = {}) {
  const nodes = new Map();
  const $ = (selector) => {
    if (!nodes.has(selector)) nodes.set(selector, new Element());
    return nodes.get(selector);
  };
  $("#clipMenu").matches = () => open;
  const body = new Element();
  const dialog = modal ? new Element() : null;
  const messages = [];
  const focusCalls = [];
  const focused = { focus: (options) => focusCalls.push(options) };
  const document = {
    body,
    activeElement: focused,
    querySelector: () => dialog,
    execCommand: command,
  };
  let textarea;
  let copyParent;
  let renders = 0;
  const state = {
    clip: { entries: [{ id: "entry", text: "hello", createdAt: 1 }], max: 10 },
  };
  const module = browserModule("js/clip.js", ["copyText", "renderList"], {
    navigator: { clipboard },
    document,
    state,
    $,
    clearTimeout,
    toast: (...args) => messages.push(args),
    h: (tag) => {
      const node = new Element(tag);
      if (tag === "textarea") {
        textarea = node;
        node.select = () => {
          copyParent = node.parentElement;
          document.activeElement = node;
        };
      }
      return node;
    },
    fill: () => {
      renders++;
    },
    iconBtn: () => new Element(),
    fmtDateTime: () => "date",
  });
  return {
    ...module,
    $,
    state,
    body,
    dialog,
    messages,
    focusCalls,
    get textarea() {
      return textarea;
    },
    get copyParent() {
      return copyParent;
    },
    get renders() {
      return renders;
    },
  };
}

for (const location of ["body", "popover", "modal"]) {
  test(`clipboard fallback uses ${location} and restores focus`, async () => {
    const harness = clipboardHarness({
      modal: location === "modal",
      open: location !== "body",
    });
    await harness.copyText("copied text");
    assert.equal(
      harness.copyParent,
      location === "modal"
        ? harness.dialog
        : location === "popover"
          ? harness.$("#clipMenu")
          : harness.body,
    );
    assert.equal(harness.textarea.value, "copied text");
    assert.equal(harness.textarea.parentElement, null);
    assert.equal(harness.focusCalls.length, 1);
    assert.equal(harness.focusCalls[0].preventScroll, true);
    assert.deepEqual(harness.messages, [["Copied"]]);
  });
}

for (const throws of [false, true]) {
  test(`clipboard fallback cleans up when copying ${throws ? "throws" : "returns false"}`, async () => {
    const harness = clipboardHarness({
      command: () => {
        if (throws) throw new Error("denied");
        return false;
      },
    });
    await harness.copyText("text");
    assert.equal(harness.textarea.parentElement, null);
    assert.equal(harness.focusCalls.length, 1);
    assert.equal(harness.messages.length, 1);
    assert.equal(harness.messages[0][1], true);
  });
}

test("clipboard native success avoids the fallback and rejection uses it", async () => {
  let copied;
  const native = clipboardHarness({
    clipboard: {
      writeText: async (text) => {
        copied = text;
      },
    },
  });
  await native.copyText("native");
  assert.equal(copied, "native");
  assert.equal(native.textarea, undefined);
  assert.equal(native.focusCalls.length, 0);
  const denied = clipboardHarness({
    clipboard: {
      writeText: async () => {
        throw new Error("denied");
      },
    },
  });
  await denied.copyText("fallback");
  assert.equal(denied.copyParent, denied.body);
});

test("clipboard count and controls update without rebuilding unchanged history", () => {
  const harness = clipboardHarness();
  harness.$("#clipList").scrollTop = 75;
  harness.renderList();
  assert.equal(harness.$("#clipCount").textContent, "1 / 10");
  harness.state.clip.max = 25;
  harness.renderList();
  assert.equal(harness.$("#clipCount").textContent, "1 / 25");
  assert.equal(harness.renders, 1);
  assert.equal(harness.$("#clipList").scrollTop, 75);
  harness.state.clip.entries = [];
  harness.renderList();
  assert.equal(harness.$("#clipCount").textContent, "");
  assert.equal(harness.$("#clipClearAll").disabled, true);
  assert.equal(harness.$("#clipList").hidden, true);
});

test("only the initiating pointer can move or finish a drag", () => {
  const root = new Element();
  const body = new Element();
  const window = new Element();
  const items = ["a", "b"].map((id) => {
    const item = new Element("item");
    item.dataset.id = id;
    item.append(new Element("handle"));
    return item;
  });
  root.append(...items);
  const sorts = [];
  const canceled = [];
  const { makeSortable, isDragging } = browserModule(
    "js/sortable.js",
    ["makeSortable", "isDragging"],
    {
      window,
      document: { body, elementFromPoint: () => items[1] },
      requestAnimationFrame: () => 17,
      cancelAnimationFrame: (id) => canceled.push(id),
    },
  );
  makeSortable(root, {
    item: "item",
    handle: "handle",
    onSort: (value) => sorts.push(value),
  });
  const event = (pointerId) => ({
    pointerId,
    pointerType: "touch",
    target: items[0].children[0],
    clientX: 10,
    clientY: 20,
    preventDefault() {},
  });
  root.emit("pointerdown", event(1));
  assert.equal(isDragging(), true);
  root.emit("pointerdown", event(2));
  assert.equal(body.children.length, 1);
  window.emit("pointermove", event(2));
  assert.deepEqual(
    root.children.map((item) => item.dataset.id),
    ["a", "b"],
  );
  window.emit("pointerup", event(2));
  window.emit("pointercancel", event(2));
  assert.equal(isDragging(), true);
  window.emit("pointermove", event(1));
  assert.deepEqual(
    root.children.map((item) => item.dataset.id),
    ["b", "a"],
  );
  window.emit("pointerup", event(1));
  assert.equal(isDragging(), false);
  assert.equal(body.children.length, 0);
  assert.equal(sorts.length, 1);
  assert.deepEqual(canceled, [17]);
  for (const handlers of window.listeners.values())
    assert.equal(handlers.size, 0);
  root.emit("pointerdown", event(3));
  window.emit("pointercancel", event(3));
  assert.equal(isDragging(), false);
  assert.equal(body.children.length, 0);
  assert.equal(sorts.length, 1);
});

function pollingHarness() {
  const calls = [];
  const state = {
    health: {}, usage: {}, stats: null, remotes: [],
    tunables: { loadTimeout: 30 },
    localAt: 42,
  };
  let clock = 100;
  const module = browserModule(
    "js/api.js",
    [
      "loadHealth",
      "loadUsage",
      "loadStats",
      "loadDocker",
      "loadClip",
      "loadRemotes",
      "loadRemote",
    ],
    {
      state,
      AbortController,
      setTimeout,
      clearTimeout,
      Date: { now: () => ++clock },
      normalizeConfig: (config) => config,
      fetch: (url) => {
        const pending = deferred();
        calls.push({ url, ...pending });
        return pending.promise;
      },
    },
  );
  const respond = (index, data, ok = true) =>
    calls[index].resolve({ ok, json: async () => data });
  return { ...module, state, calls, respond };
}

function refreshHarness() {
  const document = new Element();
  const window = new Element();
  const button = {
    classList: { toggle() {} }, setAttribute() {}, removeAttribute() {},
  };
  const state = {
    config: { servers: [{ local: true }] }, locked: false,
    stats: { interval: 0 }, docker: { available: true }, localAt: 42,
    tunables: { localDashboardRefresh: 30, healthRefresh: 30 },
    remotesInterval: 30,
  };
  const jobs = [];
  const timers = [];
  const code = source("js/refresh.js")
    .replace(/^import\s[\s\S]*?;\r?$/gm, "")
    .replace(/\bexport /g, "");
  const module = vm.runInNewContext(`${code}\n;({ startTimers, refreshLocal });`, {
    state, document, window, performance: { now: () => 100 },
    Date: { now: () => 1000 }, $: () => button,
    setTimeout(fn, ms) { const timer = { fn, ms }; timers.push(timer); return timer; },
    clearTimeout() {}, setInterval() {}, clearInterval() {},
    loadStats() { const job = deferred(); jobs.push(job); return job.promise; },
    loadDocker: async () => true, loadHealth: async () => true,
    loadUsage: async () => true, loadRemotes: async () => true,
    refreshClip() {}, requestRender() {}, loaded() {}, tickAgo() {}, toast() {},
  });
  module.startTimers();
  return { ...module, document, window, state, jobs, timers };
}

test("availability changes refresh disabled stats and serialize a post-save cycle", async () => {
  const h = refreshHarness();
  const first = h.refreshLocal(true);
  h.document.emit("availability-changed");
  h.document.emit("availability-changed");
  assert.equal(h.jobs.length, 1);
  assert.equal(h.state.localAt, 42);
  h.jobs[0].resolve(true);
  await first;
  await flush();
  assert.equal(h.jobs.length, 2); // Both notifications share the post-save cycle.
  const afterSave = h.refreshLocal();
  h.jobs[1].resolve(true);
  await afterSave;
  await flush();
  assert.equal(h.jobs.length, 2);
  assert.equal(h.state.localAt, 1000);
});

test("failed availability refresh does not advance dashboard freshness", async () => {
  const h = refreshHarness();
  h.document.emit("availability-changed");
  const cycle = h.refreshLocal();
  h.jobs[0].resolve(false);
  await cycle;
  assert.equal(h.state.localAt, 42);
  assert.match(h.state.localError, /could not be refreshed/);
});

test("hidden availability changes retain fresh work and catch up on visibility", async () => {
  const h = refreshHarness();
  h.document.hidden = true;
  h.document.emit("availability-changed");
  assert.equal(h.jobs.length, 0);
  assert.equal(h.state.localAt, 42);
  h.document.hidden = false;
  h.document.emit("visibilitychange");
  const timer = h.timers.findLast((entry) => entry.fn === h.refreshLocal);
  assert.equal(timer.ms, 0);
  const cycle = timer.fn();
  assert.equal(h.jobs.length, 1);
  h.jobs[0].resolve(true);
  await cycle;
  assert.equal(h.state.localAt, 1000);
});

test("availability refresh respects lock and page lifecycle without duplicate listeners", async () => {
  const h = refreshHarness();
  h.startTimers();
  assert.equal(h.document.listeners.get("availability-changed").size, 1);
  h.state.locked = true;
  h.document.emit("availability-changed");
  assert.equal(h.jobs.length, 0);
  h.state.locked = false;
  h.window.emit("pagehide");
  h.document.emit("availability-changed");
  assert.equal(h.jobs.length, 0);
  h.window.emit("pageshow");
  const timer = h.timers.findLast((entry) => entry.fn === h.refreshLocal);
  assert.equal(timer.ms, 0);
  const cycle = timer.fn();
  h.jobs[0].resolve(true);
  await cycle;
  assert.equal(h.jobs.length, 1);
});

test("collection budgets preserve configured local waits and remote response headroom", () => {
  const state = { tunables: { loadTimeout: 75, remoteTimeout: 60 } };
  const { collectionTimeout } = browserModule("js/api.js", ["collectionTimeout"], { state });
  assert.equal(collectionTimeout(), 75000);
  assert.equal(collectionTimeout({ fresh: true }), 125000);
  state.tunables = { loadTimeout: 5, remoteTimeout: 60 };
  assert.equal(collectionTimeout(), 65000);
  state.tunables = { loadTimeout: 360, remoteTimeout: 300 };
  assert.equal(collectionTimeout(), 360000);
  assert.equal(collectionTimeout({ fresh: true }), 605000);
  state.tunables = { loadTimeout: 15, remoteTimeout: 8 };
  assert.equal(collectionTimeout(), 15000); // Existing explicitly short settings remain supported.
  state.tunables = {};
  assert.equal(collectionTimeout(), 75000);
  assert.match(source("js/loading.js"), /const TIMEOUT_MS = collectionTimeout;/);
  assert.match(source("js/loading.js"), /TIMEOUT_MS\(\{ fresh \}\)/);
});

test("browser timeout uses queued-remote budget, aborts only its request, and releases poll slot", async () => {
  const state = { config: {}, locked: false, remotes: [], tunables: { loadTimeout: 75, remoteTimeout: 60 } };
  const timers = [];
  const calls = [];
  const { loadRemotes } = browserModule("js/api.js", ["loadRemotes"], {
    state, AbortController, Date,
    setTimeout(fn, ms) { const timer = { fn, ms, cleared: false }; timers.push(timer); return timer; },
    clearTimeout(timer) { timer.cleared = true; },
    fetch(url, options) {
      const job = deferred();
      options.signal.addEventListener("abort", () => job.reject(new Error("aborted")), { once: true });
      calls.push({ url, ...job });
      return job.promise;
    },
  });
  const first = loadRemotes("peer");
  assert.equal(timers[0].ms, 125000);
  timers[0].fn();
  assert.equal(await first, false);
  assert.equal(timers[0].cleared, true);
  const retry = loadRemotes();
  assert.equal(calls.length, 2);
  assert.equal(timers[1].ms, 75000);
  calls[1].resolve({ ok: true, json: async () => ({ remotes: [], interval: 30 }) });
  assert.equal(await retry, true);
  assert.equal(timers[1].cleared, true);
  assert.equal(state.remotesInterval, 30);
});

for (const [method, endpoint, payload] of [
  ["loadHealth", "/api/health", { results: { service: "fresh" } }],
  [
    "loadUsage",
    "/api/docker/stats",
    { interval: 5, stats: { container: "fresh" } },
  ],
]) {
  test(`${method} coalesces polls and queues manual fresh work without overlapping`, async () => {
    const harness = pollingHarness();
    const normal = harness[method]();
    const duplicate = harness[method]();
    const fresh = harness[method](true);
    const anotherFresh = harness[method](true);
    assert.equal(harness.calls.length, 1);
    assert.equal(harness.calls[0].url, endpoint);
    harness.respond(0, payload);
    await Promise.all([normal, duplicate]);
    await flush();
    assert.equal(harness.calls.length, 2);
    assert.equal(harness.calls[1].url, `${endpoint}?fresh=1`);
    const background = harness[method]();
    assert.equal(harness.calls.length, 2);
    harness.respond(1, payload);
    await Promise.all([fresh, anotherFresh, background]);
    assert.equal(harness.calls.length, 2);
    // Only a complete dashboard refresh may advance its freshness timestamp.
    assert.equal(harness.state.localAt, 42);
  });
}

test("poll sources run independently and failed requests release their slots", async () => {
  const harness = pollingHarness();
  const health = harness.loadHealth();
  const stats = harness.loadStats();
  const duplicateStats = harness.loadStats();
  const fresh = harness.loadHealth(true);
  assert.equal(harness.calls.length, 2);
  harness.calls[0].reject(new Error("offline"));
  assert.equal(await health, false);
  await flush();
  assert.equal(harness.calls.length, 3);
  harness.respond(1, { cpu: 7 });
  harness.respond(2, { results: { service: "up" } });
  await Promise.all([stats, duplicateStats, fresh]);
  assert.equal(harness.state.stats.cpu, 7);
  assert.equal(harness.state.health.service, "up");
  const next = harness.loadStats();
  assert.equal(harness.calls.length, 4);
  harness.respond(3, { cpu: 8 });
  await next;
  assert.equal(harness.state.stats.cpu, 8);
});

test("queued fresh remotes use their actual fetch start when choosing newer data", async () => {
  const harness = pollingHarness();
  const normal = harness.loadRemotes();
  const fresh = harness.loadRemotes("remote");
  const remote = (name) => ({
    id: "remote",
    name,
    ok: true,
    age: 0,
    servers: [{ id: "server" }],
  });
  harness.respond(0, { remotes: [remote("old")] });
  await normal;
  await flush();
  assert.equal(harness.calls.length, 2);
  assert.equal(harness.calls[1].url, "/api/remotes?fresh=remote");
  assert.equal(harness.state.remotes[0].name, "old");
  harness.respond(1, { remotes: [remote("fresh")] });
  await fresh;
  assert.equal(harness.state.remotes[0].name, "fresh");
});

test("a slow bulk remote poll still preserves newer individually loaded data", async () => {
  const harness = pollingHarness();
  const bulk = harness.loadRemotes();
  const individual = harness.loadRemote("remote", { fresh: true });
  const remote = (name) => ({
    id: "remote",
    name,
    ok: true,
    age: 0,
    servers: [{ id: "server" }],
  });
  harness.respond(1, { remotes: [remote("newer individual")] });
  await individual;
  harness.respond(0, { remotes: [remote("older bulk")] });
  await bulk;
  assert.equal(harness.state.remotes[0].name, "newer individual");
});

function editingHarness() {
  const state = {
    config: { settings: { title: "base", links: [], favorites: [], hiddenContainers: [] }, servers: [] },
    configRevision: "r0", configEpoch: 0, configSaving: 0,
  };
  const requests = [];
  const messages = [];
  const actions = browserModule("js/actions.js", ["saveSettings", "saveLink", "saveServer", "toggleFavorite"], {
    state, prefs: {}, clone: structuredClone, normalizeConfig: (c) => c,
    uid: () => `id${requests.length}`, setPref() {}, render() {},
    toast: (...args) => messages.push(args),
    document: { dispatchEvent() {} }, CustomEvent: class {},
    editApi: (method, url, body) => {
      const pending = deferred();
      requests.push({ method, url, body, ...pending });
      return pending.promise;
    },
  });
  const success = (i, revision) => {
    const { _revision, ...config } = requests[i].body;
    requests[i].resolve({ res: { ok: true }, data: { config, revision } });
  };
  return { ...actions, state, requests, messages, success };
}

test("queued config edits use latest committed state and revision without overlapping", async () => {
  const h = editingHarness();
  const first = h.saveSettings({ title: "new title" });
  const second = h.saveLink(null, { name: "link" });
  await flush();
  assert.equal(h.requests.length, 1);
  assert.equal(h.state.config.settings.title, "base"); // No uncommitted snapshot.
  h.success(0, "r1");
  assert.equal(await first, true);
  await flush();
  assert.equal(h.requests[1].body.settings.title, "new title");
  assert.equal(h.requests[1].body._revision, "r1");
  h.success(1, "r2");
  assert.equal(await second, true);
  assert.equal(h.state.config.settings.links.length, 1);
  assert.equal(h.state.config.settings.title, "new title");
  assert.equal(h.state.configSaving, 0);
});

test("failed edit never rolls back a queued unrelated edit and can be retried", async () => {
  const h = editingHarness();
  const first = h.saveSettings({ title: "failed" });
  const second = h.saveLink(null, { name: "survives" });
  await flush();
  h.requests[0].reject(new Error("network failed"));
  assert.equal(await first, false);
  await flush();
  assert.equal(h.requests[1].body.settings.title, "base");
  h.success(1, "r1");
  assert.equal(await second, true);
  const retry = h.saveSettings({ title: "retry" });
  await flush();
  assert.equal(h.requests[2].body.settings.links[0].name, "survives");
  h.success(2, "r2");
  assert.equal(await retry, true);
});

test("conflict refreshes committed state without replaying rejected edit", async () => {
  const h = editingHarness();
  const first = h.saveSettings({ title: "stale title" });
  const second = h.saveLink(null, { name: "queued link" });
  await flush();
  h.requests[0].resolve({ res: { ok: false, status: 409 }, data: { error: "Conflict" } });
  await flush();
  assert.equal(h.requests[1].method, "GET");
  const latest = structuredClone(h.state.config);
  latest.settings.title = "other client";
  h.requests[1].resolve({ res: { ok: true }, data: { config: latest, revision: "remote" } });
  assert.equal(await first, false);
  await flush();
  assert.equal(h.requests[2].body.settings.title, "other client");
  assert.equal(h.requests[2].body._revision, "remote");
  h.success(2, "r2");
  assert.equal(await second, true);
});

test("updated client refuses unsafe writes to a server without revisions", async () => {
  const h = editingHarness();
  h.state.configRevision = null;
  assert.equal(await h.saveSettings({ title: "unsafe" }), false);
  assert.equal(h.requests.length, 0);
  assert.equal(h.state.config.settings.title, "base");
});

test("favorite toggles are evaluated when their queued operation starts", async () => {
  const h = editingHarness();
  const first = h.toggleFavorite("svc");
  const second = h.toggleFavorite("svc");
  await flush();
  h.success(0, "r1");
  await first;
  await flush();
  assert.equal(h.requests[1].body.settings.favorites.length, 0);
  h.success(1, "r2");
  await second;
});

test("config loads started before or during edits cannot replace committed results", async () => {
  const calls = [];
  const state = { config: { title: "base" }, configRevision: "r0", configEpoch: 0, configSaving: 0 };
  const { loadConfig } = browserModule("js/api.js", ["loadConfig"], {
    state, normalizeConfig: (c) => c, toast() {},
    fetch: () => { const d = deferred(); calls.push(d); return d.promise; },
  });
  const old = loadConfig();
  state.configEpoch++;
  state.config = { title: "saved" };
  state.configRevision = "r1";
  calls[0].resolve({ ok: true, json: async () => ({ config: { title: "old" }, revision: "r0" }) });
  await old;
  assert.equal(state.config.title, "saved");
  state.configSaving = 1;
  const during = loadConfig();
  state.configSaving = 0;
  calls[1].resolve({ ok: true, json: async () => ({ config: { title: "old" }, revision: "r0" }) });
  await during;
  assert.equal(state.configRevision, "r1");
  const fresh = loadConfig();
  calls[2].resolve({ ok: true, json: async () => ({ config: { title: "fresh" }, revision: "r2" }) });
  await fresh;
  assert.equal(state.config.title, "fresh");
  assert.equal(state.configRevision, "r2");
});

test("pending form guards duplicate saves/deletes and restores controls after failure", async () => {
  const { pendingForm } = browserModule("js/dialogs/common.js", ["pendingForm"]);
  const buttons = [{ disabled: false }, { disabled: true }];
  const form = { dataset: {}, querySelectorAll: () => buttons };
  const pending = deferred();
  let calls = 0;
  const first = pendingForm(form, () => { calls++; return pending.promise; });
  assert.equal(buttons[0].disabled, true);
  await pendingForm(form, () => calls++);
  assert.equal(calls, 1);
  pending.reject(new Error("failed"));
  await assert.rejects(first, /failed/);
  assert.equal(buttons[0].disabled, false);
  assert.equal(buttons[1].disabled, true);
  assert.equal(form.dataset.saving, undefined);
  await pendingForm(form, () => calls++);
  assert.equal(calls, 2);
  for (const name of ["service", "server", "link"]) {
    const code = source(`js/dialogs/${name}.js`);
    assert.equal((code.match(/await pendingForm\(form/g) || []).length, 2);
    assert.match(code, /if \(form.dataset.saving\) return;/);
  }
});

for (const name of ["service", "server", "link"]) {
  test(`${name} form blocks repeated submits and competing deletes, then allows retry`, async () => {
    const { pendingForm } = browserModule("js/dialogs/common.js", ["pendingForm"]);
    const form = new Element();
    const button = { disabled: false };
    const controls = new Map();
    const field = (_form, key) => {
      if (!controls.has(key)) controls.set(key, Object.assign(new Element(), { value: "value", checked: false, setCustomValidity() {} }));
      return controls.get(key);
    };
    form.querySelectorAll = () => [button];
    form.reportValidity = () => true;
    const remove = new Element();
    const dialog = Object.assign(new Element(), { closes: 0, close() { this.closes++; } });
    const request = deferred();
    let saves = 0;
    let deletes = 0;
    const capital = name[0].toUpperCase() + name.slice(1);
    const actions = {
      [`save${capital}`]: () => { saves++; return saves === 1 ? request.promise : Promise.resolve(true); },
      [`delete${capital}`]: async () => { deletes++; return true; },
    };
    const init = `init${capital}Form`;
    const module = browserModule(`js/dialogs/${name}.js`, [init], {
      pendingForm, actions, field, value: (form, key) => field(form, key).value,
      iconPicker: () => ({ reset() {} }),
      $: (selector) => selector === `#${name}Form` ? form
        : selector === `#${name}Delete` ? remove : dialog,
    });
    module[init]();
    const submit = [...form.listeners.get("submit")][0];
    const deleteClick = [...remove.listeners.get("click")][0];
    const first = submit({ preventDefault() {} });
    await submit({ preventDefault() {} });
    await deleteClick();
    assert.equal(saves, 1);
    assert.equal(deletes, 0);
    assert.equal(button.disabled, true);
    request.resolve(false);
    await first;
    assert.equal(dialog.closes, 0);
    assert.equal(button.disabled, false);
    await submit({ preventDefault() {} });
    assert.equal(saves, 2);
    assert.equal(dialog.closes, 1);
    await deleteClick();
    assert.equal(deletes, 1);
  });
}
