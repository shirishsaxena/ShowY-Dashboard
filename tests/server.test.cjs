"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");
const { SECURITY_HEADERS, HttpError, send } = require("../lib/http");
const { createContext } = require("../http/context");

test("request context parses queries once and matches only the first exact fresh value", () => {
  for (const [url, fresh] of [
    ["/api/health?fresh=1", true],
    ["/api/health?fresh=10", false],
    ["/api/health?other=fresh=1", false],
    ["/api/health?fresh=%31", true],
    ["/api/health?fresh=0&fresh=1", false],
    ["/api/health?fresh=1&fresh=0", true],
    ["/api/health?fresh=", false],
    ["/api/health", false],
  ]) {
    const req = { url };
    const context = createContext(req, {});
    assert.equal(context.fresh, fresh, url);
    assert.equal(context.query, context.url.searchParams);
    assert.deepEqual(req, { url });
  }
  const context = createContext({ url: "/api/remotes?id=a%2Fb&fresh=remote" }, {});
  assert.equal(context.query.get("id"), "a/b");
  assert.equal(context.query.get("fresh"), "remote");
});

function createServerFixture() {
  let handler;
  let reads = 0;
  const publicDir = path.resolve(__dirname, "../public");
  const modules = {
    fs: {
      promises: {
        async stat() {
          return { isFile: () => true, size: 42, mtimeMs: 1000 };
        },
        async readFile() {
          reads++;
          return Buffer.from("asset");
        },
      },
    },
    path,
    "./routes/index": {},
    "./lib/env": { PUBLIC_DIR: publicDir },
    "./lib/http": { SECURITY_HEADERS, HttpError, send },
    "./lib/auth": { async initAuth() {} },
    "./lib/availability": { async init() {} },
  };
  const root = path.resolve(__dirname, "..");
  const cache = new Map();
  function load(filename) {
    if (cache.has(filename)) return cache.get(filename).exports;
    const module = { exports: {} };
    cache.set(filename, module);
    vm.runInNewContext(
      `(function(require, module, exports, __dirname, __filename) {\n${fs.readFileSync(filename, "utf8")}\n})`,
      { process: { on() {} }, console, URL, Buffer, setTimeout, clearTimeout },
      { filename },
    )((name) => {
      if (Object.hasOwn(modules, name)) return modules[name];
      if (name.startsWith(".")) {
        const resolved = path.resolve(path.dirname(filename), name + ".js");
        const original = "./" + path.relative(root, resolved).replace(/\\/g, "/").replace(/\.js$/, "");
        if (Object.hasOwn(modules, original)) return modules[original];
        if (/^(http|routes|web)\//.test(path.relative(root, resolved))) return load(resolved);
        return {};
      }
      return require(name);
    }, module, module.exports, path.dirname(filename), filename);
    return module.exports;
  }
  handler = load(path.join(root, "http/handler.js")).handleRequest;
  return {
    get reads() {
      return reads;
    },
    async request(url, method = "GET", headers = {}) {
      const response = {
        writeHead(status, responseHeaders) {
          this.status = status;
          this.headers = responseHeaders;
          this.headersSent = true;
        },
        end(body) {
          this.body = body;
        },
      };
      await handler({ url, method, headers }, response);
      return response;
    },
  };
}

test("malformed request URLs return 400 without breaking subsequent requests", async () => {
  const server = createServerFixture();
  assert.equal((await server.request("//[")).status, 400);
  assert.equal((await server.request("/app.css")).status, 200);
});

test("static HEAD and conditional GET avoid reading asset contents", async () => {
  const server = createServerFixture();
  const head = await server.request("/app.css", "HEAD");
  assert.equal(head.status, 200);
  assert.equal(head.body, undefined);
  assert.equal(server.reads, 0);

  const conditional = await server.request("/app.css", "GET", {
    "if-none-match": head.headers.ETag,
  });
  assert.equal(conditional.status, 304);
  assert.equal(server.reads, 0);

  const conditionalHead = await server.request("/app.css", "HEAD", {
    "if-none-match": head.headers.ETag,
  });
  assert.equal(conditionalHead.status, 304);
  assert.equal(conditionalHead.body, undefined);
  assert.equal(server.reads, 0);

  const get = await server.request("/app.css");
  assert.equal(get.body.toString(), "asset");
  assert.equal(get.headers.ETag, head.headers.ETag);
  assert.equal(server.reads, 1);
});
