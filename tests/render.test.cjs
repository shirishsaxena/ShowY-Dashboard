const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function browserModule(file, names, globals) {
  const code = fs
    .readFileSync(path.join(__dirname, "../public/js", file), "utf8")
    .replace(/^import\s[\s\S]*?;\r?$/gm, "")
    .replace(/\bexport (?=(?:function|const|let)\b)/g, "");
  return vm.runInNewContext(`${code}\n;({ ${names.join(", ")} });`, globals, {
    filename: file,
  });
}

function urlHelpers(hostname = "localhost") {
  return browserModule(
    "utils.js",
    ["safeUrl", "serviceUrls", "primaryUrl", "monitoringUrl"],
    {
      URL,
      location: { hostname },
    },
  );
}

// Deliberately small DOM fixture: identity, attributes, focus loss and event ownership.
class Node {
  constructor(name, document, text = "") {
    this.nodeName = name;
    this.document = document;
    this.text = text;
    this.childNodes = [];
    this.attributes = new Map();
    this.listeners = new Map();
    this.style = {};
    this.classList = { toggle() {} };
  }
  setAttribute(key, value) {
    this.attributes.set(key, String(value));
  }
  set className(value) {
    this.setAttribute("class", value);
  }
  get children() {
    return this.childNodes.filter((node) => node.nodeName !== "#text");
  }
  get childElementCount() {
    return this.children.length;
  }
  get textContent() {
    return this.nodeName === "#text"
      ? this.text
      : this.childNodes.map((node) => node.textContent).join("");
  }
  set textContent(text) {
    this.replaceChildren(String(text));
  }
  append(...nodes) {
    for (const node of nodes) {
      const child =
        node instanceof Node
          ? node
          : this.document.createTextNode(String(node));
      child.parentNode = this;
      this.childNodes.push(child);
    }
  }
  contains(node) {
    return (
      this === node || this.childNodes.some((child) => child.contains(node))
    );
  }
  replaceChildren(...nodes) {
    if (
      this.childNodes.some((node) => node.contains(this.document.activeElement))
    )
      this.document.activeElement = null;
    this.childNodes.forEach((node) => {
      node.parentNode = null;
    });
    this.childNodes = [];
    this.append(...nodes);
    this.replacements = (this.replacements || 0) + 1;
  }
  isEqualNode(other) {
    return (
      this.nodeName === other.nodeName &&
      this.text === other.text &&
      this.attributes.size === other.attributes.size &&
      [...this.attributes].every(
        ([key, value]) => other.attributes.get(key) === value,
      ) &&
      this.childNodes.length === other.childNodes.length &&
      this.childNodes.every((node, i) => node.isEqualNode(other.childNodes[i]))
    );
  }
  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(handler);
  }
  removeEventListener(type, handler) {
    this.listeners.get(type)?.delete(handler);
  }
  emit(type) {
    for (const handler of [...(this.listeners.get(type) || [])])
      handler.call(this, { currentTarget: this, target: this });
  }
  focus() {
    this.document.activeElement = this;
  }
}

function fixture() {
  const document = {
    activeElement: null,
    createElement: (name) => new Node(name, document),
    createElementNS: (ns, name) => new Node(name, document),
    createTextNode: (text) => new Node("#text", document, text),
  };
  const dom = browserModule(
    "dom.js",
    ["h", "fill", "preserveEqualChildren", "iconNode", "svg", "external"],
    { document, Node },
  );
  return { ...dom, document };
}

test("equal opted-in sections preserve focused nodes and refresh nested handlers exactly once", () => {
  const { h, fill, preserveEqualChildren, document } = fixture();
  const root = h("section");
  preserveEqualChildren(root);
  const calls = [];
  const tree = (value) =>
    h(
      "div",
      {},
      h(
        "button",
        { onclick: (event) => calls.push([value, event.currentTarget]) },
        "Copy",
      ),
    );
  fill(root, tree("old"));
  const button = root.children[0].children[0];
  button.focus();
  fill(root, tree("new"));
  fill(root, tree("latest"));
  assert.equal(root.children[0].children[0], button);
  assert.equal(document.activeElement, button);
  assert.equal(root.replacements, 1);
  button.emit("click");
  assert.deepEqual(calls, [["latest", button]]);
  fill(root, h("div", {}, h("button", {}, "Copy")));
  button.emit("click");
  assert.equal(calls.length, 1, "obsolete managed handlers are removed");
});

