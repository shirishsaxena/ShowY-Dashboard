// Server page: header with chips, host stats, grouped services and unlisted containers.

import { state, sourceOf, activeServer } from "../state.js";
import { $, h, fill, svg, iconNode, iconBtn, external } from "../dom.js";
import { safeUrl, fmtAgo } from "../utils.js";
import { serverCounts } from "../status.js";
import { openServerEditor } from "../dialogs/server.js";
import { openServerInfo } from "../dialogs/serverinfo.js";
import { renderStats } from "./stats.js";
import { renderGroups } from "./groups.js";
import { renderUnlisted } from "./containers.js";
import { renderLoading } from "./loading.js";

// A remote snapshot is stale after 3 refresh intervals (at least 30 s),
// regardless of whether another cached copy arrived in the meantime.
const staleMs = () => Math.max(30_000, state.remotesInterval * 3000);
const localStaleMs = () => state.tunables.localStale * 1000;

/** The age chip next to the server name: last successfully completed snapshot ("12 sec ago").
 *  level 'red' / 'amber' flag old data; for a remote server they also dim the page.
 *  level '' is the plain "all good" state. `since` + `label` let the text tick without a re-render. */
function staleness(server) {
  if (!server.remote) {
    if (!server.local || (!state.localAt && !state.localError)) return null;
    const old = Date.now() - state.localAt > localStaleMs();
    return {
      level: state.localError || old ? "amber" : "",
      label: state.localError ? "Refresh incomplete ·" : old ? "Stale ·" : "",
      since: state.localAt,
      local: true,
      dim: false,
      title:
        state.localError || "When the last successful dashboard refresh completed",
    };
  }
  const src = sourceOf(server);
  if (!src.ok)
    return {
      level: "red",
      label: "Unreachable · last seen",
      since: src.lastOk,
      dim: true,
      title: src.error || "",
    };
  const failed =
    state.loading?.stage === "failed" && state.loading.serverId === server.id;
  const since = src.lastOk || src.at;
  if (
    failed ||
    src.pollError ||
    src.refreshError ||
    Date.now() - since > staleMs()
  ) {
    return {
      level: "amber",
      label: src.refreshError ? "Refresh incomplete ·" : "Stale ·",
      since: src.refreshError ? src.lastOk : since,
      dim: true,
      title: failed
        ? state.loading.error
        : src.pollError ||
          src.refreshError ||
          "No recent update from this dashboard",
    };
  }
  return {
    level: "",
    label: "",
    since: src.lastOk || src.at,
    dim: false,
    title: "When the last complete snapshot was received from this dashboard",
  };
}

/** Re-write the age in every age chip (no re-render). This machine's chip follows state.localAt, which changes between renders. */
export function tickAgo() {
  const server = activeServer();
  for (const el of document.querySelectorAll("[data-since]"))
    if (server && el.dataset.ageServer === server.id) {
      const stale = staleness(server);
      if (!stale) continue;
      const chip = el.closest(".age");
      // Update just the chip, including threshold crossings; no fetch/full render.
      if (chip) {
        if (chip.classList.contains("red") !== (stale.level === "red"))
          chip.firstElementChild.replaceWith(
            svg(stale.level === "red" ? "warn" : "clock"),
          );
        chip.classList.toggle("amber", stale.level === "amber");
        chip.classList.toggle("red", stale.level === "red");
        chip.title = stale.title;
      }
      el.dataset.label = stale.label;
      el.dataset.since = stale.since || 0;
      el.textContent = agoText(stale.label, stale.since);
      if (!state.query) $("main").classList.toggle("stale", Boolean(stale.dim));
    } else {
      el.textContent = agoText(el.dataset.label || "", Number(el.dataset.since));
    }
}

const agoText = (label, since) =>
  since
    ? [label, fmtAgo(since)].filter(Boolean).join(" ")
    : label.replace(/\s*·.*$/, "") || "Waiting";

