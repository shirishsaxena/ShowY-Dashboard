// Search results across all servers.

import { state, allServers } from "../state.js";
import { $, h, fill } from "../dom.js";
import { serviceCard } from "./cards.js";
import { renderLinks } from "./links.js";

export function renderSearch() {
  const q = state.query.toLowerCase();
  const results = [];
  for (const server of allServers()) {
    for (const svc of server.services) {
      const haystack = [
        svc.name,
        svc.description,
        svc.notes,
        svc.url,
        svc.altUrl,
        svc.container,
        svc.group,
        server.name,
      ]
        .join(" ")
        .toLowerCase();
      if (haystack.includes(q)) results.push({ svc, server });
    }
  }
  const links = state.config.settings.links.filter((l) =>
    `${l.name} ${l.type === "copy" ? "" : l.url}`.toLowerCase().includes(q),
  );
  const total = results.length + links.length;
  fill(
    $("#serverHead"),
    h(
      "div",
      { class: "info" },
      h("h2", {}, `Results for “${state.query}”`),
      h(
        "p",
        { class: "desc" },
        `${total} ${total === 1 ? "match" : "matches"}`,
      ),
    ),
  );
  fill(
    $("#services"),
    results.length
      ? h(
          "div",
          { class: "grid" },
          results.map(({ svc, server }) =>
            serviceCard(svc, server, { showServer: true }),
          ),
        )
      : null,
  );
  renderLinks(links);
  const empty = $("#empty");
  empty.hidden = total > 0;
  empty.textContent = "Nothing matches your search.";
  $("#unlisted").hidden = true;
  $("#stats").hidden = true;
}