test("changed structure, attributes, order, edit state and empty sections replace normally", () => {
  const { h, fill, preserveEqualChildren } = fixture();
  const root = h("section");
  preserveEqualChildren(root);
  const card = (id, editing = false) =>
    h(
      "article",
      { "data-id": id },
      h(editing ? "button" : "a", { href: editing ? null : `/${id}` }, id),
    );
  fill(root, card("a"), card("b"));
  const first = root.children[0];
  fill(root, card("b"), card("a"));
  assert.notEqual(root.children[0], first);
  fill(root, card("b", true));
  assert.equal(root.children[0].children[0].nodeName, "button");
  fill(root, null, false, "");
  assert.equal(root.childNodes.length, 0);
  assert.equal(root.replacements, 4);
  fill(root);
  assert.equal(root.replacements, 4);
});

test("ordinary fill callers retain replacement semantics and primitive filtering", () => {
  const { h, fill, preserveEqualChildren } = fixture();
  const root = h("section");
  fill(root, h("button", {}, "Same"));
  const before = root.children[0];
  fill(root, h("button", {}, "Same"));
  assert.notEqual(root.children[0], before);
  preserveEqualChildren(root);
  fill(root, [[0, false, null, "", "text"]]);
  const text = root.childNodes[0];
  fill(root, [0, "text"]);
  assert.equal(root.childNodes[0], text);
  assert.equal(root.textContent, "0text");
});

test("retained image error listeners keep ownership of the live icon box", () => {
  const { h, fill, preserveEqualChildren, iconNode } = fixture();
  const root = h("section");
  preserveEqualChildren(root);
  fill(root, iconNode("test-service", "Service"));
  const box = root.children[0];
  const image = box.children[0];
  fill(root, iconNode("test-service", "Service"));
  assert.equal(root.children[0], box);
  image.emit("error"); // Cache failure retries direct URL.
  image.emit("error"); // Direct failure replaces children in the original live box.
  assert.equal(root.children[0], box);
  assert.equal(box.textContent, "S");
  assert.equal(box.children[0].nodeName, "span");
});

test("real quick actions copy updated invisible text without replacing the focused button", () => {
  const dom = fixture();
  const root = dom.h("section");
  dom.preserveEqualChildren(root);
  const copied = [];
  const state = {
    config: {
      settings: {
        links: [{ id: "copy", name: "Token", type: "copy", text: "old" }],
      },
    },
    editing: false,
    query: "",
  };
  const { renderLinks } = browserModule("view/links.js", ["renderLinks"], {
    ...dom,
    state,
    $: () => root,
    safeUrl: () => "",
    copyText: (text) => copied.push(text),
    openLinkEditor() {},
  });
  renderLinks();
  const button = root.children[1].children[0];
  button.focus();
  state.config.settings.links = [
    { id: "copy", name: "Token", type: "copy", text: "new" },
  ];
  renderLinks();
  assert.equal(root.children[1].children[0], button);
  assert.equal(dom.document.activeElement, button);
  button.emit("click");
  assert.deepEqual(copied, ["new"]);
  renderLinks([]);
  assert.equal(root.hidden, true);
});

test("equal card markup receives fresh notes and QR service objects", () => {
  const dom = fixture();
  const root = dom.h("section");
  dom.preserveEqualChildren(root);
  const opened = [];
  const { serviceCard } = browserModule("view/cards.js", ["serviceCard"], {
    ...dom,
    state: { editing: false },
    isFavorite: () => false,
    ...urlHelpers(),
    hostPort: () => "",
    serviceStatus: () => null,
    containerFor: () => null,
    usageNode: () => null,
    cardMenuButton: () => null,
    iconBtn: (name, label, onclick) =>
      dom.h("button", { title: label, onclick }),
    openNote: (svc, anchor) => opened.push([svc.notes, anchor]),
  });
  fillCard("old");
  const findButton = (node) =>
    node.nodeName === "button"
      ? node
      : node.children.map(findButton).find(Boolean);
  const button = findButton(root);
  button.focus();
  fillCard("new");
  assert.equal(findButton(root), button);
  button.emit("click");
  assert.deepEqual(opened, [["new", button]]);
  function fillCard(notes) {
    dom.fill(
      root,
      serviceCard(
        { id: "svc", name: "Service", icon: "", notes },
        { id: "server" },
      ),
    );
  }
});

