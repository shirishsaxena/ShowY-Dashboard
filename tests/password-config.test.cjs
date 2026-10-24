"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");

function load(file, { mocks = {}, env = {} } = {}) {
  const filename = path.join(__dirname, "..", file);
  const local = createRequire(filename);
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, "utf8"), {
    module, Buffer, __dirname: path.dirname(filename),
    process: { env, platform: "linux" },
    require: (name) => Object.hasOwn(mocks, name) ? mocks[name] : local(name),
  }, { filename });
  return module.exports;
}

test("password configuration accepts canonical standard Base64 and preserves the decoded UTF-8 exactly", () => {
  for (const password of ["a", "ab", "abc", "correct horse battery staple", "  leading and trailing  ", "café-密码-🔐-$", "࿿"]) {
    const encoded = Buffer.from(password, "utf8").toString("base64");
    const config = load("lib/env.js", { env: { DASHBOARD_PASSWORD: encoded } });
    assert.equal(config.PASSWORD, password);
    assert.equal(config.PASSWORD_ERROR, "");
    assert.equal(config.LOCK_VIEW, true);
  }
  const config = load("lib/env.js", { env: { DASHBOARD_PASSWORD: "YWJj", DASHBOARD_LOCK_VIEW: "false" } });
  assert.equal(config.PASSWORD, "abc");
  assert.equal(config.LOCK_VIEW, false);
});

test("empty or unset password configuration retains passwordless mode", () => {
  for (const env of [{}, { DASHBOARD_PASSWORD: "" }]) {
    const config = load("lib/env.js", { env });
    assert.equal(config.PASSWORD, "");
    assert.equal(config.PASSWORD_ERROR, "");
    assert.equal(config.LOCK_VIEW, false);
  }
});

test("malformed Base64, URL-safe variants, noncanonical pad bits and invalid UTF-8 are rejected", () => {
  for (const encoded of [
    "raw-password!", "abc", "YQ", "YQ=", "YQ===", "Y=Q=", "=YQ=", "YQ==\n", " YQ==", "Y Q==", "\t",
    "YQ-_", "4L-_", "AB==", "YWJ=", "/w==", "wyg=", "7aCA", "====",
  ]) {
    const config = load("lib/env.js", { env: { DASHBOARD_PASSWORD: encoded } });
    assert.equal(config.PASSWORD, "", encoded);
    assert.match(config.PASSWORD_ERROR, /DASHBOARD_PASSWORD must be canonical Base64/);
  }
});

test("invalid password configuration fails closed before authentication initialization does any I/O", async () => {
  const config = load("lib/env.js", { env: { DASHBOARD_PASSWORD: "invalid-plaintext!", DASHBOARD_LOCK_VIEW: "false" } });
  const auth = load("lib/auth.js", { mocks: {
    "./env": config,
    fs: { promises: { readFile: () => { throw new Error("Must not read the session key"); } } },
    "./config": { writeAtomic: () => { throw new Error("Must not write the session key"); } },
    "./logger": { info() {}, warn() {} },
  } });
  await assert.rejects(auth.initAuth(), /DASHBOARD_PASSWORD must be canonical Base64/);
  assert.equal(auth.isAuthenticated({ headers: {} }), false);
  assert.equal(auth.canView({ headers: {} }), false);
});
