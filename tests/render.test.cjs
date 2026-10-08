const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function browserModule(file, names, globals) {
  const code = fs.readFileSync(path.join(__dirname, '../public/js', file), 'utf8')
    .replace(/^import .*;\r?$/gm, '')
    .replace(/\bexport (?=(?:function|const|let)\b)/g, '');
  return vm.runInNewContext(`${code}\n;({ ${names.join(', ')} });`, globals, { filename: file });
}

// Deliberately small DOM fixture: identity, attributes, focus loss and event ownership.
class Node {
  constructor(name, document, text = '') {
    this.nodeName = name;
    this.document = document;
    this.text = text;
    this.childNodes = [];
    this.attributes = new Map();
    this.listeners = new Map();
    this.style = {};
    this.classList = { toggle() {} };
  }
  setAttribute(key, value) { this.attributes.set(key, String(value)); }
  set className(value) { this.setAttribute('class', value); }
  get children() { return this.childNodes.filter((node) => node.nodeName !== '#text'); }
  get childElementCount() { return this.children.length; }
  get textContent() { return this.nodeName === '#text' ? this.text : this.childNodes.map((node) => node.textContent).join(''); }
  set textContent(text) { this.replaceChildren(String(text)); }
  append(...nodes) {
    for (const node of nodes) {
      const child = node instanceof Node ? node : this.document.createTextNode(String(node));
      child.parentNode = this;
      this.childNodes.push(child);
    }
  }
  contains(node) { return this === node || this.childNodes.some((child) => child.contains(node)); }
  replaceChildren(...nodes) {
    if (this.childNodes.some((node) => node.contains(this.document.activeElement))) this.document.activeElement = null;
    this.childNodes.forEach((node) => { node.parentNode = null; });
    this.childNodes = [];
    this.append(...nodes);
    this.replacements = (this.replacements || 0) + 1;
  }
  isEqualNode(other) {
    return this.nodeName === other.nodeName && this.text === other.text &&
      this.attributes.size === other.attributes.size &&
      [...this.attributes].every(([key, value]) => other.attributes.get(key) === value) &&
      this.childNodes.length === other.childNodes.length &&
      this.childNodes.every((node, i) => node.isEqualNode(other.childNodes[i]));
  }
  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(handler);
  }
  removeEventListener(type, handler) { this.listeners.get(type)?.delete(handler); }
  emit(type) {
    for (const handler of [...(this.listeners.get(type) || [])]) handler.call(this, { currentTarget: this, target: this });
  }
  focus() { this.document.activeElement = this; }
}

function fixture() {
  const document = {
    activeElement: null,
    createElement: (name) => new Node(name, document),
    createElementNS: (ns, name) => new Node(name, document),
    createTextNode: (text) => new Node('#text', document, text),
  };
  const dom = browserModule('dom.js', ['h', 'fill', 'preserveEqualChildren', 'iconNode', 'svg', 'external'], { document, Node });
  return { ...dom, document };
}

test('equal opted-in sections preserve focused nodes and refresh nested handlers exactly once', () => {
  const { h, fill, preserveEqualChildren, document } = fixture();
  const root = h('section');
  preserveEqualChildren(root);
  const calls = [];
  const tree = (value) => h('div', {}, h('button', { onclick: (event) => calls.push([value, event.currentTarget]) }, 'Copy'));
  fill(root, tree('old'));
  const button = root.children[0].children[0];
  button.focus();
  fill(root, tree('new'));
  fill(root, tree('latest'));
  assert.equal(root.children[0].children[0], button);
  assert.equal(document.activeElement, button);
  assert.equal(root.replacements, 1);
  button.emit('click');
  assert.deepEqual(calls, [['latest', button]]);
  fill(root, h('div', {}, h('button', {}, 'Copy')));
  button.emit('click');
  assert.equal(calls.length, 1, 'obsolete managed handlers are removed');
});

test('changed structure, attributes, order, edit state and empty sections replace normally', () => {
  const { h, fill, preserveEqualChildren } = fixture();
  const root = h('section');
  preserveEqualChildren(root);
  const card = (id, editing = false) => h('article', { 'data-id': id }, h(editing ? 'button' : 'a', { href: editing ? null : `/${id}` }, id));
  fill(root, card('a'), card('b'));
  const first = root.children[0];
  fill(root, card('b'), card('a'));
  assert.notEqual(root.children[0], first);
  fill(root, card('b', true));
  assert.equal(root.children[0].children[0].nodeName, 'button');
  fill(root, null, false, '');
  assert.equal(root.childNodes.length, 0);
  assert.equal(root.replacements, 4);
  fill(root);
  assert.equal(root.replacements, 4);
});

test('ordinary fill callers retain replacement semantics and primitive filtering', () => {
  const { h, fill, preserveEqualChildren } = fixture();
  const root = h('section');
  fill(root, h('button', {}, 'Same'));
  const before = root.children[0];
  fill(root, h('button', {}, 'Same'));
  assert.notEqual(root.children[0], before);
  preserveEqualChildren(root);
  fill(root, [[0, false, null, '', 'text']]);
  const text = root.childNodes[0];
  fill(root, [0, 'text']);
  assert.equal(root.childNodes[0], text);
  assert.equal(root.textContent, '0text');
});

test('retained image error listeners keep ownership of the live icon box', () => {
  const { h, fill, preserveEqualChildren, iconNode } = fixture();
  const root = h('section');
  preserveEqualChildren(root);
  fill(root, iconNode('test-service', 'Service'));
  const box = root.children[0];
  const image = box.children[0];
  fill(root, iconNode('test-service', 'Service'));
  assert.equal(root.children[0], box);
  image.emit('error'); // Cache failure retries direct URL.
  image.emit('error'); // Direct failure replaces children in the original live box.
  assert.equal(root.children[0], box);
  assert.equal(box.textContent, 'S');
  assert.equal(box.children[0].nodeName, 'span');
});

