const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { inflateSync } = require("node:zlib");
const { sanitizeConfig } = require("../lib/config");
const read = (file) =>
  fs.readFileSync(path.join(__dirname, "..", file), "utf8");

test("branded raster icons have the expected PNG dimensions and an opaque maskable canvas", () => {
  for (const [file, size] of [
    ["apple-touch-icon.png", 180],
    ["icon-192.png", 192],
    ["icon-512.png", 512],
    ["icon-maskable-512.png", 512],
  ]) {
    const png = fs.readFileSync(path.join(__dirname, "../public/icons", file));
    assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a", file);
    assert.equal(png.readUInt32BE(16), size, file);
    assert.equal(png.readUInt32BE(20), size, file);
    // RGB PNGs do not contain an alpha channel or transparent palette entries.
    assert.equal(png[25], 2, file);
    let offset = 8;
    const chunks = [];
    while (offset < png.length) {
      const type = png.toString("ascii", offset + 4, offset + 8);
      assert.notEqual(type, "tRNS", file);
      if (type === "IDAT")
        chunks.push(
          png.subarray(offset + 8, offset + 8 + png.readUInt32BE(offset)),
        );
      offset += png.readUInt32BE(offset) + 12;
    }
    // Decode PNG scanlines to catch renderer-added white padding or misalignment.
    const packed = inflateSync(Buffer.concat(chunks));
    const stride = size * 3;
    const pixels = Buffer.alloc(size * stride);
    for (let y = 0; y < size; y++) {
      const filter = packed[y * (stride + 1)];
      assert.ok(filter <= 4, file);
      for (let x = 0; x < stride; x++) {
        const index = y * stride + x;
        const left = x >= 3 ? pixels[index - 3] : 0;
        const up = y ? pixels[index - stride] : 0;
        const diagonal = y && x >= 3 ? pixels[index - stride - 3] : 0;
        const prediction = left + up - diagonal;
        const distances = [
          Math.abs(prediction - left),
          Math.abs(prediction - up),
          Math.abs(prediction - diagonal),
        ];
        const paeth =
          distances[0] <= distances[1] && distances[0] <= distances[2]
            ? left
            : distances[1] <= distances[2]
              ? up
              : diagonal;
        const adjustment = [0, left, up, Math.floor((left + up) / 2), paeth][
          filter
        ];
        pixels[index] = (packed[y * (stride + 1) + 1 + x] + adjustment) & 255;
      }
    }
    const pixel = (x, y) => [
      ...pixels.subarray(y * stride + x * 3, y * stride + x * 3 + 3),
    ];
    for (const [x, y] of [
      [0, 0],
      [size - 1, 0],
      [0, size - 1],
      [size - 1, size - 1],
    ]) {
      assert.deepEqual(pixel(x, y), [27, 20, 27], `${file}: dark-plum corner`);
    }
    const scale = file.includes("maskable") ? 0.75 : 1;
    const inset = file.includes("maskable") ? size / 8 : 0;
    const [red, green, blue] = pixel(
      Math.floor(inset + size * scale * 0.65),
      Math.floor(inset + size * scale * 0.3),
    );
    assert.ok(
      red > green + 30 && blue > 130,
      `${file}: rose tile is correctly positioned`,
    );
  }
});

test("legacy favicon contains small, medium and large PNG images", () => {
  const ico = fs.readFileSync(path.join(__dirname, "../public/favicon.ico"));
  assert.equal(ico.readUInt16LE(0), 0);
  assert.equal(ico.readUInt16LE(2), 1);
  assert.equal(ico.readUInt16LE(4), 3);
  for (const [index, size] of [16, 32, 48].entries()) {
    const entry = 6 + index * 16;
    assert.equal(ico[entry], size);
    assert.equal(ico[entry + 1], size);
    const bytes = ico.readUInt32LE(entry + 8);
    const offset = ico.readUInt32LE(entry + 12);
    assert.ok(offset + bytes <= ico.length);
    assert.equal(
      ico.subarray(offset, offset + 8).toString("hex"),
      "89504e470d0a1a0a",
    );
  }
});

