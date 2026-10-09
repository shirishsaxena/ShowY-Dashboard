const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const read = (file) => fs.readFileSync(path.join(__dirname, "..", file), "utf8");
function load(names, globals) {
  const code = read("public/js/dialogs/settings.js")
    .replace(/^import\s[\s\S]*?;\r?$/gm, "")
    .replace(/\bexport (?=(?:function|const)\b)/g, "");
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
  assert.match(js, /async function manageLogs[\s\S]*?actions.ensureCanEdit\(\)/);
  assert.match(js, /Clear backend logs\?[\s\S]*?danger: true/);
  assert.match(js, /fetch\("\/api\/logs"/);
  assert.match(js, /download: "backend-logs.txt"/);
  assert.match(js, /URL.revokeObjectURL/);
  assert.match(js, /dialog.addEventListener\("close", syncAccent/);
});

test("settings refine existing cards with aligned fields and responsive stacking", () => {
  const css = read("public/app.css");
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
