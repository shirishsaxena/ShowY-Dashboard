const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { readStyles } = require("./helpers/styles.cjs");

const read = (file) => fs.readFileSync(path.join(__dirname, "..", file), "utf8");
const html = read("public/index.html");

test("every dialog has an accessible heading and a labelled close control", () => {
  const dialogs = [...html.matchAll(/<dialog\b([^>]*)>([\s\S]*?)<\/dialog>/g)];
  assert.equal(dialogs.length, 9);
  for (const [, attrs, body] of dialogs) {
    const title = attrs.match(/aria-labelledby="([^"]+)"/)?.[1];
    assert.ok(title, attrs);
    assert.match(body, new RegExp(`<h2 id="${title}"`));
    assert.match(body, /<button[^>]*data-close[^>]*aria-label="Close"/);
  }
});

test("long editors have named sections and optional labels remain inline", () => {
  for (const [id, sections] of [
    ["serviceDialog", ["Details", "Connection", "Organisation"]],
    ["serverDialog", ["Details", "Host"]],
  ]) {
    const body = html.match(new RegExp(`<dialog id="${id}"[\\s\\S]*?<\\/dialog>`))[0];
    assert.equal((body.match(/<fieldset/g) || []).length, sections.length);
    assert.equal((body.match(/<\/fieldset>/g) || []).length, sections.length);
    for (const section of sections) assert.ok(body.includes(`<legend>${section}</legend>`));
  }
  assert.doesNotMatch(html, />(?:Group|Main URL|Icon|Notes) <span class="muted">\(optional\)/);
});

test("remote fields have separate labels and icon suggestions are outside labels", () => {
  const remote = html.match(/<div class="settings-remote-fields">([\s\S]*?)<\/div>/)[1];
  const labels = [...remote.matchAll(/<label\b[^>]*>([\s\S]*?)<\/label>/g)];
  assert.equal(labels.length, 3);
  for (const [, label] of labels) {
    assert.doesNotMatch(label, /<label|<button/);
    assert.equal((label.match(/<input/g) || []).length, 1);
  }
  for (const name of ["service", "server", "link"]) {
    assert.match(html, new RegExp(`<label for="${name}Icon">[\\s\\S]*?<\\/label>\\s*<input\\s+id="${name}Icon"`));
  }
  for (const [, label] of html.matchAll(/<label\b[^>]*>([\s\S]*?)<\/label>/g))
    assert.doesNotMatch(label, /class="icon-suggest"|<label\b/);
});

test("shared dialogs contain scrolling and use interaction-aware validation", () => {
  const css = readStyles();
  assert.match(css, /body:has\(dialog\[open\]\)\s*\{\s*overflow: hidden/);
  assert.match(css, /\.dialog-body\s*\{[^}]*min-height: 0;[^}]*overflow-y: auto;[^}]*overscroll-behavior: contain/);
  for (const region of ["head", "foot"])
    assert.match(css, new RegExp(`\\.dialog-${region}\\s*\\{[^}]*flex-shrink: 0`));
  assert.match(css, /\.field input:user-invalid/);
  assert.doesNotMatch(css, /input:invalid:not\(:placeholder-shown\)/);
  assert.match(css, /\.equal-fields\s*\{\s*grid-template-columns: minmax\(0, 1fr\)/);
  assert.match(css, /prefers-reduced-motion: reduce/);
});

function promptFixture() {
  let focused;
  let close;
  const elements = new Map();
  const $ = (id) => {
    if (!elements.has(id)) elements.set(id, {
      classList: { toggle() {} },
      focus() { focused = id; },
      select() {},
      addEventListener(type, callback) { if (type === "close") close = callback; },
      showModal() {},
      close() { close(); },
    });
    return elements.get(id);
  };
  const code = read("public/js/dialogs/ask.js")
    .replace(/^import .*;$/gm, "")
    .replace("export function ask", "function ask");
  const ask = vm.runInNewContext(`${code}\nask`, {
    $, field: () => $("input"), document: { activeElement: null },
    requestAnimationFrame: (callback) => callback(),
  });
  return { ask, $, focus: () => focused };
}

test("destructive confirmations focus Cancel and cancellation resolves null", async () => {
  const { ask, $, focus } = promptFixture();
  const result = ask({ title: "Delete service?", danger: true });
  assert.equal(focus(), "#askCancel");
  $("#askDialog").close();
  assert.equal(await result, null);
});

