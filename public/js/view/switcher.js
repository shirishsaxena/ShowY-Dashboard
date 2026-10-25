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
  if (!allServers().some((server) => server.id === id)) return;
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

const spinner = () =>
  h("span", { class: "server-item-spinner", "aria-hidden": "true" });

function serverItem(server, active) {
  // Remote servers: marked with their dashboard's name, and not draggable (no data-id).
  const where = server.remote
    ? sourceOf(server).name
    : server.local
      ? "This machine"
      : server.location;
  const updating = server.remote && sourceOf(server).loading;
  const sub = [
    where,
    plural(server.services.length, "service"),
    updating && "Updating…",
  ]
    .filter(Boolean)
    .join(" · ");
  return h(
    "button",
    {
      type: "button",
      class: "server-item",
      "data-id": server.remote ? null : server.id,
      "data-switcher-key": `server:${server.id}`,
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
    updating ? spinner() : statusDot(server),
  );
}

function pendingItem(remote) {
  return h(
    "button",
    {
      type: "button",
      class: "server-item server-item-pending",
      disabled: true,
      "aria-busy": remote.loading ? "true" : null,
      "data-switcher-key": `remote:${remote.id}`,
    },
    h("span", { class: "ticon server-remote-icon" }, svg("globe")),
    h(
      "span",
      { class: "server-item-text" },
      h("span", { class: "server-item-name" }, remote.name),
      h(
        "span",
        { class: "server-item-sub" },
        remote.loading
          ? "Connecting to dashboard…"
          : "Unavailable · use Refresh to retry",
      ),
    ),
    remote.loading
      ? spinner()
      : h("span", { class: "dot down", title: remote.error || "Unavailable" }),
  );
}

function moveFocus(event, list) {
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
  const buttons = [...list.querySelectorAll("button")].filter(
    (button) => !button.disabled,
  );
  if (!buttons.length) return;
  const index = buttons.indexOf(document.activeElement);
  let next;
  if (event.key === "Home") next = 0;
  else if (event.key === "End") next = buttons.length - 1;
  else if (event.key === "ArrowDown") next = (index + 1) % buttons.length;
  else next = index <= 0 ? buttons.length - 1 : index - 1;
  event.preventDefault();
  buttons[next].focus();
}

export function renderSwitcher() {
  const { settings } = state.config;
  const servers = allServers();
  const active = activeServer();
  const btn = $("#serverBtn");
  // Discovery and slow peers never lock out the local/ready servers.
  btn.disabled =
    servers.length < 2 && !state.remotes.length && state.remotesReady;
  btn.classList.remove("busy");
  btn.title = btn.disabled ? "" : "Switch server";
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
        : h("img", { src: "/favicon.svg?v=ember-1", alt: "" }),
    );
  }

  const list = $("#serverList");
  const focusedKey = document.activeElement?.dataset?.switcherKey;
  const scrollTop = menu.scrollTop;
  const discovering = !state.remotesReady && !state.remotes.length;
  const pending = state.remotes.filter((remote) => remote.loading).length;
  const status = discovering
    ? "Discovering dashboards…"
    : state.remotesError
      ? "Remote status unavailable"
      : [plural(servers.length, "server"), pending && `${pending} loading`]
          .filter(Boolean)
          .join(" · ");
  const statusNode = $("#serverMenuStatus");
  if (statusNode.textContent !== status) statusNode.textContent = status;
  fill(
    list,
    state.config.servers.map((server) => serverItem(server, active)),
    state.remotes.flatMap((remote) =>
      remote.servers.length
        ? remote.servers.map((server) => serverItem(server, active))
        : [pendingItem(remote)],
    ),
    discovering
      ? h(
          "div",
          { class: "server-discovery" },
          spinner(),
          "Finding remote dashboards…",
        )
      : null,
  );
  // A peer completing must not steal keyboard focus or reset an open menu's scroll.
  if (focusedKey && menu.matches(":popover-open")) {
    const buttons = [...list.querySelectorAll("button")];
    const focused = buttons.find(
      (button) => button.dataset.switcherKey === focusedKey && !button.disabled,
    );
    (focused || buttons.find((button) => !button.disabled))?.focus({
      preventScroll: true,
    });
  }
  menu.scrollTop = scrollTop;
  menu.onkeydown = (event) => moveFocus(event, list);
  $("#serverHint").hidden = !state.editing;
}