export function renderServer(server) {
  const empty = $("#empty");
  renderLoading();
  $("main").classList.remove("stale");
  if (state.loading?.blocking) {
    // Nothing known about this server yet: the loading panel is all there is (no default values).
    $("#serverHead").replaceChildren();
    $("#services").replaceChildren();
    $("#unlisted").hidden = true;
    $("#stats").hidden = true;
    empty.hidden = true;
    return;
  }
  if (!server) {
    $("#serverHead").replaceChildren();
    $("#services").replaceChildren();
    $("#unlisted").hidden = true;
    $("#stats").hidden = true;
    empty.hidden = false;
    empty.textContent = state.editing
      ? "Add your first server with the “+ Server” button, or import a backup from Settings below."
      : "Nothing here yet — click Edit to add a server or import a backup.";
    return;
  }
  renderServerHead(server);
  // Old data stays visible but is dimmed, with the warning in the heading.
  $("main").classList.toggle("stale", Boolean(staleness(server)?.dim));
  if (server.remote && state.editing) {
    // Remote servers are read-only here; they are edited on their own dashboard.
    $("#stats").hidden = true;
    $("#services").replaceChildren();
    $("#unlisted").hidden = true;
    empty.hidden = false;
    empty.textContent = `This server is shown from ${sourceOf(server).name} — make changes on that dashboard.`;
    return;
  }
  renderStats(server);
  renderGroups(server);
  renderUnlisted(server);
  empty.hidden = server.services.length > 0 || state.editing;
  const src = sourceOf(server);
  empty.textContent =
    server.remote && !src.ok
      ? `Could not reach ${src.name}: ${src.error || "no response"}`
      : "No services on this server yet.";
}

function renderServerHead(server) {
  const meta = h("div", { class: "meta" });
  if (server.location)
    meta.append(h("span", { class: "chip" }, svg("pin"), server.location));
  if (server.specs)
    meta.append(h("span", { class: "chip" }, svg("cpu"), server.specs));
  const main = safeUrl(server.mainUrl);
  if (main)
    meta.append(
      h(
        "a",
        { class: "chip", href: main, ...external },
        svg("external"),
        new URL(main).host,
      ),
    );

  const counts = serverCounts(server);
  if (counts.up)
    meta.append(
      h(
        "span",
        { class: "chip green" },
        h("span", { class: "dot" }),
        `${counts.up} online`,
      ),
    );
  if (counts.warn)
    meta.append(
      h(
        "span",
        { class: "chip amber" },
        h("span", { class: "dot" }),
        `${counts.warn} warning`,
      ),
    );
  if (counts.down)
    meta.append(
      h(
        "span",
        { class: "chip red" },
        h("span", { class: "dot" }),
        `${counts.down} offline`,
      ),
    );
  const src = sourceOf(server);
  const stale = staleness(server);
  if (!stale?.level && server.local && !src.docker.available) {
    meta.append(
      h(
        "span",
        { class: "chip amber", title: src.docker.error || "" },
        svg("warn"),
        "Docker unavailable",
      ),
    );
  }
  const remoteUrl = server.remote ? safeUrl(src.url) : "";
  const remoteChip = remoteUrl
    ? h(
        "a",
        {
          class: "chip",
          href: remoteUrl,
          title: `Shown from ${src.name} (read-only) — open it to make changes`,
          ...external,
        },
        svg("globe"),
        src.name,
      )
    : null;

  fill(
    $("#serverHead"),
    server.icon ? iconNode(server.icon, server.name, "icon server-icon") : null,
    h(
      "div",
      { class: "info" },
      h(
        "h2",
        {},
        server.name,
        server.local
          ? iconBtn(
              "info",
              "Server info",
              () => openServerInfo(server),
              "icon-btn sm info-btn",
            )
          : null,
        server.local && !server.remote
          ? h("span", { class: "chip" }, svg("home"), "This machine")
          : null,
        remoteChip,
        stale
          ? h(
              "span",
              { class: `chip age ${stale.level}`, title: stale.title },
              svg(stale.level === "red" ? "warn" : "clock"),
              h(
                "span",
                {
                  "data-since": stale.since || 0,
                  "data-label": stale.label,
                  "data-local": stale.local ? "1" : null,
                  "data-age-server": server.id,
                },
                agoText(stale.label, stale.since),
              ),
            )
          : null,
        state.editing && !server.remote
          ? h(
              "button",
              {
                type: "button",
                class: "btn sm",
                onclick: () => openServerEditor(server.id),
              },
              svg("edit"),
              "Edit server",
            )
          : null,
      ),
      server.description ? h("p", { class: "desc" }, server.description) : null,
      meta,
    ),
  );
}