test("text prompts still focus the input and return trimmed text", async () => {
  const { ask, $, focus } = promptFixture();
  const result = ask({ title: "Add group", label: "Name" });
  assert.equal(focus(), "input");
  $("input").value = "  Media  ";
  $("#askForm").onsubmit({ preventDefault() {} });
  assert.equal(await result, "Media");
});

test("ordinary confirmations keep their primary action focused", async () => {
  const { ask, $, focus } = promptFixture();
  const result = ask({ title: "Continue?" });
  assert.equal(focus(), "#askOk");
  $("#askForm").onsubmit({ preventDefault() {} });
  assert.equal(await result, true);
});

test("editor tabs and panels have matching accessible relationships", () => {
  for (const editor of ["service", "server"]) {
    const body = html.match(new RegExp(`<dialog id="${editor}Dialog"[\\s\\S]*?<\\/dialog>`))[0];
    const tabs = [...body.matchAll(/<button[^>]+role="tab"[^>]*>/g)];
    assert.equal(tabs.length, editor === "service" ? 3 : 2);
    for (const [index, [tab]] of tabs.entries()) {
      const id = tab.match(/id="([^"]+)"/)[1];
      const panel = tab.match(/aria-controls="([^"]+)"/)[1];
      assert.match(tab, new RegExp(`aria-selected="${index === 0}"`));
      const markup = body.match(new RegExp(`<fieldset[^>]*id="${panel}"[^>]*>`))[0];
      assert.match(markup, new RegExp(`role="tabpanel" aria-labelledby="${id}"`));
      assert.equal(markup.includes(" hidden"), index !== 0);
    }
  }
});

function tabsFixture() {
  let focused;
  function element() {
    return {
      attributes: {}, dataset: {}, children: [],
      getAttribute(key) { return this.attributes[key]; },
      setAttribute(key, value) { this.attributes[key] = value; },
      removeAttribute(key) { delete this.attributes[key]; },
      append(child) { this.children.push(child); },
      remove() {},
      insertAdjacentElement(position, child) { this.error = child; },
    };
  }
  const panels = [0, 1, 2].map((i) => ({ id: `panel${i}`, hidden: i !== 0 }));
  const tabs = panels.map((panel, index) => ({
    ...element(), textContent: `Section ${index}`,
    handlers: {}, attributes: { "aria-controls": panel.id },
    getAttribute(key) { return this.attributes[key]; },
    setAttribute(key, value) { this.attributes[key] = value; },
    addEventListener(type, fn) { this.handlers[type] = fn; },
    focus() { focused = `tab${index}`; },
  }));
  const body = { scrollTop: 120 };
  const feedback = {};
  const form = {
    id: "testForm", elements: [], handlers: {},
    querySelector(selector) {
      if (selector === ".editor-feedback") return feedback;
      return selector === ".dialog-body" ? body : { querySelectorAll: () => tabs };
    },
    querySelectorAll() { return panels; },
    addEventListener(type, fn) { this.handlers[type] = fn; },
  };
  const code = read("public/js/dialogs/common.js").replace(/\bexport /g, "");
  vm.runInNewContext(`${code}\ninitEditorTabs(form);`, {
    form, document: { createElement: element }, queueMicrotask: (fn) => fn(),
  });
  const control = (panel, valid = false) => ({
    ...element(), willValidate: true, validity: { valid },
    validationMessage: "Please fill out this field.", closest: () => panel,
    focus() {}, reportValidity() {},
  });
  return { form, body, tabs, panels, feedback, control, focus: () => focused };
}

test("editor tabs support arrows, Home/End, one tab stop, and reset", () => {
  const { form, body, tabs, panels, focus } = tabsFixture();
  function key(index, key) {
    let prevented = false;
    tabs[index].handlers.keydown({ key, preventDefault() { prevented = true; } });
    assert.ok(prevented);
  }
  key(0, "ArrowLeft");
  assert.equal(focus(), "tab2");
  assert.deepEqual(panels.map(p => p.hidden), [true, true, false]);
  assert.deepEqual(tabs.map(t => t.tabIndex), [-1, -1, 0]);
  key(2, "ArrowRight");
  assert.equal(focus(), "tab0");
  key(0, "End");
  assert.equal(focus(), "tab2");
  key(2, "Home");
  assert.equal(focus(), "tab0");
  tabs[1].handlers.click();
  assert.equal(body.scrollTop, 0);
  form.handlers.reset();
  assert.deepEqual(panels.map(p => p.hidden), [false, true, true]);
});

