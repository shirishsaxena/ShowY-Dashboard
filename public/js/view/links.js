// Quick actions (router, ISP portal…): plain links without status checks, shown under the services on every page.

import { state } from "../state.js";
import { $, h, fill, svg, iconNode, dragHandle, external } from "../dom.js";
import { safeUrl } from "../utils.js";
import { openLinkEditor } from "../dialogs/link.js";
import { copyText } from "../clip.js";

/** Without an icon, try the site's own favicon (falls back to a letter if there is none). */
function iconFor(link) {
  if (link.icon) return link.icon;
  const url = safeUrl(link.url);
  return url ? `${new URL(url).origin}/favicon.ico` : "";
}

const isCopy = (link) => link.type === "copy";

function linkIcon(link) {
  if (isCopy(link) && !link.icon)
    return h(
      "span",
      { class: "ticon copy-icon", "aria-hidden": "true" },
      svg("copy"),
    );
  return iconNode(iconFor(link), link.name, "ticon");
}

function linkPill(link) {
  const inner = [
    state.editing ? dragHandle() : null,
    linkIcon(link),
    h("span", { class: "link-name" }, link.name),
  ];
  if (state.editing) {
    return h(
      "button",
      // A drag ends with a click on the handle - don't open the editor for that.
      {
        type: "button",
        class: "link-pill",
        "data-id": link.id,
        title: "Edit quick action",
        onclick: (e) =>
          !e.target.closest(".drag-handle") && openLinkEditor(link.id),
      },
      inner,
    );
  }
  if (isCopy(link))
    return h(
      "button",
      {
        type: "button",
        class: "link-pill",
        title: "Click to copy",
        onclick: () => copyText(link.text),
      },
      inner,
    );
  return h(
    "a",
    {
      class: "link-pill",
      href: safeUrl(link.url) || null,
      title: link.url,
      ...external,
    },
    inner,
  );
}

/** items = the links to show (search passes its matches). */
export function renderLinks(items = state.config.settings.links) {
  const section = $("#links");
  const editing = state.editing && !state.query;
  section.hidden = !items.length && !editing;
  if (section.hidden) return;
  fill(
    section,
    h("div", { class: "group-head" }, "Quick actions"),
    h(
      "div",
      { class: "link-list" },
      items.map(linkPill),
      editing
        ? h(
            "button",
            {
              type: "button",
              class: "link-pill add",
              onclick: () => openLinkEditor(),
            },
            svg("plus"),
            "Quick action",
          )
        : null,
    ),
  );
}
