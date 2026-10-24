// A single service card (used by groups and search).

import { state, isFavorite } from "../state.js";
import { h, svg, iconBtn, iconNode, dragHandle, external } from "../dom.js";
import { serviceUrls, monitoringUrl, primaryUrl } from "../utils.js";
import {
  serviceStatus,
  statusNode,
  hostPort,
  containerFor,
} from "../status.js";
import * as actions from "../actions.js";
import { openServiceEditor } from "../dialogs/service.js";
import { openServicePreview } from "../dialogs/service-preview.js";
import { openQr } from "../dialogs/qr.js";
import { usageNode } from "./usage.js";
import { openNote } from "./notes.js";
import { cardMenuButton, containerLogItem } from "./card-menu.js";
import { containerControlItems, containerOperationNode } from "../docker-control.js";

function linkChips(svc, dupes) {
  const urls = serviceUrls(svc);
  const primary = primaryUrl(svc);
  const shared = dupes.has(hostPort(monitoringUrl(svc)));
  const tools = state.editing
    ? []
    : [
        svc.notes
          ? iconBtn("note", "Notes", (e) => openNote(svc, e.currentTarget))
          : null,
        urls.length ? iconBtn("qr", "Show QR code", () => openQr(svc)) : null,
      ].filter(Boolean);
  return [
    ...urls.map(({ label, url }) => h(
      "a",
      {
        class: `chip${url === primary ? " primary-link" : ""}`,
        href: url,
        title: url,
        "aria-label": `Open ${label} link: ${url}`,
        ...external,
      },
      svg("globe"),
      h("span", { class: "link-label" }, label),
    )),
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
  const container = containerFor(svc, server);
  const localDocker = !server.remote && server.local && (svc.type === "docker" || container);
  const menu = cardMenuButton(svc.name, `service:${server.id}:${svc.id}`, () => [
        ...(localDocker ? [containerLogItem(container)] : []),
        { label: "Preview", icon: "eye", run: () => openServicePreview(server.id, svc.id) },
        ...(localDocker ? containerControlItems(container) : []),
      ]);
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
      menu,
    ),
    !server.remote && server.local ? containerOperationNode(container) : null,
    editing ? null : usageNode(container, server),
    links.childElementCount ? links : null,
  );
}
