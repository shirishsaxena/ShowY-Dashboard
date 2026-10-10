const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const read = (file) => fs.readFileSync(path.join(__dirname, "..", file), "utf8");
function load(names, globals, file = "public/js/dialogs/settings.js") {
  const code = read(file)
    .replace(/^import\s[\s\S]*?;\r?$/gm, "")
    .replace(/\bexport (?=(?:async )?(?:function|const|class)\b)/g, "");
  return vm.runInNewContext(`${code}\n;({${names.join(",")}})`, globals);
}
function element(extra = {}) {
  const classes = new Set();
  return {
    disabled: false, isConnected: true, textContent: "", attributes: {},
    setAttribute(key, value) { this.attributes[key] = value; },
    removeAttribute(key) { delete this.attributes[key]; },
    classList: {
      toggle(key, on) { if (on) classes.add(key); else classes.delete(key); },
      add(key) { classes.add(key); }, remove(key) { classes.delete(key); },
    },
    ...extra,
  };
}

test("settings retain the original four tabs and every implemented control", () => {
  const html = read("public/index.html");
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(new Set(ids).size, ids.length);
  const dialog = html.slice(html.indexOf('<dialog id="settingsDialog"'), html.indexOf('<!-- Outage history -->'));
  const tabs = [...dialog.matchAll(/data-tab="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(tabs, ["general", "sharing", "monitoring", "data"]);
  for (const tab of tabs) assert.match(dialog, new RegExp(`data-panel="${tab}"`));
  for (const id of ["accentPicker", "hiddenList", "securityInfo", "shareToken", "shareCopyBtn", "shareNewBtn", "shareOffBtn", "shareFixedNote", "remoteList", "remoteName", "remoteUrl", "remoteToken", "remoteAddBtn", "remoteInterval", "remoteIntervalNote", "availEnabled", "availInterval", "availThreshold", "availLimitNote", "availInfo", "availViewBtn", "availClearBtn", "publicIpMode", "publicIpManual", "publicIpNote", "tunableList", "clipMax", "clipInfo", "clipClearSettingsBtn", "iconCacheInfo", "clearIconsBtn", "storageTotal", "storageList", "downloadLogsBtn", "clearLogsBtn", "logsFeedback", "exportBtn", "importFile", "appVersion"])
    assert.ok(ids.includes(id), `Missing existing control: ${id}`);
  assert.match(dialog, /id="importBtn"/);
  assert.match(dialog, /aria-labelledby="settingsTitle"/);
  assert.match(dialog, /settings-remote-fields/);
});

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function sessionHarness(editApi, controls = {}) {
  const messages = [];
  const session = load([
    "beginSettingsSession", "endSettingsSession", "settingsOperation", "settingsRequest", "protectSettingsControl",
  ], {
    AbortController, editApi,
    document: { querySelectorAll: (selector) => controls[selector] || [] },
    toast: (...args) => messages.push(args),
  }, "public/js/dialogs/settings-session.js");
  session.beginSettingsSession();
  return { ...session, messages };
}

test("settings locks before prompts, blocks duplicates, and restores fixed controls on failure", async () => {
  const editable = element(), fixed = element({ disabled: true });
  const gate = deferred();
  const session = sessionHarness(() => {}, { fields: [editable, fixed] });
  let starts = 0;
  const pending = session.settingsOperation("sharing", ["fields"], async () => {
    starts++;
    await gate.promise;
    throw new Error("Cannot persist settings");
  });
  assert.equal(editable.disabled, true);
  assert.equal(await session.settingsOperation("sharing", ["fields"], () => starts++), null);
  assert.equal(starts, 1);
  gate.resolve();
  await pending;
  assert.equal(editable.disabled, false);
  assert.equal(fixed.disabled, true);
  assert.equal(session.messages[0][0], "Cannot persist settings");
});

test("rebuilt storage clear buttons join pending resource locks and failed-load protection", async () => {
  const gate = deferred();
  const session = sessionHarness(() => {});
  const pending = session.settingsOperation("icons", [], async () => gate.promise);
  const button = element();
  session.protectSettingsControl("icons", button);
  assert.equal(button.disabled, true);
  gate.resolve();
  await pending;
  assert.equal(button.disabled, false);
  await session.settingsOperation("availability", [], () => { throw new Error("Offline"); }, { loading: true });
  const unavailable = element();
  session.protectSettingsControl("availability", unavailable);
  assert.equal(unavailable.disabled, true);
});

test("general form stale saves do not close or unlock a reopened dialog", async () => {
  const controls = new Map();
  const get = (selector) => {
    if (!controls.has(selector)) controls.set(selector, element({
      value: "", handlers: {},
      addEventListener(name, handler) { this.handlers[name] = handler; },
    }));
    return controls.get(selector);
  };
  const button = get("#settingsSaveBtn");
  const feedback = get("#settingsFeedback");
  const dialog = get("#settingsDialog");
  let closes = 0;
  dialog.close = () => closes++;
  const session = sessionHarness(() => {}, { "#settingsSaveBtn": [button] });
  const old = deferred(), latest = deferred();
  let calls = 0;
  const { initSettingsForm } = load(["initSettingsForm"], {
    ...session, $: get, value: () => "New title", DEFAULT_ACCENT: "", syncAccent() {},
    actions: { saveSettings: () => (++calls === 1 ? old.promise : latest.promise) },
    openOwnAvailability() {},
  });
  initSettingsForm();
  const submit = get("#settingsForm").handlers.submit;
  const first = submit({ preventDefault() {} });
  session.endSettingsSession();
  session.beginSettingsSession();
  const second = submit({ preventDefault() {} });
  old.resolve(true);
  await first;
  assert.equal(closes, 0);
  assert.equal(button.disabled, true);
  assert.equal(button.textContent, "Saving…");
  latest.resolve(false);
  await second;
  assert.equal(button.disabled, false);
  assert.equal(button.textContent, "Save");
  assert.match(feedback.textContent, /Not saved/);
  // An already queued close event must not end the newly opened session.
  dialog.open = true;
  dialog.handlers.close();
  let alive = false;
  await session.settingsOperation("check", [], () => { alive = true; });
  assert.equal(alive, true);
});

test("settings restores disabled-input focus without stealing a newer focus target", async () => {
  let focuses = 0;
  const body = element(), input = element({ focus() { focuses++; document.activeElement = input; } });
  const other = element();
  const document = { body, activeElement: input, querySelectorAll: () => [input] };
  const session = load(["beginSettingsSession", "settingsOperation"], {
    document, AbortController, editApi() {}, toast() {},
  }, "public/js/dialogs/settings-session.js");
  session.beginSettingsSession();
  await session.settingsOperation("info", ["input"], () => { document.activeElement = body; });
  assert.equal(focuses, 1);
  await session.settingsOperation("info", ["input"], () => { document.activeElement = other; });
  assert.equal(focuses, 1);
});

test("closed session load/save responses cannot apply or unlock a newer dialog operation", async () => {
  for (const method of ["GET", "PUT"]) {
    const old = deferred(), latest = deferred();
    const field = element();
    let calls = 0, applied = "draft";
    const session = sessionHarness(() => (++calls === 1 ? old.promise : latest.promise), { fields: [field] });
    const work = (scope) => session.settingsRequest(scope, method, "/api/info/settings").then((data) => {
      if (data) { scope.release(); applied = data.value; }
    });
    const first = session.settingsOperation("info", ["fields"], work);
    session.endSettingsSession();
    session.beginSettingsSession();
    const second = session.settingsOperation("info", ["fields"], work);
    old.resolve({ res: { ok: true }, data: { value: "old" } });
    await first;
    assert.equal(applied, "draft");
    assert.equal(field.disabled, true);
    latest.resolve({ res: { ok: true }, data: { value: "new" } });
    await second;
    assert.equal(applied, "new");
    assert.equal(field.disabled, false);
  }
});

test("superseded storage reads are discarded within the same session", async () => {
  const old = deferred(), latest = deferred();
  let calls = 0, applied;
  const session = sessionHarness(() => (++calls === 1 ? old.promise : latest.promise));
  const work = async (scope) => {
    const data = await session.settingsRequest(scope, "GET", "/api/storage");
    if (data) applied = data.total;
  };
  const first = session.settingsOperation("storage", [], work, { replace: true });
  const second = session.settingsOperation("storage", [], work, { replace: true });
  latest.resolve({ res: { ok: true }, data: { total: 20 } });
  await second;
  old.resolve({ res: { ok: true }, data: { total: 10 } });
  await first;
  assert.equal(applied, 20);
});

test("initial settings loads protect controls and failed loads cannot mutate stale values", async () => {
  const field = element();
  const gate = deferred();
  const session = sessionHarness(() => gate.promise, { fields: [field] });
  const pending = session.settingsOperation("sharing", ["fields"], async (scope) => {
    const data = await session.settingsRequest(scope, "GET", "/api/remotes/settings");
    if (data) scope.release(false);
  }, { loading: true });
  assert.equal(field.disabled, true);
  gate.resolve({ res: { ok: false, status: 503 }, data: { error: "Unavailable" } });
  await pending;
  let writes = 0;
  await session.settingsOperation("sharing", ["fields"], () => writes++);
  assert.equal(field.disabled, true);
  assert.equal(writes, 0);
  session.beginSettingsSession();
  await session.settingsOperation("sharing", ["fields"], (scope) => scope.release(false), { loading: true });
  assert.equal(field.disabled, false);
});

function editHarness(api, promptLogin, timers = {}) {
  const state = { auth: { authenticated: true }, tunables: { loadTimeout: 1 } };
  return { state, ...load(["editApi"], {
    state, api, promptLogin, AbortController, setTimeout, clearTimeout, ...timers,
  }, "public/js/edit-api.js") };
}

test("settings destructive authentication retry keeps a single confirmation and request body", async () => {
  let requests = 0, logins = 0, confirmations = 0;
  const bodies = [];
  const edit = editHarness(async (method, url, body) => {
    if (url === "/api/storage") return { res: { ok: true }, data: { total: 0, items: [] } };
    bodies.push(body);
    return ++requests === 1
      ? { res: { status: 401, ok: false }, data: {} }
      : { res: { status: 200, ok: true }, data: { ok: true } };
  }, async () => { logins++; return true; });
  const session = sessionHarness(edit.editApi);
  const controls = { "#logsFeedback": element(), "#storageTotal": element(), "#storageList": element() };
  const { manageLogs } = load(["manageLogs"], {
    ...session, $: (id) => controls[id], ask: async () => { confirmations++; return true; },
    toast() {}, fmtBytes: String, fill() {},
  });
  await manageLogs(true);
  assert.equal(confirmations, 1);
  assert.equal(logins, 1);
  assert.equal(requests, 2);
  assert.equal(bodies[0], bodies[1]);
  assert.match(controls["#logsFeedback"].textContent, /Logs cleared/);
});

test("settings cancellation during authentication cannot retry in a reopened session", async () => {
  const login = deferred();
  let requests = 0;
  const edit = editHarness(async () => {
    requests++;
    return { res: { status: 401 }, data: {} };
  }, () => login.promise);
  const session = sessionHarness(edit.editApi);
  const pending = session.settingsOperation("sharing", [], (scope) =>
    session.settingsRequest(scope, "PUT", "/api/share", { enabled: false }));
  await new Promise(setImmediate);
  session.endSettingsSession();
  session.beginSettingsSession();
  login.resolve(true);
  assert.equal(await pending, null);
  assert.equal(requests, 1);
  assert.equal(session.messages.length, 0);
});

test("edit requests time out and clear timers, but cancelled authentication is quiet", async () => {
  let expire, clears = 0;
  const edit = editHarness((method, url, body, signal) => new Promise((resolve, reject) => {
    signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  }), () => { throw new Error("Must not prompt"); }, {
    setTimeout: (callback) => { expire = callback; return 1; },
    clearTimeout: () => clears++,
  });
  const pending = edit.editApi("GET", "/api/tunables");
  expire();
  await assert.rejects(pending, /Request timed out/);
  assert.equal(clears, 1);
  const cancelled = editHarness(async () => ({ res: { status: 401 }, data: {} }), async () => false);
  assert.equal(await cancelled.editApi("PUT", "/api/share", {}), null);
});

test("binary log download uses shared authentication and consumes the blob within its deadline", async () => {
  const blob = { text: "backend logs" };
  let fetches = 0, blobs = 0, logins = 0;
  const { api } = load(["api"], {
    state: {}, toast() {},
    fetch: async () => ++fetches === 1
      ? { status: 401, ok: false, json: async () => ({ error: "Login required" }) }
      : { status: 200, ok: true, blob: async () => { blobs++; return blob; } },
  }, "public/js/api.js");
  const edit = editHarness(api, async () => { logins++; return true; });
  const result = await edit.editApi("GET", "/api/logs", undefined, { responseType: "blob" });
  assert.equal(result.data, blob);
  assert.equal(blobs, 1);
  assert.equal(logins, 1);
});

test("tunable save keeps input identity, other drafts, and fixed controls", async () => {
  const input = element({ value: "4" }), other = element({ value: "unsaved draft" });
  const fixed = element({ disabled: true });
  const feedback = element();
  const item = { key: "loadTimeout", min: 1, max: 10, value: 2, label: "Timeout" };
  const session = sessionHarness(async () => ({
    res: { ok: true }, data: { items: [{ ...item, value: 4 }], client: { loadTimeout: 4 } },
  }), { "#tunableList input": [input, other, fixed] });
  const state = { tunables: {} };
  const { saveTunable } = load(["saveTunable"], {
    ...session, state, toast() {}, document: { dispatchEvent() {} }, CustomEvent: class {},
    fill() { throw new Error("Must not replace the focused controls"); },
  });
  await saveTunable(item, input, feedback);
  assert.equal(input.value, 4);
  assert.equal(other.value, "unsaved draft");
  assert.equal(input.disabled, false);
  assert.equal(fixed.disabled, true);
  assert.equal(state.tunables.loadTimeout, 4);
  assert.equal(feedback.textContent, "Saved");
});

test("explicit render interface stays synchronous and removes actions/authentication view edges", () => {
  const calls = [];
  const bridge = load(["setRenderer", "render"], {}, "public/js/render-interface.js");
  bridge.setRenderer(() => calls.push("rendered"));
  bridge.render();
  assert.deepEqual(calls, ["rendered"]);
  for (const file of ["public/js/actions.js", "public/js/dialogs/login.js", "public/js/dialogs/settings.js"])
    assert.doesNotMatch(read(file), /from ["'][^"']*view\/render\.js/);
  assert.match(read("public/js/main.js"), /setRenderer\(render\)/);
  const sw = read("public/sw.js");
  for (const file of ["render-interface.js", "dialogs/settings-session.js"])
    assert.ok(sw.includes(`"/js/${file}"`));
});

test("tunable validation is inline and never sends invalid values", async () => {
  const feedback = element();
  const globalFeedback = element();
  const input = element({ value: "2.5" });
  let requests = 0;
  const { saveTunable } = load(["saveTunable"], {
    $: () => globalFeedback,
    actions: { ensureCanEdit: () => { requests++; return true; } },
  });
  for (const value of ["2.5", "0", "11", "not a number"]) {
    input.value = value;
    await saveTunable({ min: 1, max: 10 }, input, feedback);
    assert.equal(input.attributes["aria-invalid"], "true");
    assert.match(feedback.textContent, /whole number from 1 to 10/);
  }
  assert.equal(requests, 0);
});

test("layout, theme, and installation move from the toolbar into General", () => {
  const html = read("public/index.html");
  const general = html.slice(html.indexOf('data-panel="general"'), html.indexOf('data-panel="sharing"'));
  for (const id of ["layoutSeg", "themeSeg", "installBtn", "installHint"])
    assert.match(general, new RegExp(`id="${id}"`));
  assert.doesNotMatch(html, /id="viewBtn"|id="viewMenu"/);
  const main = read("public/js/main.js");
  assert.doesNotMatch(main, /#viewMenu|#viewBtn|initViewMenu/);
  assert.match(main, /#settingsDialog"\)\.close\(\)/);
});

test("display controls use existing immediate preferences and maintain selected state", () => {
  const controls = { "#layoutSeg": element(), "#themeSeg": element() };
  for (const control of Object.values(controls))
    control.querySelectorAll = () => control.children;
  const picks = [];
  const { renderDisplayPreferences } = load(["renderDisplayPreferences"], {
    prefs: { layout: "compact", theme: "dark" },
    LAYOUTS: ["cards", "compact", "list"], THEMES: ["auto", "light", "dark"],
    setLayout: (value) => picks.push(["layout", value]),
    setTheme: (value) => picks.push(["theme", value]),
    $: (selector) => controls[selector],
    h: (tag, attributes, ...children) => element({
      ...attributes, dataset: { value: attributes["data-value"] }, children,
    }),
    svg: (name) => name,
    fill: (control, children) => { control.children = children; },
  });
  renderDisplayPreferences();
  const layout = controls["#layoutSeg"].children;
  assert.equal(layout[1]["aria-pressed"], "true");
  layout[2].onclick();
  assert.deepEqual(picks[0], ["layout", "list"]);
  assert.equal(layout[2].attributes["aria-pressed"], "true");
  assert.equal(layout[1].attributes["aria-pressed"], "false");
  const theme = controls["#themeSeg"].children;
  theme[0].onclick();
  assert.deepEqual(picks[1], ["theme", "auto"]);
  assert.equal(theme[0].attributes["aria-pressed"], "true");
});

test("logging keeps edit authorization, destructive confirmation, and download behavior", () => {
  const js = read("public/js/dialogs/settings.js");
  assert.match(js, /async function manageLogs[\s\S]*?settingsOperation\("logs"/);
  assert.match(read("public/js/dialogs/settings-session.js"), /await editApi\(/);
  assert.match(js, /Clear backend logs\?[\s\S]*?danger: true/);
  assert.match(js, /settingsRequest\(scope, clear \? "DELETE" : "GET", "\/api\/logs"/);
  assert.match(js, /download: "backend-logs.txt"/);
  assert.match(js, /URL.revokeObjectURL/);
  assert.match(js, /addEventListener\("close",[\s\S]*?endSettingsSession\(\);[\s\S]*?syncAccent\(\)/);
});

test("settings refine existing cards with aligned fields and responsive stacking", () => {
  const css = require("./helpers/styles.cjs").readStyles();
  assert.match(css, /#settingsDialog \.settings-display-seg\s*\{[^}]*display: grid;[^}]*grid-template-columns: repeat\(3, minmax\(0, 1fr\)\)/);
  assert.match(css, /#settingsDialog \.settings-display-seg button\s*\{[^}]*justify-content: center/);
  assert.match(css, /body:has\(#settingsDialog\[open\]\)/);
  assert.match(css, /#settingsDialog \.set-group\s*\{\s*padding: 18px/);
  assert.match(css, /\.settings-remote-fields\s*\{[^}]*grid-template-columns: minmax\(0, 1fr\)/);
  assert.doesNotMatch(css, /\.settings-remote-fields > \.field:nth-child\(2\)/);
  assert.match(css, /#settingsDialog #tunableList > \.set-group/);
  assert.match(css, /grid-template-columns: minmax\(0, 1fr\)/);
  assert.match(css, /env\(safe-area-inset-bottom\)/);
  assert.match(css, /overscroll-behavior: contain/);
});