test("card links retain real destinations, accessible icon labels and note/QR actions", () => {
  const dom = fixture();
  const opened = [];
  const state = { editing: false };
  const { serviceCard } = browserModule("view/cards.js", ["serviceCard"], {
    ...dom,
    state,
    isFavorite: () => false,
    ...urlHelpers(),
    hostPort: (url) => url,
    serviceStatus: () => null,
    containerFor: () => null,
    usageNode: () => null,
    cardMenuButton: () => null,
    iconBtn: (name, label, onclick) =>
      dom.h("button", { "aria-label": label, onclick }, dom.svg(name)),
    openNote: (svc, anchor) => opened.push(["note", svc, anchor]),
    openQr: (svc) => opened.push(["qr", svc]),
  });
  const svc = {
    id: "long",
    name: "Long service ".repeat(30),
    description: "Description".repeat(100),
    notes: "Real notes",
    url: `https://${"a".repeat(60)}.example.test:8080/path`,
    altUrl: `https://${"b".repeat(60)}.example.test/path`,
  };
  const card = serviceCard(svc, { id: "server" }, { showServer: true });
  const links = card.children.find(
    (node) => node.attributes.get("class") === "links",
  );
  const anchors = links.children.filter((node) => node.nodeName === "a");
  assert.equal(anchors.length, 2);
  for (const [index, anchor] of anchors.entries()) {
    assert.equal(anchor.attributes.get("href"), index ? svc.altUrl : svc.url);
    assert.equal(
      anchor.attributes.get("aria-label"),
      `Open ${index ? "Public" : "Local"} link: ${index ? svc.altUrl : svc.url}`,
    );
    assert.equal(anchor.attributes.get("rel"), "noopener noreferrer");
    assert.equal(anchor.children[0].nodeName, "svg");
    assert.equal(anchor.children[1].attributes.get("class"), "link-label");
    assert.equal(anchor.children[1].textContent, index ? "Public" : "Local");
  }
  const buttons = links.children.filter((node) => node.nodeName === "button");
  assert.deepEqual(
    buttons.map((node) => node.attributes.get("aria-label")),
    ["Notes", "Show QR code"],
  );
  buttons[0].emit("click");
  buttons[1].emit("click");
  assert.deepEqual(opened, [
    ["note", svc, buttons[0]],
    ["qr", svc],
  ]);
  const empty = serviceCard(
    { id: "empty", name: "Empty", url: "javascript:bad" },
    { id: "server" },
  );
  assert.equal(
    empty.children.some((node) => node.attributes.get("class") === "links"),
    false,
  );
});

test("canonical cards and favorites open primary and render every safe label as text", () => {
  const dom = fixture();
  const helpers = urlHelpers("dashboard.example.com");
  const globals = {
    ...dom,
    ...helpers,
    state: { editing: false },
    isFavorite: () => false,
    serviceStatus: () => null,
    containerFor: () => null,
    usageNode: () => null,
    cardMenuButton: () => null,
    hostPort: () => "",
    iconBtn: () => null,
  };
  const { serviceCard } = browserModule(
    "view/cards.js",
    ["serviceCard"],
    globals,
  );
  const { favoriteTile } = browserModule(
    "view/favorites.js",
    ["favoriteTile"],
    globals,
  );
  const svc = {
    id: "svc",
    name: "App",
    url: "https://stale.test",
    altUrl: "https://stale-alt.test",
    urls: [
      {
        label: "<img src=x onerror=alert(1)>",
        url: "http://local.test:8080/path",
      },
      { label: "Public", url: "https://public.test/path" },
      { label: "VPN " + "long".repeat(14), url: "http://vpn.test/path" },
      { label: "Admin", url: "https://public.test/admin" },
      { label: "Unsafe", url: "javascript:alert(1)" },
      null,
    ],
  };
  const card = serviceCard(svc, { remote: "peer" });
  assert.equal(card.children[0].attributes.get("href"), svc.urls[0].url);
  assert.equal(favoriteTile(svc, {}).attributes.get("href"), svc.urls[0].url);
  const links = card.children.find(
    (node) => node.attributes.get("class") === "links",
  );
  assert.equal(links.children.length, 4);
  links.children.forEach((link, index) => {
    assert.equal(link.attributes.get("href"), svc.urls[index].url);
    assert.equal(link.attributes.get("title"), svc.urls[index].url);
    assert.equal(
      link.attributes.get("aria-label"),
      `Open ${svc.urls[index].label} link: ${svc.urls[index].url}`,
    );
    assert.equal(link.children[1].textContent, svc.urls[index].label);
    assert.equal(link.children[1].children.length, 0);
  });
  assert.equal(links.children[0].attributes.get("class"), "chip primary-link");
  for (const urls of [
    [],
    null,
    [{ label: "Unsafe", url: "javascript:bad" }, ...svc.urls.slice(1, 4)],
  ]) {
    const raw = { ...svc, urls };
    assert.equal(favoriteTile(raw, {}).nodeName, "div");
    assert.equal(
      serviceCard(raw, {}).children.some(
        (node) => node.attributes.get("class") === "main-link",
      ),
      false,
    );
  }
});

