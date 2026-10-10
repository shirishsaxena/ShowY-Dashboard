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
    .replace(/^import .*;\r?$/gm, "")
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
      if (!controls.has(key)) controls.set(key, Object.assign(new Element(), { value: "value", checked: false }));
      return controls.get(key);
    };
    form.querySelectorAll = () => [button];
    const remove = new Element();
    const dialog = { closes: 0, close() { this.closes++; } };
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