test("submitting reveals only the first invalid panel before native validation", () => {
  const { form, panels, control } = tabsFixture();
  const events = [];
  form.elements = [
    { willValidate: false, validity: { valid: false } },
    { willValidate: true, validity: { valid: true } },
    {
      ...control(panels[1]),
      willValidate: true, validity: { valid: false },
      closest: () => panels[1],
      focus() { assert.equal(panels[1].hidden, false); events.push("focus"); },
      reportValidity() { events.push("report"); },
    },
    control(panels[2]),
  ];
  form.handlers.submit({ preventDefault() { events.push("prevent"); }, stopImmediatePropagation() { events.push("stop"); } });
  assert.deepEqual(events, ["prevent", "stop", "focus", "report"]);
  assert.deepEqual(panels.map(p => p.hidden), [true, false, true]);
  form.elements = [{ willValidate: true, validity: { valid: true } }];
  form.handlers.submit({ preventDefault() { assert.fail("valid submissions must proceed"); } });
});

test("leaving an incomplete section marks its tab and preserves existing help associations", () => {
  const { form, tabs, panels, feedback, control } = tabsFixture();
  const input = control(panels[0]);
  input.setAttribute("aria-describedby", "existingHelp");
  form.elements = [input];
  assert.equal(tabs[0].children[0].hidden, true);
  tabs[1].handlers.click();
  assert.equal(panels[0].hidden, true);
  assert.equal(tabs[0].dataset.hasErrors, "true");
  assert.equal(tabs[0].children[0].hidden, false);
  assert.match(tabs[0].getAttribute("aria-label"), /1 error/);
  assert.equal(input.getAttribute("aria-invalid"), "true");
  assert.equal(input.error.textContent, input.validationMessage);
  assert.match(input.getAttribute("aria-describedby"), /^existingHelp testForm-error-/);
  assert.match(feedback.textContent, /Check 1 field in Section 0/);
  input.validity.valid = true;
  form.handlers.input();
  assert.equal(tabs[0].dataset.hasErrors, "false");
  assert.equal(input.getAttribute("aria-invalid"), undefined);
  assert.equal(input.getAttribute("aria-describedby"), "existingHelp");
  assert.equal(feedback.hidden, true);
});

test("Save marks every invalid section; disabled/deleted controls and reset clear errors", () => {
  const { form, tabs, panels, feedback, control } = tabsFixture();
  const a = control(panels[0]), b = control(panels[1]);
  form.elements = [a, b];
  form.handlers.submit({ preventDefault() {}, stopImmediatePropagation() {} });
  assert.deepEqual(tabs.map(t => t.dataset.hasErrors), ["true", "true", "false"]);
  assert.match(feedback.textContent, /Check 2 fields/);
  b.willValidate = false;
  form.handlers.change();
  assert.equal(tabs[1].dataset.hasErrors, "false");
  form.elements = [];
  form.handlers.click();
  assert.equal(feedback.hidden, true);
  form.elements = [a];
  form.handlers.submit({ preventDefault() {}, stopImmediatePropagation() {} });
  form.handlers.reset();
  assert.equal(a.getAttribute("aria-invalid"), undefined);
  assert.equal(tabs[0].children[0].hidden, true);
  assert.equal(feedback.hidden, true);
  assert.deepEqual(panels.map(p => p.hidden), [false, true, true]);
});

test("editor tabs reuse Settings segmented controls and distinguish error tabs", () => {
  assert.equal((html.match(/class="editor-tabs settings-tabs"/g) || []).length, 2);
  assert.match(html, /class="editor-tabs settings-tabs">\s*<div class="seg" role="tablist"/);
  const css = readStyles();
  assert.match(css, /dialog \.seg button\[aria-pressed="true"\],\s*dialog \.seg button\[aria-selected="true"\]/);
  assert.match(css, /\.editor-tabs \.seg \[data-has-errors="true"\]/);
  const responsive = read("public/css/responsive.css");
  assert.doesNotMatch(responsive, /\.editor-tabs/);
  assert.match(responsive, /\.settings-tabs\s*\{\s*padding: 12px 14px 0/);
});