test("page, switcher and manifest use versioned icons that are available offline", async () => {
  const html = read("public/index.html");
  const shell = new Set(
    vm.runInNewContext(`${read("public/sw.js")}\nSHELL`, {
      self: { addEventListener() {} },
    }),
  );
  const references = [
    ...html.matchAll(/(?:href|src)="([^\"]+\?v=ember-1)"/g),
  ].map((match) => match[1]);
  assert.ok(references.includes("/favicon.svg?v=ember-1"));
  assert.ok(references.includes("/favicon.ico?v=ember-1"));
  assert.ok(references.includes("/icons/apple-touch-icon.png?v=ember-1"));
  assert.equal(
    references.filter((url) => url === "/favicon.svg?v=ember-1").length,
    3,
  );
  for (const url of references) assert.ok(shell.has(url), url);
  assert.ok(
    read("public/js/view/switcher.js").includes(
      'src: "/favicon.svg?v=ember-1"',
    ),
  );
  let manifest;
  const mod = { exports: {} };
  vm.runInNewContext(read("web/manifest.js"), {
    module: mod,
    require: (name) => {
      if (name === "../lib/env") return { LOCK_VIEW: false };
      if (name === "../lib/config")
        return { readConfig: async () => ({ settings: {} }) };
      if (name === "../lib/http")
        return { send: (_req, _status, body) => (manifest = JSON.parse(body)) };
      throw new Error(`Unexpected import ${name}`);
    },
  });
  await mod.exports.serveManifest({}, {});
  assert.equal(manifest.icons.length, 3);
  for (const icon of manifest.icons) {
    assert.match(icon.src, /\?v=ember-1$/);
    assert.ok(shell.has(icon.src), icon.src);
  }
});

test("install names are optional, trimmed, bounded, and preserved by config round trips", () => {
  for (const [input, expected] of [
    [undefined, ""],
    [null, ""],
    [42, ""],
    ["   ", ""],
    ["  Lab NAS  ", "Lab NAS"],
    ["x".repeat(80), "x".repeat(60)],
    ["Home & Lab <NAS>", "Home & Lab <NAS>"],
  ]) {
    const config = sanitizeConfig({
      settings: { title: "Private", appName: input },
      servers: [],
    });
    assert.equal(config.settings.appName, expected);
    assert.equal(
      sanitizeConfig(JSON.parse(JSON.stringify(config))).settings.appName,
      expected,
    );
    assert.equal(config.settings.title, "Private");
  }
});

function metadataFixture(fetch) {
  const meta = { content: "Dashboard" },
    link = { href: "/manifest.webmanifest" };
  const events = {};
  const document = {
    querySelector: (selector) => (selector.startsWith("meta") ? meta : link),
    addEventListener: (event, fn) => (events[event] = fn),
  };
  const code = read("public/js/pwa.js").replace(/\bexport /g, "");
  const api = vm.runInNewContext(
    `${code}\n({refreshInstallMetadata, initInstallMetadata})`,
    { fetch, document, Date },
  );
  return { ...api, meta, link, events };
}

test("install metadata uses the public manifest name and refreshes the manifest link only on saves", async () => {
  let name = "Home NAS",
    calls = 0;
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
    async () => {
      throw new Error("Offline");
    },
    async () => ({ ok: false }),
    async () => ({ ok: true, json: async () => ({}) }),
    async () => ({
      ok: true,
      json: async () => {
        throw new Error("Invalid JSON");
      },
    }),
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
  const first = new Promise((r) => (resolve = r));
  const fixture = metadataFixture(async () => ({
    ok: true,
    json: () => (++calls === 1 ? first : Promise.resolve({ name: "New name" })),
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
  assert.match(
    html,
    /Public name shown when installing this dashboard, even when password-protected/,
  );
  assert.match(html, /name="apple-mobile-web-app-title" content="Dashboard"/);
  const js = read("public/js/dialogs/settings.js");
  assert.match(js, /appName: value\(form, "appName"\)/);
  assert.match(
    js,
    /field\(form, "appName"\)\.value = settings.appName \|\| ""/,
  );
  assert.match(js, /const GENERAL_CONTROLS = .*name="appName"/);
  assert.match(
    read("public/js/main.js"),
    /function initPwa\(\) \{\s*initInstallMetadata\(\)/,
  );
  assert.ok(read("public/sw.js").includes('"/js/pwa.js"'));
});
