// Favourites bar (pinned services from any server).

import { state, findService } from "../state.js";
import { $, h, fill, iconBtn, iconNode, dragHandle, external } from "../dom.js";
import { primaryUrl } from "../utils.js";
import { serviceStatus } from "../status.js";
import * as actions from "../actions.js";

export function renderFavorites() {
  const section = $("#favs");
  const items = state.config.settings.favorites
    .map(findService)
    .filter(Boolean);
  section.hidden = !items.length || Boolean(state.query);
  if (!section.hidden)
    fill(
      section,
      items.map(({ svc, server }) => favoriteTile(svc, server)),
    );
}

function favoriteTile(svc, server) {
  const st = serviceStatus(svc, server);
  const inner = [
    state.editing ? dragHandle() : null,
    iconNode(svc.icon, svc.name),
    h("span", { class: "fav-name" }, svc.name),
    st ? h("span", { class: `dot ${st.level}`, title: st.label }) : null,
  ];
  if (state.editing) {
    return h(
      "div",
      { class: "fav", "data-id": svc.id },
      inner,
      iconBtn(
        "star",
        "Unpin",
        () => actions.toggleFavorite(svc.id),
        "icon-btn sm on",
      ),
    );
  }
  const href = primaryUrl(svc);
  const title = svc.description ? `${svc.name} — ${svc.description}` : svc.name;
  return href
    ? h("a", { class: "fav", href, title, ...external }, inner)
    : h("div", { class: "fav", title }, inner);
}