test('real quick actions copy updated invisible text without replacing the focused button', () => {
  const dom = fixture();
  const root = dom.h('section');
  dom.preserveEqualChildren(root);
  const copied = [];
  const state = { config: { settings: { links: [{ id: 'copy', name: 'Token', type: 'copy', text: 'old' }] } }, editing: false, query: '' };
  const { renderLinks } = browserModule('view/links.js', ['renderLinks'], {
    ...dom, state, $: () => root, safeUrl: () => '', copyText: (text) => copied.push(text), openLinkEditor() {},
  });
  renderLinks();
  const button = root.children[1].children[0];
  button.focus();
  state.config.settings.links = [{ id: 'copy', name: 'Token', type: 'copy', text: 'new' }];
  renderLinks();
  assert.equal(root.children[1].children[0], button);
  assert.equal(dom.document.activeElement, button);
  button.emit('click');
  assert.deepEqual(copied, ['new']);
  renderLinks([]);
  assert.equal(root.hidden, true);
});

test('equal card markup receives fresh notes and QR service objects', () => {
  const dom = fixture();
  const root = dom.h('section');
  dom.preserveEqualChildren(root);
  const opened = [];
  const { serviceCard } = browserModule('view/cards.js', ['serviceCard'], {
    ...dom, state: { editing: false }, isFavorite: () => false,
    safeUrl: () => '', hostLabel: () => '', hostOf: () => '', primaryUrl: () => '', hostPort: () => '',
    serviceStatus: () => null, containerFor: () => null, usageNode: () => null,
    iconBtn: (name, label, onclick) => dom.h('button', { title: label, onclick }),
    openNote: (svc, anchor) => opened.push([svc.notes, anchor]),
  });
  fillCard('old');
  const findButton = (node) => node.nodeName === 'button' ? node : node.children.map(findButton).find(Boolean);
  const button = findButton(root);
  button.focus();
  fillCard('new');
  assert.equal(findButton(root), button);
  button.emit('click');
  assert.deepEqual(opened, [['new', button]]);
  function fillCard(notes) {
    dom.fill(root, serviceCard({ id: 'svc', name: 'Service', icon: '', notes }, { id: 'server' }));
  }
});

function renderer() {
  const dom = fixture();
  const elements = new Map();
  const $ = (selector) => {
    if (!elements.has(selector)) elements.set(selector, dom.h('div'));
    return elements.get(selector);
  };
  $('#editBtn').querySelector = () => $('#editLabel');
  dom.document.body = dom.h('body');
  const frames = new Map();
  let id = 0;
  let dragging = false;
  const window = dom.h('window');
  const calls = [];
  const state = { config: { settings: { title: 'Test' } }, auth: {}, editing: false, query: '', locked: false };
  const server = { id: 'local', services: [] };
  const api = browserModule('view/render.js', ['render', 'requestRender'], {
    ...dom, $, state, window, activeServer: () => server, allServers: () => [server],
    plural: (n, label) => `${n} ${label}`, serviceStatus: () => null, isDragging: () => dragging,
    settleLoad: () => calls.push('settle'), renderSwitcher: () => calls.push('switcher'), renderFavorites: () => calls.push('favorites'),
    renderServer: (s) => calls.push(s), renderSearch: () => calls.push('search'), renderLinks: () => calls.push('links'),
    requestAnimationFrame: (fn) => { frames.set(++id, fn); return id; }, cancelAnimationFrame: (key) => frames.delete(key),
  });
  return { ...api, calls, state, server, frames, window, drag: (value) => { dragging = value; },
    frame() { const work = [...frames.values()]; frames.clear(); work.forEach((fn) => fn()); },
  };
}

test('background renders coalesce using latest state; immediate actions cancel queued work', () => {
  const r = renderer();
  r.requestRender();
  r.requestRender();
  assert.equal(r.frames.size, 1);
  r.state.query = 'query';
  r.frame();
  assert.deepEqual(r.calls, ['settle', 'switcher', 'favorites', 'search']);
  r.calls.length = 0;
  r.requestRender();
  r.state.query = '';
  r.render();
  assert.equal(r.frames.size, 0);
  assert.deepEqual(r.calls, ['settle', 'switcher', 'favorites', r.server, 'links']);
});

for (const event of ['pointerup', 'pointercancel']) {
  test(`renders defer during dragging and resume after ${event} without another data refresh`, () => {
    const r = renderer();
    r.drag(true);
    r.requestRender();
    r.frame();
    r.render();
    r.requestRender();
    assert.equal(r.frames.size, 0);
    assert.deepEqual(r.calls, []);
    r.window.emit(event); // An unrelated pointer can end while the initiating pointer is still down.
    r.frame();
    assert.deepEqual(r.calls, []);
    r.window.emit(event);
    r.drag(false); // Simulate the sortable end listener running later in the same event dispatch.
    r.frame();
    assert.deepEqual(r.calls, ['settle', 'switcher', 'favorites', r.server, 'links']);
    assert.equal(r.window.listeners.get('pointerup').size, 0);
    assert.equal(r.window.listeners.get('pointercancel').size, 0);
  });
}

test('queued renders do not overwrite the lock screen', () => {
  const r = renderer();
  r.requestRender();
  r.state.locked = true;
  r.frame();
  assert.deepEqual(r.calls, []);
});
