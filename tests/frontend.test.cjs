const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const publicDir = path.resolve(__dirname, '../public');
const source = (file) => fs.readFileSync(path.join(publicDir, file), 'utf8');
const flush = () => new Promise(setImmediate);

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

// Evaluate browser modules with explicit dependency stubs, without dependencies or VM flags.
function browserModule(file, names, globals = {}) {
  const code = source(file)
    .replace(/^import .*;\r?$/gm, '')
    .replace(/\bexport (?=(?:async )?(?:function|class|const|let)\b)/g, '');
  return vm.runInNewContext(`${code}\n;({ ${names.join(', ')} });`, globals, { filename: file });
}

class Element {
  constructor(kind = '') {
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
  removeEventListener(type, fn) { this.listeners.get(type)?.delete(fn); }
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
  matches(selector) { return this.kind === selector; }
  closest(selector) { return this.matches(selector) ? this : this.parentElement?.closest(selector); }
  contains(node) { return node === this || this.children.some((child) => child.contains(node)); }
  cloneNode() { return new Element(this.kind); }
  getBoundingClientRect() { return { left: 0, top: 0, width: 100, height: 50 }; }
}

for (const name of ['SecurityError', 'QuotaExceededError']) {
  test(`preferences remain usable when storage throws ${name}`, () => {
    const error = Object.assign(new Error(name), { name });
    const { setPref, prefs } = browserModule('js/state.js', ['setPref', 'prefs'], {
      localStorage: { getItem: () => null, setItem: () => { throw error; } },
    });
    for (const [key, value] of [['accent', '#123456'], ['theme', 'light'], ['layout', 'list'], ['tab', 'server'], ['clipSeen', 42]]) {
      assert.doesNotThrow(() => setPref(key, value));
      assert.equal(prefs[key], value);
    }
  });
}

test('preferences still persist values and collapsed sets', () => {
  const saved = new Map();
  const { setPref, prefs } = browserModule('js/state.js', ['setPref', 'prefs'], {
    localStorage: { getItem: () => null, setItem: (key, value) => saved.set(key, value) },
  });
  prefs.collapsed.add('server::group');
  setPref('collapsed', prefs.collapsed);
  setPref('theme', 'dark');
  assert.equal(saved.get('dash.collapsed'), '["server::group"]');
  assert.equal(saved.get('dash.theme'), '"dark"');
});

function worker(overrides = {}) {
  const handlers = {};
  const values = vm.runInNewContext(`${source('sw.js')}\n;({ CACHE, SHELL });`, {
    URL,
    Response,
    location: { origin: 'https://dashboard.test' },
    self: {
      addEventListener: (type, fn) => { handlers[type] = fn; },
      skipWaiting: () => {},
      clients: { claim: () => {} },
      ...overrides.self,
    },
    caches: overrides.caches,
    fetch: overrides.fetch,
  }, { filename: 'sw.js' });
  function dispatch(type, request) {
    const waits = [];
    let response;
    handlers[type]({
      request,
      waitUntil: (promise) => waits.push(promise),
      respondWith: (promise) => { response = promise; },
    });
    return { response, done: Promise.all(waits), waits };
  }
  return { ...values, dispatch };
}

test('worker precaches the complete local module graph and shell before activation', async () => {
  let assets;
  let skipped = false;
  const adding = deferred();
  const sw = worker({
    caches: { open: async () => ({ addAll: (urls) => { assets = [...urls]; return adding.promise; } }) },
    self: { skipWaiting: () => { skipped = true; } },
  });
  const event = sw.dispatch('install');
  await flush();
  assert.equal(skipped, false);
  assert.equal(new Set(assets).size, assets.length);
  for (const url of assets) {
    assert.ok(!url.startsWith('/api/'));
    if (url !== '/manifest.webmanifest') {
      assert.ok(fs.existsSync(path.join(publicDir, url === '/' ? 'index.html' : url.slice(1))), url);
    }
  }
  for (const url of ['/', '/app.css', '/favicon.svg', '/manifest.webmanifest', '/icons/icon-192.png']) {
    assert.ok(assets.includes(url), url);
  }
  const visited = new Set();
  function checkModule(url) {
    if (visited.has(url)) return;
    visited.add(url);
    assert.ok(assets.includes(url), `Missing shell module: ${url}`);
    for (const match of source(url.slice(1)).matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)) {
      checkModule(path.posix.resolve(path.posix.dirname(url), match[1]));
    }
  }
  checkModule('/js/main.js');
  adding.resolve();
  await event.done;
  assert.equal(skipped, true);
});

