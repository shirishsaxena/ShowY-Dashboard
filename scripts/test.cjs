"use strict";

// Explicit discovery without a package manifest, shell globs, or dependencies.
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
function discover(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) return discover(file);
    return entry.isFile() && entry.name.endsWith(".test.cjs") ? [file] : [];
  });
}

try {
  const files = discover(path.join(root, "tests")).sort();
  if (!files.length)
    throw new Error("No tests found under tests/**/*.test.cjs");
  const args = process.argv.slice(2);
  if (args.includes("--list")) {
    if (args.length !== 1) throw new Error("Use --list without runner options");
    for (const file of files)
      console.log(path.relative(root, file).split(path.sep).join("/"));
  } else {
    // Forward native runner options (reporters, coverage, name filters, etc.).
    const result = spawnSync(process.execPath, ["--test", ...args, ...files], {
      cwd: root,
      stdio: "inherit",
    });
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
  }
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
}
