"use strict";

// Pure summaries of committed, sanitized JSON configs. Never render arbitrary
// values or property names: only display names and this fixed field vocabulary.
const SERVICE_FIELDS = {
  notes: "notes",
  icon: "icon",
  description: "description",
  container: "container",
  type: "service type",
};
const SERVER_FIELDS = {
  icon: "icon",
  mainUrl: "main URL",
  description: "description",
  location: "location",
  specs: "specifications",
  local: "local server",
};
const ACTION_FIELDS = {
  name: "name",
  type: "action type",
  url: "URL",
  text: "copy text",
  icon: "icon",
};
const SETTING_FIELDS = {
  title: "dashboard title",
  appName: "application name",
  accent: "accent color",
};

const array = (value) => (Array.isArray(value) ? value : []);
const object = (value) =>
  value && typeof value === "object" && !Array.isArray(value) ? value : {};
const unique = (value) => [...new Set(array(value))];
const ids = (items) => items.map((item) => item.id);
const index = (items) => new Map(items.map((item) => [item.id, item]));

// Object key order is not a configuration change; array order usually is.
function equal(a, b) {
  if (a === b) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length &&
    keys.every((key) => Object.hasOwn(b, key) && equal(a[key], b[key]))
  );
}

function bound(value, max) {
  if (value.length <= max) return value;
  // Do not leave half of an astral character at a truncation boundary.
  return `${value.slice(0, max - 1).replace(/[\uD800-\uDBFF]$/u, "")}…`;
}

function name(value, fallback = "Unnamed") {
  if (typeof value !== "string") return fallback;
  const clean = value
    .normalize("NFKC")
    .replace(/[\p{Cc}\p{Cf}\p{Cs}]/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
  return bound(clean || fallback, 72);
}

const quoted = (value) => `“${name(value)}”`;
const count = (number, noun) => `${number} ${noun}${number === 1 ? "" : "s"}`;
const serverContext = (server) => `Server: ${quoted(server.name)}.`;
const changed = (labels) =>
  labels.length ? ` Changed: ${labels.join(", ")}.` : "";

function fieldChanges(before, after, fields) {
  return Object.entries(fields)
    .filter(([key]) => !equal(before[key], after[key]))
    .map(([, label]) => label);
}

function otherChanges(before, after, known) {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys].some(
    (key) => !known.includes(key) && !equal(before[key], after[key]),
  );
}

// Adding/removing an item alone must not masquerade as a reorder.
function reordered(before, after) {
  const oldSet = new Set(before);
  const newSet = new Set(after);
  return !equal(
    before.filter((id) => newSet.has(id)),
    after.filter((id) => oldSet.has(id)),
  );
}

function servicesById(servers) {
  const result = new Map();
  for (const server of servers) {
    for (const service of array(server.services)) {
      result.set(service.id, { service, server });
    }
  }
  return result;
}

/**
 * @param {object} before Previously committed sanitized configuration.
 * @param {object} after Newly committed sanitized configuration.
 * @returns {Array<{title: string, message: string}>} At most 20 details plus
 * one overflow summary with the exact number of omitted semantic descriptors.
 * No IDs, URLs, notes, copy text, arbitrary keys, or non-name values are emitted.
 */
