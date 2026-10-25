"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "showy-runner-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "scripts"));
  fs.mkdirSync(path.join(root, "tests", "nested"), { recursive: true });
  const script = path.join(root, "scripts", "test.cjs");
  fs.copyFileSync(path.join(__dirname, "..", "scripts", "test.cjs"), script);
  return {
    write(name, source) {
      fs.writeFileSync(path.join(root, "tests", name), source);
    },
    run(...args) {
      // Simulate an independent CLI invocation, not a recursive runner child.
      const env = { ...process.env };
      delete env.NODE_TEST_CONTEXT;
      return spawnSync(process.execPath, [script, ...args], {
        cwd: os.tmpdir(),
        env,
        encoding: "utf8",
        timeout: 10000,
      });
    },
  };
}

test("canonical runner lists nested test files deterministically from another directory", (t) => {
  const f = fixture(t);
  f.write("z.test.cjs", "");
  f.write("nested/a.test.cjs", "");
  f.write("helper.cjs", 'throw new Error("helpers are not tests")');
  const result = f.run("--list");
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.trim().split(/\r?\n/), [
    "tests/nested/a.test.cjs",
    "tests/z.test.cjs",
  ]);
});

test("canonical runner executes every discovered file and forwards TAP reporting", (t) => {
  const f = fixture(t);
  f.write("z.test.cjs", 'require("node:test")("root case", () => {});');
  f.write(
    "nested/a.test.cjs",
    'require("node:test")("nested case", () => {});',
  );
  f.write("helper.cjs", 'throw new Error("helpers are not tests")');
  const result = f.run("--test-reporter=tap");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /TAP version 13/);
  assert.match(result.stdout, /# tests 2\b/);
  assert.match(result.stdout, /# pass 2\b/);
  assert.match(result.stdout, /root case/);
  assert.match(result.stdout, /nested case/);
});

test("canonical runner exits nonzero for a failing test", (t) => {
  const f = fixture(t);
  f.write(
    "failure.test.cjs",
    'require("node:test")("fails", () => { throw new Error("expected failure"); });',
  );
  const result = f.run("--test-reporter=tap");
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /# fail 1\b/);
});

test("canonical runner rejects an empty suite rather than reporting success", (t) => {
  const result = fixture(t).run();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /No tests found/);
});

test("canonical runner does not silently discard options in list mode", (t) => {
  const f = fixture(t);
  f.write("a.test.cjs", "");
  const result = f.run("--list", "--test-reporter=tap");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Use --list without runner options/);
});
