'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const { SECURITY_HEADERS, HttpError, send } = require('../lib/http');

function createServerFixture() {
  let handler;
  let reads = 0;
  const publicDir = path.resolve(__dirname, '../public');
  const modules = {
    http: {
      createServer(callback) {
        handler = callback;
        return { listen() {} };
      },
    },
    fs: {
      promises: {
        async stat() {
          return { isFile: () => true, size: 42, mtimeMs: 1000 };
        },
        async readFile() {
          reads++;
          return Buffer.from('asset');
        },
      },
    },
    path,
    './lib/env': { PUBLIC_DIR: publicDir },
    './lib/http': { SECURITY_HEADERS, HttpError, send },
    './lib/auth': { async initAuth() {} },
    './lib/availability': { async init() {} },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8'), {
    require: (name) => modules[name] || {},
    process: { on() {} },
    console,
    URL,
  });
  return {
    get reads() { return reads; },
    async request(url, method = 'GET', headers = {}) {
      const response = {
        writeHead(status, responseHeaders) {
          this.status = status;
          this.headers = responseHeaders;
          this.headersSent = true;
        },
        end(body) { this.body = body; },
      };
      await handler({ url, method, headers }, response);
      return response;
    },
  };
}

test('malformed request URLs return 400 without breaking subsequent requests', async () => {
  const server = createServerFixture();
  assert.equal((await server.request('//[')).status, 400);
  assert.equal((await server.request('/app.css')).status, 200);
});

test('static HEAD and conditional GET avoid reading asset contents', async () => {
  const server = createServerFixture();
  const head = await server.request('/app.css', 'HEAD');
  assert.equal(head.status, 200);
  assert.equal(head.body, undefined);
  assert.equal(server.reads, 0);

  const conditional = await server.request('/app.css', 'GET', { 'if-none-match': head.headers.ETag });
  assert.equal(conditional.status, 304);
  assert.equal(server.reads, 0);

  const conditionalHead = await server.request('/app.css', 'HEAD', { 'if-none-match': head.headers.ETag });
  assert.equal(conditionalHead.status, 304);
  assert.equal(conditionalHead.body, undefined);
  assert.equal(server.reads, 0);

  const get = await server.request('/app.css');
  assert.equal(get.body.toString(), 'asset');
  assert.equal(get.headers.ETag, head.headers.ETag);
  assert.equal(server.reads, 1);
});
