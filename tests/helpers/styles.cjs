const fs = require("node:fs");
const path = require("node:path");

const publicDir = path.join(__dirname, "../../public");

function styleUrls() {
  const html = fs.readFileSync(path.join(publicDir, "index.html"), "utf8");
  return [...html.matchAll(/<link rel="stylesheet" href="([^"]+)"\s*\/>/g)]
    .map((match) => match[1]);
}

function readStyles() {
  return styleUrls()
    .map((url) => fs.readFileSync(path.join(publicDir, url.slice(1)), "utf8"))
    .join("");
}

module.exports = { styleUrls, readStyles };
