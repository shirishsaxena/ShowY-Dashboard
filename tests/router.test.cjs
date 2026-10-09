"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");
const { send } = require("../lib/http");

function fixture({ view = true, edit = true } = {}) {
  let calls = 0;
  const handler = (req, res) => {
    calls++;
    send(res, 200, { ok: true });
  };
  const routes = {
    "GET /api/public": { access: "public", body: "none", handler },
    "GET /api/view": { access: "view", body: "none", handler },
    "PUT /api/edit": { access: "edit", body: "json", handler },
  };
  const module = { exports: {} };
  const filename = path.resolve(__dirname, "../http/router.js");
  const mocks = {
    "../routes/index": routes,
    "../lib/auth": {
      canView: () => view,
      isAuthenticated: () => edit,
    },
    "../lib/http": { send },
  };
  vm.runInNewContext(
    `(function(require, module) {\n${fs.readFileSync(filename, "utf8")}\n})`,
    {},
    { filename },
  )((name) => mocks[name], module);
  return {
    get calls() { return calls; },
    async request(pathname, method = "GET", contentType = "") {
      const res = {
        writeHead(status) { this.status = status; },
        end(body) { this.body = JSON.parse(body); },
      };
      await module.exports.handleApi({
        pathname,
        req: { method, headers: { "content-type": contentType } },
        res,
      });
      return { status: res.status, body: res.body };
    },
  };
}

test("router preserves public, view and edit authorization", async () => {
  const locked = fixture({ view: false, edit: false });
  assert.equal((await locked.request("/api/public")).status, 200);
  assert.deepEqual(await locked.request("/api/view"), {
    status: 401, body: { error: "Locked" },
  });
  assert.deepEqual(await locked.request("/api/edit", "PUT", "application/json"), {
    status: 401, body: { error: "Locked" },
  });
  assert.equal(locked.calls, 1);
  const readOnly = fixture({ edit: false });
  assert.equal((await readOnly.request("/api/view")).status, 200);
  assert.deepEqual(await readOnly.request("/api/edit", "PUT", "application/json"), {
    status: 401, body: { error: "Login required" },
  });
  assert.equal((await fixture().request("/api/edit", "PUT", "application/json; charset=utf-8")).status, 200);
});

test("router preserves content-type validation before matching and authorization", async () => {
  const router = fixture({ view: false });
  assert.equal((await router.request("/api/edit", "PUT")).status, 415);
  assert.equal((await router.request("/api/missing", "POST")).status, 415);
  assert.equal((await router.request("/api/missing", "HEAD")).status, 415);
  assert.equal((await router.request("/api/missing", "POST", "application/json")).status, 404);
  assert.equal((await router.request("/api/missing")).status, 404);
  assert.equal(router.calls, 0);
});

test("registry retains the complete API inventory and explicit policy", () => {
  const routes = require("../routes/index");
  const expected = {
    public: [
      "GET /api/auth",
      "POST /api/login",
      "POST /api/logout",
      "GET /api/peer",
      "GET /api/peer/info",
    ],
    view: [
      "GET /api/config",
      "GET /api/tunables",
      "GET /api/docker",
      "GET /api/docker/stats",
      "GET /api/stats",
      "GET /api/health",
      "GET /api/storage",
      "GET /api/info",
      "GET /api/info/settings",
      "GET /api/clip",
      "GET /api/icon",
      "GET /api/icons",
      "GET /api/availability",
      "GET /api/remotes/info",
      "GET /api/remotes",
    ],
    edit: [
      "PUT /api/tunables",
      "PUT /api/config",
      "PUT /api/info/settings",
      "PUT /api/clip",
      "DELETE /api/clip",
      "DELETE /api/clip/entry",
      "PUT /api/clip/settings",
      "DELETE /api/icons",
      "PUT /api/availability/settings",
      "DELETE /api/availability",
      "GET /api/remotes/settings",
      "PUT /api/remotes/settings",
      "PUT /api/share",
      "PUT /api/remotes/interval",
    ],
  };
  assert.deepEqual(Object.keys(routes).sort(), Object.values(expected).flat().sort());
  for (const [access, keys] of Object.entries(expected)) {
    for (const key of keys) {
      assert.equal(routes[key].access, access, key);
      assert.equal(routes[key].body, key.startsWith("GET ") ? "none" : "json", key);
      assert.equal(typeof routes[key].handler, "function", key);
    }
  }
});
