"use strict";

/** Parse once without adding application fields to the native request. */
function createContext(req, res) {
  const url = new URL(req.url, "http://localhost");
  const query = url.searchParams;
  const fresh = query.get("fresh") === "1";
  return { req, res, url, pathname: url.pathname, query, fresh };
}

module.exports = { createContext };