function describeConfigChanges(before, after) {
  before = object(before);
  after = object(after);
  if (equal(before, after)) return [];

  const result = [];
  let omitted = 0;
  function emit(title, message) {
    if (result.length < 20) {
      result.push({ title: bound(title, 200), message: bound(message, 400) });
    } else omitted++;
  }

  const oldServers = array(before.servers);
  const newServers = array(after.servers);
  const oldServerMap = index(oldServers);
  const newServerMap = index(newServers);
  const oldServices = servicesById(oldServers);
  const newServices = servicesById(newServers);
  // Group names have no IDs. Remember only strongly supported rename pairs to
  // avoid reporting every member as edited by the frontend's rename operation.
  const groupRenames = new Map();
  const deletedGroups = new Map();

  for (const server of oldServers) {
    if (!newServerMap.has(server.id)) {
      emit(
        `Server deleted: ${quoted(server.name)}`,
        `${count(array(server.services).length, "service")}, ${count(array(server.groups).length, "group")} in the removed server.`,
      );
    }
  }
  for (const server of newServers) {
    const old = oldServerMap.get(server.id);
    if (!old) {
      emit(
        `Server added: ${quoted(server.name)}`,
        `${count(array(server.services).length, "service")}, ${count(array(server.groups).length, "group")} in the added server.`,
      );
      continue;
    }
    const labels = fieldChanges(old, server, SERVER_FIELDS);
    if (
      otherChanges(old, server, [
        "id",
        "name",
        "groups",
        "services",
        ...Object.keys(SERVER_FIELDS),
      ])
    ) {
      labels.push("other server fields");
    }
    if (old.name !== server.name) {
      emit(
        `Server renamed: ${quoted(old.name)} → ${quoted(server.name)}`,
        `Server name changed.${changed(labels)}`,
      );
    } else if (labels.length) {
      emit(
        `Server updated: ${quoted(server.name)}`,
        `Changed: ${labels.join(", ")}.`,
      );
    }

    const oldGroups = unique(old.groups);
    const newGroups = unique(server.groups);
    const removed = oldGroups.filter((group) => !newGroups.includes(group));
    const added = newGroups.filter((group) => !oldGroups.includes(group));
    deletedGroups.set(server.id, new Set(removed));
    let rename = false;
    if (removed.length === 1 && added.length === 1) {
      const from = removed[0];
      const to = added[0];
      const oldMembers = array(old.services).filter(
        (svc) => svc.group === from,
      );
      const newMembers = array(server.services).filter(
        (svc) => svc.group === to,
      );
      // Same slot, otherwise unchanged group sequence, and exactly the same
      // members. Empty same-slot replacements are necessarily an inference.
      rename =
        equal(
          oldGroups.map((g) => (g === from ? to : g)),
          newGroups,
        ) &&
        oldMembers.length === newMembers.length &&
        oldMembers.every((svc) =>
          newMembers.some((next) => next.id === svc.id),
        );
      if (rename) {
        groupRenames.set(server.id, { from, to });
        emit(
          `Group renamed: ${quoted(from)} → ${quoted(to)}`,
          serverContext(server),
        );
      }
    }
    if (!rename) {
      for (const group of removed) {
        const ungrouped = array(server.services).filter(
          (svc) =>
            !svc.group &&
            oldServices.get(svc.id)?.server.id === server.id &&
            oldServices.get(svc.id)?.service.group === group,
        ).length;
        emit(
          `Group deleted: ${quoted(group)}`,
          serverContext(server) +
            (ungrouped
              ? ` ${count(ungrouped, "service")} moved to Ungrouped.`
              : ""),
        );
      }
      for (const group of added)
        emit(`Group added: ${quoted(group)}`, serverContext(server));
    }
    if (reordered(oldGroups, newGroups)) {
      emit("Groups reordered", serverContext(server));
    }
    if (reordered(ids(array(old.services)), ids(array(server.services)))) {
      emit("Services reordered", serverContext(server));
    }
  }
  if (reordered(ids(oldServers), ids(newServers))) {
    emit("Servers reordered", "Server order changed.");
  }

  for (const [id, { service, server }] of oldServices) {
    // Child deletions of deleted servers are covered by the parent count.
    if (!newServices.has(id) && newServerMap.has(server.id)) {
      emit(`Service deleted: ${quoted(service.name)}`, serverContext(server));
    }
  }
  for (const [id, { service, server }] of newServices) {
    const previous = oldServices.get(id);
    if (!previous) {
      // Likewise, a newly added server summarizes its new children.
      if (oldServerMap.has(server.id)) {
        emit(`Service added: ${quoted(service.name)}`, serverContext(server));
      }
      continue;
    }
    const old = previous.service;
    const moved = previous.server.id !== server.id;
    const renamed = old.name !== service.name;
    const labels = [];
    if (
      ["urls", "url", "altUrl"].some((key) => !equal(old[key], service[key]))
    ) {
      labels.push("URLs");
    }
    labels.push(...fieldChanges(old, service, SERVICE_FIELDS));
    const groupRename = groupRenames.get(server.id);
    const coveredGroupChange =
      !moved &&
      ((groupRename &&
        old.group === groupRename.from &&
        service.group === groupRename.to) ||
        (deletedGroups.get(server.id)?.has(old.group) && !service.group));
    if (old.group !== service.group && !coveredGroupChange)
      labels.push("group");
    if (
      otherChanges(old, service, [
        "id",
        "name",
        "group",
        "urls",
        "url",
        "altUrl",
        ...Object.keys(SERVICE_FIELDS),
      ])
    ) {
      labels.push("other service fields");
    }
    if (moved) {
      emit(
        `Service moved: ${quoted(service.name)}`,
        `From server: ${quoted(previous.server.name)}. To server: ${quoted(server.name)}.` +
          (renamed
            ? ` Renamed: ${quoted(old.name)} → ${quoted(service.name)}.`
            : "") +
          changed(labels),
      );
    } else if (renamed) {
      emit(
        `Service renamed: ${quoted(old.name)} → ${quoted(service.name)}`,
        serverContext(server) + changed(labels),
      );
    } else if (labels.length) {
      emit(
        `Service updated: ${quoted(service.name)}`,
        serverContext(server) + changed(labels),
      );
    }
  }

  const oldSettings = object(before.settings);
  const newSettings = object(after.settings);
  const oldFavorites = unique(oldSettings.favorites);
  const newFavorites = unique(newSettings.favorites);
  const serviceName = (id) =>
    newServices.get(id)?.service.name || oldServices.get(id)?.service.name;
  for (const id of oldFavorites) {
    if (!newFavorites.includes(id))
      emit(
        `Favorite removed: ${quoted(serviceName(id))}`,
        "Service removed from favorites.",
      );
  }
  for (const id of newFavorites) {
    if (!oldFavorites.includes(id))
      emit(
        `Favorite added: ${quoted(serviceName(id))}`,
        "Service added to favorites.",
      );
  }
  if (reordered(oldFavorites, newFavorites))
    emit("Favorites reordered", "Favorite service order changed.");

  const oldActions = array(oldSettings.links);
  const newActions = array(newSettings.links);
  const oldActionMap = index(oldActions);
  const newActionMap = index(newActions);
  for (const action of oldActions) {
    if (!newActionMap.has(action.id))
      emit(
        `Quick action deleted: ${quoted(action.name)}`,
        "Quick action removed.",
      );
  }
  for (const action of newActions) {
    const old = oldActionMap.get(action.id);
    if (!old) {
      emit(
        `Quick action added: ${quoted(action.name)}`,
        "Quick action created.",
      );
      continue;
    }
    const labels = fieldChanges(old, action, ACTION_FIELDS);
    if (otherChanges(old, action, ["id", ...Object.keys(ACTION_FIELDS)]))
      labels.push("other quick action fields");
    if (labels.length)
      emit(
        `Quick action updated: ${quoted(action.name)}`,
        `Changed: ${labels.join(", ")}.`,
      );
  }
  if (reordered(ids(oldActions), ids(newActions)))
    emit("Quick actions reordered", "Quick action order changed.");

  // Container identifiers are not needed for the summary and may be sensitive.
  const oldHidden = unique(oldSettings.hiddenContainers);
  const newHidden = unique(newSettings.hiddenContainers);
  const hidden = newHidden.filter((item) => !oldHidden.includes(item)).length;
  const shown = oldHidden.filter((item) => !newHidden.includes(item)).length;
  if (hidden)
    emit(
      hidden === 1 ? "Container hidden" : "Containers hidden",
      `${count(hidden, "container")} hidden from the dashboard.`,
    );
  if (shown)
    emit(
      shown === 1 ? "Container shown" : "Containers shown",
      `${count(shown, "container")} shown on the dashboard.`,
    );

  const settingsLabels = fieldChanges(oldSettings, newSettings, SETTING_FIELDS);
  if (
    otherChanges(oldSettings, newSettings, [
      "hiddenContainers",
      "favorites",
      "links",
      ...Object.keys(SETTING_FIELDS),
    ])
  ) {
    settingsLabels.push("other dashboard settings");
  }
  if (settingsLabels.length)
    emit(
      "Dashboard settings updated",
      `Changed: ${settingsLabels.join(", ")}.`,
    );
  if (otherChanges(before, after, ["servers", "settings"])) {
    emit("Configuration updated", "Changed: other configuration fields.");
  }
  // Covers unexpected structural differences without serializing their data.
  if (!result.length)
    emit("Configuration updated", "Changed: configuration structure.");
  if (omitted)
    result.push({
      title: "Additional configuration changes",
      message: `${count(omitted, "additional change")} omitted.`,
    });
  return result;
}

module.exports = { describeConfigChanges };