test('failed shell precaching rejects installation without replacing the active worker', async () => {
  let skipped = false;
  const sw = worker({
    caches: { open: async () => ({ addAll: async () => { throw new Error('missing shell'); } }) },
    self: { skipWaiting: () => { skipped = true; } },
  });
  await assert.rejects(sw.dispatch('install').done, /missing shell/);
  assert.equal(skipped, false);
});

test('worker activation deletes only obsolete dashboard caches', async () => {
  const deleted = [];
  let claimed = false;
  const sw = worker({
    caches: {
      keys: async () => [sw.CACHE, 'dashboard-v1', 'showy-dashboard-v1', 'other-app-v1'],
      delete: async (key) => { deleted.push(key); },
    },
    self: { clients: { claim: () => { claimed = true; } } },
  });
  await sw.dispatch('activate').done;
  assert.deepEqual(deleted.sort(), ['dashboard-v1', 'showy-dashboard-v1']);
  assert.equal(claimed, true);
});

const request = (pathname, extra = {}) => ({ url: `https://dashboard.test${pathname}`, method: 'GET', mode: 'cors', ...extra });

test('worker extends cache-write lifetime without delaying the network response', async () => {
  const writing = deferred();
  let copy;
  const response = new Response('shell');
  const sw = worker({
    fetch: async () => response,
    caches: { open: async () => ({ put: (req, value) => { copy = value; return writing.promise; } }) },
  });
  const event = sw.dispatch('fetch', request('/app.css'));
  assert.equal(event.waits.length, 1);
  assert.equal(await event.response, response);
  let finished = false;
  event.done.then(() => { finished = true; });
  await flush();
  assert.equal(finished, false);
  assert.equal(await copy.text(), 'shell');
  writing.resolve();
  await event.done;
  assert.equal(await response.text(), 'shell');
});

for (const failure of ['open', 'put']) {
  test(`worker tolerates cache ${failure} failures with a successful network response`, async () => {
    const response = new Response('online');
    const sw = worker({
      fetch: async () => response,
      caches: { open: async () => {
        if (failure === 'open') throw new Error('storage denied');
        return { put: async () => { throw new Error('quota'); } };
      } },
    });
    const event = sw.dispatch('fetch', request('/app.css'));
    assert.equal(await event.response, response);
    await event.done;
  });
}

test('worker leaves API, cross-origin and non-GET requests alone', async () => {
  const sw = worker({ fetch: () => { throw new Error('must not fetch'); } });
  for (const req of [request('/api/config'), request('/app.css', { method: 'POST' }), request('/', { url: 'https://other.test/' })]) {
    const event = sw.dispatch('fetch', req);
    assert.equal(event.response, undefined);
    assert.equal(event.waits.length, 0);
    await event.done;
  }
});

test('worker offline fallback uses only its own cache and only navigations get HTML', async () => {
  const shell = new Response('offline shell');
  const css = new Response('offline CSS');
  const opened = [];
  const sw = worker({
    fetch: async () => { throw new Error('offline'); },
    caches: { open: async (key) => {
      opened.push(key);
      return { match: async (req) => req === '/' ? shell : req.url.endsWith('/app.css') ? css : undefined };
    } },
  });
  for (const [req, expected] of [[request('/app.css'), css], [request('/elsewhere', { mode: 'navigate' }), shell]]) {
    const event = sw.dispatch('fetch', req);
    assert.equal(await event.response, expected);
    await event.done;
  }
  const missing = sw.dispatch('fetch', request('/missing.js'));
  assert.equal((await missing.response).type, 'error');
  await missing.done;
  assert.ok(opened.every((key) => key === sw.CACHE));
});

test('worker handles offline cache denial and does not cache HTTP errors', async () => {
  const sw = worker({
    fetch: async () => { throw new Error('offline'); },
    caches: { open: async () => { throw new Error('denied'); } },
  });
  const offline = sw.dispatch('fetch', request('/'));
  assert.equal((await offline.response).type, 'error');
  await offline.done;
  const unavailable = new Response('unavailable', { status: 503 });
  const online = worker({
    fetch: async () => unavailable,
    caches: { open: () => { assert.fail('HTTP errors must not be cached'); } },
  }).dispatch('fetch', request('/'));
  assert.equal(await online.response, unavailable);
  await online.done;
});