test("QR selector includes all safe labeled URLs and chooses canonical primary without unsafe links", () => {
  const dom = fixture();
  const nodes = new Map();
  const $ = (selector) => {
    if (!nodes.has(selector)) nodes.set(selector, dom.h("div"));
    return nodes.get(selector);
  };
  let opened = 0;
  const encoded = [];
  $("#qrDialog").showModal = () => opened++;
  const { openQr } = browserModule("dialogs/qr.js", ["openQr"], {
    ...dom,
    $,
    ...urlHelpers("dashboard.example.com"),
    QR: {
      toSvg: (url) => {
        encoded.push(url);
        return dom.h("svg");
      },
    },
  });
  const urls = ["Local", "Public", "<Admin>", "VPN"].map((label, i) => ({
    label,
    url: `https://app.test/${i}`,
  }));
  openQr({
    name: "App",
    urls,
    url: "https://stale.test",
    altUrl: "https://stale-alt.test",
  });
  assert.equal(opened, 1);
  assert.equal(encoded[0], urls[0].url);
  assert.equal($("#qrSwitch").children.length, 4);
  for (const [index, entry] of urls.entries()) {
    const button = $("#qrSwitch").children[index];
    assert.equal(button.textContent, entry.label);
    assert.equal(
      button.attributes.get("aria-label"),
      `${entry.label}: ${entry.url}`,
    );
    assert.equal(button.attributes.get("title"), entry.url);
    button.emit("click");
    assert.equal($("#qrUrl").href, entry.url);
    assert.equal(encoded.at(-1), entry.url);
    assert.equal(
      $("#qrSwitch").children[index].attributes.get("aria-pressed"),
      "true",
    );
  }
  openQr({ urls: [null, { label: "Bad", url: "javascript:bad" }, ...urls] });
  assert.equal($("#qrSwitch").children.length, 4);
  openQr({ urls: [], url: "https://stale.test" });
  openQr({ urls: [{ label: "Bad", url: "data:text/html,hi" }] });
  assert.equal(opened, 2);
  openQr({ url: "http://local.test/", altUrl: "https://public.test/" });
  assert.equal(encoded.at(-1), "https://public.test/");
});

test("search includes every labeled URL from local and remote services, not canonical shadows", () => {
  const dom = fixture();
  const nodes = new Map();
  const $ = (selector) => {
    if (!nodes.has(selector)) nodes.set(selector, dom.h("div"));
    return nodes.get(selector);
  };
  const svc = {
    name: "App",
    url: "https://stale.test",
    urls: [
      { label: "Local", url: "http://local.test" },
      { label: "Public", url: "https://public.test" },
      { label: "Management console", url: "https://admin.test/unique-path" },
      { label: "Private VPN", url: "http://vpn.test" },
    ],
  };
  const servers = [
    { services: [svc] },
    { remote: "peer", services: [{ ...svc, name: "Remote" }] },
  ];
  const results = [];
  const state = { query: "", config: { settings: { links: [] } } };
  const { renderSearch } = browserModule("view/search.js", ["renderSearch"], {
    ...dom,
    $,
    ...urlHelpers(),
    state,
    allServers: () => servers,
    renderLinks() {},
    serviceCard: (service, server) => {
      results.push({ service, server });
      return dom.h("article");
    },
  });
  for (const query of [
    "local.test",
    "public.test",
    "management console",
    "unique-path",
    "private vpn",
    "vpn.test",
  ]) {
    state.query = query;
    results.length = 0;
    renderSearch();
    assert.equal(results.length, 2, query);
    assert.equal(results[1].server.remote, "peer");
  }
  state.query = "stale.test";
  results.length = 0;
  renderSearch();
  assert.equal(results.length, 0);
});

