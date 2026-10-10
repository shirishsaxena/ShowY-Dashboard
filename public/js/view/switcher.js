// Server switcher: the brand (icon + name) in the top bar opens a list of servers (drag to reorder in edit mode).

import {
  state,
  setPref,
  activeServer,
  allServers,
  sourceOf,
} from "../state.js";
import { $, h, fill, svg, iconNode, dragHandle } from "../dom.js";
import { plural } from "../utils.js";
import { serverCounts } from "../status.js";
import { render } from "./render.js";
import { startLoad } from "../loading.js";

function selectServer(id) {
  $("#serverMenu").hidePopover();
  state.activeId = id;
  setPref("tab", id);
  setPref("tabName", allServers().find((s) => s.id === id)?.name || "");
  state.query = "";
  $("#search").value = "";
  startLoad(); // cancels the previous server's load; a remote server shows its loading state at once
  render();
}

function statusDot(server) {
  const src = sourceOf(server);
  if (server.remote && !src.ok)
    return h("span", {
      class: "dot down",
      title: `Unreachable${src.error ? ` (${src.error})` : ""}`,
    });
  const { up, warn, down } = serverCounts(server);
  const level = down ? "down" : warn ? "warn" : up ? "up" : "";
  const title = [
    up && `${up} online`,
    warn && `${warn} warning`,
    down && `${down} offline`,
  ]
    .filter(Boolean)
    .join(" · ");
  return h("span", { class: `dot ${level}`, title: title || null });
}

function serverItem(server, active) {
  // Remote servers: marked with their dashboard's name, and not draggable (no data-id).
  const where = server.remote
    ? sourceOf(server).name
    : server.local
      ? "This machine"
      : server.location;
  const sub = [where, plural(server.services.length, "service")]
    .filter(Boolean)
    .join(" · ");
  return h(
    "button",
    {
      type: "button",
      class: "server-item",
      "data-id": server.remote ? null : server.id,
      "aria-current": server === active ? "true" : null,
      // A drag ends with a click on the handle - don't treat it as picking the server.
      onclick: (e) =>
        !e.target.closest(".drag-handle") && selectServer(server.id),
    },
    state.editing && !server.remote ? dragHandle() : null,
    iconNode(server.icon, server.name, "ticon"),
    h(
      "span",
      { class: "server-item-text" },
      h("span", { class: "server-item-name" }, server.name),
      h(
        "span",
        { class: "server-item-sub" },
        server.remote ? svg("globe") : null,
        sub,
      ),
    ),
    statusDot(server),
  );
}

export function renderSwitcher() {
  const { settings } = state.config;
  const servers = allServers();
  const active = activeServer();
  const btn = $("#serverBtn");
  // The brand shows the current server; it only opens the list when there is another server to pick.
  btn.disabled = servers.length < 2;
  // Other dashboards' servers are still being fetched: show a loading bar until the first answer.
  btn.classList.toggle("busy", !state.remotesReady);
  btn.title = !state.remotesReady
    ? "Loading other servers…"
    : btn.disabled
      ? ""
      : "Switch server";
  const menu = $("#serverMenu");
  if (btn.disabled && menu.matches(":popover-open")) menu.hidePopover();

  $("#title").textContent =
    active?.name || state.loading?.name || settings.title;
  // Only swap the icon when it changes, so the image doesn't flicker on every status refresh.
  const box = $("#brandIcon");
  const key = active ? `${active.icon}|${active.name}` : "";
  if (box.dataset.key !== key) {
    box.dataset.key = key;
    fill(
      box,
      active
        ? iconNode(active.icon, active.name, "ticon")
        : h("img", { src: "/favicon.svg", alt: "" }),
    );
  }

  fill(
    $("#serverList"),
    servers.map((server) => serverItem(server, active)),
  );
  $("#serverHint").hidden = !state.editing;
}