function clipboardHarness({ modal = false, open = false, command = () => true, clipboard } = {}) {
  const nodes = new Map();
  const $ = (selector) => {
    if (!nodes.has(selector)) nodes.set(selector, new Element());
    return nodes.get(selector);
  };
  $('#clipMenu').matches = () => open;
  const body = new Element();
  const dialog = modal ? new Element() : null;
  const messages = [];
  const focusCalls = [];
  const focused = { focus: (options) => focusCalls.push(options) };
  const document = { body, activeElement: focused, querySelector: () => dialog, execCommand: command };
  let textarea;
  let copyParent;
  let renders = 0;
  const state = { clip: { entries: [{ id: 'entry', text: 'hello', createdAt: 1 }], max: 10 } };
  const module = browserModule('js/clip.js', ['copyText', 'renderList'], {
    navigator: { clipboard }, document, state, $, clearTimeout,
    toast: (...args) => messages.push(args),
    h: (tag) => {
      const node = new Element(tag);
      if (tag === 'textarea') {
        textarea = node;
        node.select = () => { copyParent = node.parentElement; document.activeElement = node; };
      }
      return node;
    },
    fill: () => { renders++; },
    iconBtn: () => new Element(),
    fmtDateTime: () => 'date',
  });
  return { ...module, $, state, body, dialog, messages, focusCalls,
    get textarea() { return textarea; }, get copyParent() { return copyParent; }, get renders() { return renders; } };
}

for (const location of ['body', 'popover', 'modal']) {
  test(`clipboard fallback uses ${location} and restores focus`, async () => {
    const harness = clipboardHarness({ modal: location === 'modal', open: location !== 'body' });
    await harness.copyText('copied text');
    assert.equal(harness.copyParent, location === 'modal' ? harness.dialog : location === 'popover' ? harness.$('#clipMenu') : harness.body);
    assert.equal(harness.textarea.value, 'copied text');
    assert.equal(harness.textarea.parentElement, null);
    assert.equal(harness.focusCalls.length, 1);
    assert.equal(harness.focusCalls[0].preventScroll, true);
    assert.deepEqual(harness.messages, [['Copied']]);
  });
}

for (const throws of [false, true]) {
  test(`clipboard fallback cleans up when copying ${throws ? 'throws' : 'returns false'}`, async () => {
    const harness = clipboardHarness({ command: () => { if (throws) throw new Error('denied'); return false; } });
    await harness.copyText('text');
    assert.equal(harness.textarea.parentElement, null);
    assert.equal(harness.focusCalls.length, 1);
    assert.equal(harness.messages.length, 1);
    assert.equal(harness.messages[0][1], true);
  });
}

test('clipboard native success avoids the fallback and rejection uses it', async () => {
  let copied;
  const native = clipboardHarness({ clipboard: { writeText: async (text) => { copied = text; } } });
  await native.copyText('native');
  assert.equal(copied, 'native');
  assert.equal(native.textarea, undefined);
  assert.equal(native.focusCalls.length, 0);
  const denied = clipboardHarness({ clipboard: { writeText: async () => { throw new Error('denied'); } } });
  await denied.copyText('fallback');
  assert.equal(denied.copyParent, denied.body);
});

test('clipboard count and controls update without rebuilding unchanged history', () => {
  const harness = clipboardHarness();
  harness.$('#clipList').scrollTop = 75;
  harness.renderList();
  assert.equal(harness.$('#clipCount').textContent, '1 / 10');
  harness.state.clip.max = 25;
  harness.renderList();
  assert.equal(harness.$('#clipCount').textContent, '1 / 25');
  assert.equal(harness.renders, 1);
  assert.equal(harness.$('#clipList').scrollTop, 75);
  harness.state.clip.entries = [];
  harness.renderList();
  assert.equal(harness.$('#clipCount').textContent, '');
  assert.equal(harness.$('#clipClearAll').disabled, true);
  assert.equal(harness.$('#clipList').hidden, true);
});

