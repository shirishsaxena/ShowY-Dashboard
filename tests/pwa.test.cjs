const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { sanitizeConfig } = require("../lib/config");
const read = (file) => fs.readFileSync(path.join(__dirname, "..", file), "utf8");

test("install names are optional, trimmed, bounded, and preserved by config round trips", () => {
  for (const [input, expected] of [
    [undefined, ""], [null, ""], [42, ""], ["   ", ""],
    ["  Lab NAS  ", "Lab NAS"], ["x".repeat(80), "x".repeat(60)],
    ["Home & Lab <NAS>", "Home & Lab <NAS>"],
  ]) {
    const config = sanitizeConfig({ settings: { title: "Private", appName: input }, servers: [] });
    assert.equal(config.settings.appName, expected);
    assert.equal(sanitizeConfig(JSON.parse(JSON.stringify(config))).settings.appName, expected);
    assert.equal(config.settings.title, "Private");
  }
});

function metadataFixture(fetch) {
  const meta = { content: "Dashboard" }, link = { href: "/manifest.webmanifest" };
  const events = {};
  const document = {
    querySelector: (selector) => selector.startsWith("meta") ? meta : link,
    addEventListener: (event, fn) => events[event] = fn,
  };
  const code = read("public/js/pwa.js").replace(/\bexport /g, "");
  const api = vm.runInNewContext(`${code}\n({refreshInstallMetadata, initInstallMetadata})`, { fetch, document, Date });
  return { ...api, meta, link, events };
}

test("install metadata uses the public manifest name and refreshes the manifest link only on saves", async () => {
  let name = "Home NAS", calls = 0;
  const fixture = metadataFixture(async (url, options) => {
    calls++;
    assert.equal(url, "/manifest.webmanifest");
    assert.equal(options.cache, "no-cache");
    return { ok: true, json: async () => ({ name }) };
  });
  await fixture.refreshInstallMetadata();
  assert.equal(fixture.meta.content, "Home NAS");
  assert.equal(fixture.link.href, "/manifest.webmanifest");
  name = "VPS & <Lab>";
  await fixture.refreshInstallMetadata(true);
  assert.equal(fixture.meta.content, name);
  assert.match(fixture.link.href, /^\/manifest.webmanifest\?v=\d+$/);
  assert.equal(calls, 2);
  fixture.initInstallMetadata();
  assert.equal(typeof fixture.events["config-saved"], "function");
});

test("metadata failures keep safe defaults and do not reject startup", async () => {
  for (const fetch of [
    async () => { throw new Error("Offline"); },
    async () => ({ ok: false }),
    async () => ({ ok: true, json: async () => ({}) }),
    async () => ({ ok: true, json: async () => { throw new Error("Invalid JSON"); } }),
  ]) {
    const fixture = metadataFixture(fetch);
    await fixture.refreshInstallMetadata(true);
    assert.equal(fixture.meta.content, "Dashboard");
    assert.equal(fixture.link.href, "/manifest.webmanifest");
  }
});

test("a slow earlier metadata response cannot overwrite the latest name", async () => {
  let resolve;
  let calls = 0;
  const first = new Promise((r) => resolve = r);
  const fixture = metadataFixture(async () => ({
    ok: true, json: () => ++calls === 1 ? first : Promise.resolve({ name: "New name" }),
  }));
  const pending = fixture.refreshInstallMetadata();
  await Promise.resolve();
  await fixture.refreshInstallMetadata(true);
  resolve({ name: "Old name" });
  await pending;
  assert.equal(fixture.meta.content, "New name");
});

test("Settings presents public naming disclosure and saves the name with General settings", () => {
  const html = read("public/index.html");
  assert.match(html, /name="appName" maxlength="60"/);
  assert.match(html, /Public name shown when installing this dashboard, even when password-protected/);
  assert.match(html, /name="apple-mobile-web-app-title" content="Dashboard"/);
  const js = read("public/js/dialogs/settings.js");
  assert.match(js, /appName: value\(form, "appName"\)/);
  assert.match(js, /field\(form, "appName"\)\.value = settings.appName \|\| ""/);
  assert.match(js, /const GENERAL_CONTROLS = .*name="appName"/);
  assert.match(read("public/js/main.js"), /function initPwa\(\) \{\s*initInstallMetadata\(\)/);
  assert.ok(read("public/sw.js").includes('"/js/pwa.js"'));
});
