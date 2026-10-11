"use strict";

/** Canonical first URL wins, even when empty/invalid; never fall back to shadows. */
function monitoringUrl(svc) {
  const value = Object.hasOwn(svc, "urls")
    ? (Array.isArray(svc.urls) ? svc.urls[0]?.url : "")
    : svc.url || svc.altUrl;
  if (typeof value !== "string") return "";
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) ? value : "";
  } catch {
    return "";
  }
}

module.exports = { monitoringUrl };