test("compact and list CSS keeps actions visible and long content bounded", () => {
  const css = require("./helpers/styles.cjs").readStyles();
  const rules = (selector) =>
    [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
      .filter((match) => match[1].trim() === selector)
      .map((match) => match[2]);
  const listLinks = rules('body[data-layout="list"] #services .card .links');
  assert.ok(
    listLinks.some(
      (rule) => /flex-wrap: wrap/.test(rule) && /max-width: 45%/.test(rule),
    ),
  );
  assert.ok(listLinks.some((rule) => /max-width: 100%/.test(rule)));
  assert.ok(
    listLinks.every((rule) => !/display: none|overflow: hidden/.test(rule)),
  );
  assert.ok(
    rules('body[data-layout="compact"] #services .card .links a.chip').some(
      (rule) =>
        /min-height: 32px/.test(rule) && !/(?:^|;)\s*width: 32px/.test(rule),
    ),
  );
  assert.doesNotMatch(css, /:is\(\.link-label, \.amber, \.grow\)/);
  assert.doesNotMatch(
    css,
    /:is\(\.description, \.links, \.status-label, \.usage\)/,
  );
  assert.ok(
    rules(".card .links .link-label").some(
      (rule) =>
        /min-width: 0/.test(rule) && /overflow-wrap: anywhere/.test(rule),
    ),
  );
  assert.ok(
    rules('body[data-layout="list"] #services .card').some((rule) =>
      /flex-direction: column/.test(rule),
    ),
  );
  assert.ok(
    rules(".service-url-row").some((rule) =>
      /grid-template-columns: minmax\(0, 1fr\);/.test(rule),
    ),
  );
  assert.ok(rules("#qrSwitch").some((rule) => /flex-wrap: wrap/.test(rule)));
  const html = fs.readFileSync(
    path.join(__dirname, "../public/index.html"),
    "utf8",
  );
  assert.match(html, /id="serviceAddUrl"[^>]*>\s*Add URL/);
  const normalizedHtml = html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");

  assert.match(
    normalizedHtml,
    /Only the first\s+URL is health-checked; bookmarks are never monitored/,
  );
  assert.doesNotMatch(html, /name="altUrl"/);
});

function renderer() {
  const dom = fixture();
  const elements = new Map();
  const $ = (selector) => {
    if (!elements.has(selector)) elements.set(selector, dom.h("div"));
    return elements.get(selector);
  };
  $("#editBtn").querySelector = () => $("#editLabel");
  dom.document.body = dom.h("body");
  const frames = new Map();
  let id = 0;
  let dragging = false;
  const window = dom.h("window");
  const calls = [];
  const state = {
    config: { settings: { title: "Test" } },
    auth: {},
    editing: false,
    query: "",
    locked: false,
  };
  const server = { id: "local", services: [] };
  const api = browserModule("view/render.js", ["render", "requestRender"], {
    ...dom,
    $,
    state,
    window,
    activeServer: () => server,
    allServers: () => [server],
    plural: (n, label) => `${n} ${label}`,
    serviceStatus: () => null,
    isDragging: () => dragging,
    settleLoad: () => calls.push("settle"),
    renderSwitcher: () => calls.push("switcher"),
    renderFavorites: () => calls.push("favorites"),
    renderServer: (s) => calls.push(s),
    renderSearch: () => calls.push("search"),
    renderLinks: () => calls.push("links"),
    requestAnimationFrame: (fn) => {
      frames.set(++id, fn);
      return id;
    },
    cancelAnimationFrame: (key) => frames.delete(key),
  });
  return {
    ...api,
    calls,
    state,
    server,
    frames,
    window,
    drag: (value) => {
      dragging = value;
    },
    frame() {
      const work = [...frames.values()];
      frames.clear();
      work.forEach((fn) => fn());
    },
  };
}

test("background renders coalesce using latest state; immediate actions cancel queued work", () => {
  const r = renderer();
  r.requestRender();
  r.requestRender();
  assert.equal(r.frames.size, 1);
  r.state.query = "query";
  r.frame();
  assert.deepEqual(r.calls, ["settle", "switcher", "favorites", "search"]);
  r.calls.length = 0;
  r.requestRender();
  r.state.query = "";
  r.render();
  assert.equal(r.frames.size, 0);
  assert.deepEqual(r.calls, [
    "settle",
    "switcher",
    "favorites",
    r.server,
    "links",
  ]);
});

for (const event of ["pointerup", "pointercancel"]) {
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
    assert.deepEqual(r.calls, [
      "settle",
      "switcher",
      "favorites",
      r.server,
      "links",
    ]);
    assert.equal(r.window.listeners.get("pointerup").size, 0);
    assert.equal(r.window.listeners.get("pointercancel").size, 0);
  });
}

test("queued renders do not overwrite the lock screen", () => {
  const r = renderer();
  r.requestRender();
  r.state.locked = true;
  r.frame();
  assert.deepEqual(r.calls, []);
});
