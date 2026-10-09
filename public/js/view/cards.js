// A single service card (used by groups and search).

import { state, isFavorite } from "../state.js";
import { h, svg, iconBtn, iconNode, dragHandle, external } from "../dom.js";
import { safeUrl, hostLabel, hostOf, primaryUrl } from "../utils.js";
import {
  serviceStatus,
  statusNode,
  hostPort,
  containerFor,
} from "../status.js";
import * as actions from "../actions.js";
import { openServiceEditor } from "../dialogs/service.js";
import { openQr } from "../dialogs/qr.js";
import { usageNode } from "./usage.js";
import { openNote } from "./notes.js";

function linkChips(svc, dupes) {
  const local = safeUrl(svc.url);
  const alt = safeUrl(svc.altUrl);
  const primary = primaryUrl(svc);
  const shared = dupes.has(hostPort(svc.url));
  const tools = state.editing
    ? []
    : [
        svc.notes
          ? iconBtn("note", "Notes", (e) => openNote(svc, e.currentTarget))
          : null,
        local || alt ? iconBtn("qr", "Show QR code", () => openQr(svc)) : null,
      ].filter(Boolean);
  return [
    local
      ? h(
          "a",
          {
            class: `chip${local === primary ? " primary-link" : ""}`,
            href: local,
            title: local,
            "aria-label": `Open local link: ${hostLabel(local)}`,
            ...external,
          },
          svg("home"),
          h("span", { class: "link-label" }, hostLabel(local)),
        )
      : null,
    alt
      ? h(
          "a",
          {
            class: `chip${alt === primary ? " primary-link" : ""}`,
            href: alt,
            title: alt,
            "aria-label": `Open alternate link: ${hostOf(alt)}`,
            ...external,
          },
          svg("globe"),
          h("span", { class: "link-label" }, hostOf(alt)),
        )
      : null,
    shared
      ? h(
          "span",
          {
            class: "chip amber",
            title: "Another service uses the same host:port",
          },
          svg("warn"),
          "port shared",
        )
      : null,
    tools.length ? [h("span", { class: "grow" }), tools] : null,
  ];
}

function editTools(svc, server) {
  const fav = isFavorite(svc.id);
  return h(
    "div",
    { class: "edit-tools" },
    iconBtn(
      "star",
      fav ? "Unpin from favourites" : "Pin to favourites",
      () => actions.toggleFavorite(svc.id),
      `icon-btn sm${fav ? " on" : ""}`,
    ),
    iconBtn("edit", "Edit", () => openServiceEditor(server.id, svc.id)),
    iconBtn(
      "trash",
      "Delete",
      () => actions.deleteService(server.id, svc.id),
      "icon-btn sm danger",
    ),
  );
}

export function serviceCard(
  svc,
  server,
  { showServer = false, dupes = new Set() } = {},
) {
  const editing = state.editing && !server.remote; // remote servers are read-only
  const href = primaryUrl(svc);
  const st = editing ? null : serviceStatus(svc, server);
  let cover = null;
  if (editing) {
    cover = h("button", {
      type: "button",
      class: "main-link",
      "aria-label": `Edit ${svc.name}`,
      onclick: () => openServiceEditor(server.id, svc.id),
    });
  } else if (href) {
    cover = h("a", {
      class: "main-link",
      href,
      "aria-label": `Open ${svc.name}`,
      ...external,
    });
  }

  const links = h("div", { class: "links" }, linkChips(svc, dupes));
  return h(
    "article",
    { class: "card", "data-id": svc.id, title: svc.description || null },
    cover,
    h(
      "div",
      { class: "top" },
      editing && !showServer ? dragHandle() : null,
      iconNode(svc.icon, svc.name),
      h(
        "div",
        { class: "text" },
        showServer ? h("div", { class: "server-tag" }, server.name) : null,
        h("h3", { class: "name" }, svc.name),
        svc.description
          ? h("p", { class: "description" }, svc.description)
          : null,
        st ? statusNode(st) : null,
      ),
      editing ? editTools(svc, server) : null,
    ),
    editing ? null : usageNode(containerFor(svc, server), server),
    links.childElementCount ? links : null,
  );
}
