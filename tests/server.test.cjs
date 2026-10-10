"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { Readable, Writable } = require("node:stream");
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
        async open() {
          return {
            createReadStream() {
              reads++;
              return Readable.from([Buffer.from("asset")]);
            },
            async close() {},
          };
        },
      },
    },
    path,
    "./routes/index": {},
    "./lib/env": { PUBLIC_DIR: publicDir },
    "./lib/http": { SECURITY_HEADERS, HttpError, send },
    "./lib/auth": { async initAuth() {} },
    "./lib/availability": { async init() {} },
    "./lib/logger": { debug() {}, info() {}, warn() {}, error() {} },
  };
  const root = path.resolve(__dirname, "..");
  const cache = new Map();
  function load(filename) {
    if (cache.has(filename)) return cache.get(filename).exports;
    const module = { exports: {} };
    cache.set(filename, module);
    vm.runInNewContext(
      `(function(require, module, exports, __dirname, __filename) {\n${fs.readFileSync(filename, "utf8")}\n})`,
      { process: { on() {}, hrtime: process.hrtime }, console, URL, Buffer, setTimeout, clearTimeout },
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
      const response = Object.assign(new Writable({
        write(chunk, encoding, callback) {
          this.body = this.body ? Buffer.concat([this.body, chunk]) : chunk;
          callback();
        },
      }), {
        writeHead(status, responseHeaders) {
          this.status = status;
          this.statusCode = status;
          this.headers = responseHeaders;
          this.headersSent = true;
        },
      });
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

test("request completion keeps read traces opt-in and mutations, failures and aborts diagnosable", async () => {
  const { EventEmitter } = require("node:events");
  const logs = [];
  let failure = null;
  const modules = {
    "./context": { createContext },
    "../web/manifest": {}, "../web/static": {},
    "../lib/http": { HttpError, send },
    "./router": { async handleApi() { if (failure) throw failure; } },
    "../lib/logger": Object.fromEntries(["debug", "info", "warn", "error"].map(
      (level) => [level, (message, context) => logs.push({ level, message, context })],
    )),
  };
  const module = { exports: {} };
  vm.runInNewContext(`(function(require,module,exports){${fs.readFileSync(
    path.resolve(__dirname, "../http/handler.js"), "utf8",
  )}\n})`, { process, URL })((id) => modules[id], module, module.exports);
  async function request(method, code, aborted = false) {
    logs.length = 0;
    const res = Object.assign(new EventEmitter(), {
      statusCode: code, writableEnded: !aborted,
      writeHead(code) { this.statusCode = code; this.headersSent = true; },
      end() { this.writableEnded = true; },
    });
    await module.exports.handleRequest({ method, url: "/api/stats?token=secret" }, res);
    res.emit("close");
    return logs.filter((entry) => entry.message !== "[HTTP] Incoming request");
  }
  for (const [method, code, aborted, level] of [
    ["GET", 200, false, "debug"], ["HEAD", 200, false, "debug"],
    ["GET", 304, false, "debug"], ["PUT", 200, false, "info"],
    ["POST", 201, false, "info"], ["DELETE", 204, false, "info"],
    ["GET", 401, false, "warn"], ["GET", 500, false, "error"],
    ["GET", 200, true, "warn"],
  ]) {
    const entries = await request(method, code, aborted);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].level, level);
    assert.equal(entries[0].context.route, "/api/stats");
    assert.equal(entries[0].context.aborted, aborted);
    assert.equal(typeof entries[0].context.durationMs, "number");
    assert.doesNotMatch(JSON.stringify(entries), /secret|token/);
  }
  failure = new Error("collector failed");
  const entries = await request("GET", 200, true);
  assert.equal(entries.length, 1, "exception is not logged twice on close");
  assert.equal(entries[0].level, "error");
  assert.equal(entries[0].message, "[HTTP] Request failed");
});
