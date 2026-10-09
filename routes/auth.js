"use strict";

const auth = require("../lib/auth");

module.exports = {
  "GET /api/auth": {
    access: "public",
    body: "none",
    handler: (req) => auth.authStatus(req),
  },
  "POST /api/login": {
    access: "public",
    body: "json",
    handler: auth.handleLogin,
  },
  "POST /api/logout": {
    access: "public",
    body: "json",
    handler: auth.handleLogout,
  },
};