test('only the initiating pointer can move or finish a drag', () => {
  const root = new Element();
  const body = new Element();
  const window = new Element();
  const items = ['a', 'b'].map((id) => {
    const item = new Element('item');
    item.dataset.id = id;
    item.append(new Element('handle'));
    return item;
  });
  root.append(...items);
  const sorts = [];
  const canceled = [];
  const { makeSortable, isDragging } = browserModule('js/sortable.js', ['makeSortable', 'isDragging'], {
    window, document: { body, elementFromPoint: () => items[1] },
    requestAnimationFrame: () => 17, cancelAnimationFrame: (id) => canceled.push(id),
  });
  makeSortable(root, { item: 'item', handle: 'handle', onSort: (value) => sorts.push(value) });
  const event = (pointerId) => ({ pointerId, pointerType: 'touch', target: items[0].children[0], clientX: 10, clientY: 20, preventDefault() {} });
  root.emit('pointerdown', event(1));
  assert.equal(isDragging(), true);
  root.emit('pointerdown', event(2));
  assert.equal(body.children.length, 1);
  window.emit('pointermove', event(2));
  assert.deepEqual(root.children.map((item) => item.dataset.id), ['a', 'b']);
  window.emit('pointerup', event(2));
  window.emit('pointercancel', event(2));
  assert.equal(isDragging(), true);
  window.emit('pointermove', event(1));
  assert.deepEqual(root.children.map((item) => item.dataset.id), ['b', 'a']);
  window.emit('pointerup', event(1));
  assert.equal(isDragging(), false);
  assert.equal(body.children.length, 0);
  assert.equal(sorts.length, 1);
  assert.deepEqual(canceled, [17]);
  for (const handlers of window.listeners.values()) assert.equal(handlers.size, 0);
  root.emit('pointerdown', event(3));
  window.emit('pointercancel', event(3));
  assert.equal(isDragging(), false);
  assert.equal(body.children.length, 0);
  assert.equal(sorts.length, 1);
});

function pollingHarness() {
  const calls = [];
  const state = { health: {}, usage: {}, stats: null, remotes: [] };
  let clock = 100;
  const module = browserModule('js/api.js', ['loadHealth', 'loadUsage', 'loadStats', 'loadDocker', 'loadClip', 'loadRemotes', 'loadRemote'], {
    state,
    Date: { now: () => ++clock },
    normalizeConfig: (config) => config,
    fetch: (url) => {
      const pending = deferred();
      calls.push({ url, ...pending });
      return pending.promise;
    },
  });
  const respond = (index, data, ok = true) => calls[index].resolve({ ok, json: async () => data });
  return { ...module, state, calls, respond };
}

for (const [method, endpoint, payload] of [
  ['loadHealth', '/api/health', { results: { service: 'fresh' } }],
  ['loadUsage', '/api/docker/stats', { interval: 5, stats: { container: 'fresh' } }],
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
    assert.ok(harness.state.localAt > 0);
  });
}

test('poll sources run independently and failed requests release their slots', async () => {
  const harness = pollingHarness();
  const health = harness.loadHealth();
  const stats = harness.loadStats();
  const duplicateStats = harness.loadStats();
  const fresh = harness.loadHealth(true);
  assert.equal(harness.calls.length, 2);
  harness.calls[0].reject(new Error('offline'));
  assert.equal(await health, false);
  await flush();
  assert.equal(harness.calls.length, 3);
  harness.respond(1, { cpu: 7 });
  harness.respond(2, { results: { service: 'up' } });
  await Promise.all([stats, duplicateStats, fresh]);
  assert.equal(harness.state.stats.cpu, 7);
  assert.equal(harness.state.health.service, 'up');
  const next = harness.loadStats();
  assert.equal(harness.calls.length, 4);
  harness.respond(3, { cpu: 8 });
  await next;
  assert.equal(harness.state.stats.cpu, 8);
});

test('queued fresh remotes use their actual fetch start when choosing newer data', async () => {
  const harness = pollingHarness();
  const normal = harness.loadRemotes();
  const fresh = harness.loadRemotes('remote');
  const remote = (name) => ({ id: 'remote', name, ok: true, age: 0, servers: [{ id: 'server' }] });
  harness.respond(0, { remotes: [remote('old')] });
  await normal;
  await flush();
  assert.equal(harness.calls.length, 2);
  assert.equal(harness.calls[1].url, '/api/remotes?fresh=remote');
  assert.equal(harness.state.remotes[0].name, 'old');
  harness.respond(1, { remotes: [remote('fresh')] });
  await fresh;
  assert.equal(harness.state.remotes[0].name, 'fresh');
});

test('a slow bulk remote poll still preserves newer individually loaded data', async () => {
  const harness = pollingHarness();
  const bulk = harness.loadRemotes();
  const individual = harness.loadRemote('remote', { fresh: true });
  const remote = (name) => ({ id: 'remote', name, ok: true, age: 0, servers: [{ id: 'server' }] });
  harness.respond(1, { remotes: [remote('newer individual')] });
  await individual;
  harness.respond(0, { remotes: [remote('older bulk')] });
  await bulk;
  assert.equal(harness.state.remotes[0].name, 'newer individual');
});
