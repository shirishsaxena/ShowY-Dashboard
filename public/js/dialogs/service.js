// Add / edit service dialog.

import { state, findServer, isFavorite } from "../state.js";
import { $, h, fill } from "../dom.js";
import * as actions from "../actions.js";
import { field, value } from "./common.js";
import { iconPicker } from "./icon-picker.js";

let picker;

function updateGroupOptions() {
  const server = findServer(field($("#serviceForm"), "serverId").value);
  fill(
    $("#groupList"),
    (server?.groups || []).map((g) => h("option", { value: g })),
  );
}

export function openServiceEditor(serverId, svcId = null, preset = {}) {
  const form = $("#serviceForm");
  form.reset();
  const server = findServer(serverId);
  const svc = (svcId && server.services.find((s) => s.id === svcId)) || preset;
  form.dataset.serverId = serverId;
  form.dataset.svcId = svcId || "";
  $("#serviceDialogTitle").textContent = svcId ? "Edit service" : "Add service";
  $("#serviceDelete").hidden = !svcId;

  for (const key of [
    "name",
    "icon",
    "description",
    "notes",
    "url",
    "altUrl",
    "container",
    "group",
  ])
    field(form, key).value = svc[key] || "";
  field(form, "favorite").checked = Boolean(svcId) && isFavorite(svcId);
  const serverSelect = field(form, "serverId");
  fill(
    serverSelect,
    state.config.servers.map((s) => h("option", { value: s.id }, s.name)),
  );
  serverSelect.value = serverId;
  updateGroupOptions();
  fill(
    $("#containerList"),
    state.docker.containers.map((c) => h("option", { value: c.name }, c.image)),
  );

  picker.reset();
  $("#serviceDialog").showModal();
  if (!svcId && !preset.name) field(form, "name").focus();
}

export function initServiceForm() {
  const form = $("#serviceForm");
  picker = iconPicker(form, $("#serviceIconPreview"), $("#serviceIconSuggest"));
  field(form, "serverId").addEventListener("change", updateGroupOptions);

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const ok = await actions.saveService({
      fromServerId: form.dataset.serverId,
      toServerId: field(form, "serverId").value,
      svcId: form.dataset.svcId,
      pinned: field(form, "favorite").checked,
      fields: {
        name: value(form, "name"),
        icon: value(form, "icon"),
        description: value(form, "description"),
        notes: value(form, "notes"),
        url: value(form, "url"),
        altUrl: value(form, "altUrl"),
        container: value(form, "container"),
        group: value(form, "group"),
      },
    });
    if (ok) $("#serviceDialog").close();
  });

  $("#serviceDelete").addEventListener("click", async () => {
    const { serverId, svcId } = form.dataset;
    if (await actions.deleteService(serverId, svcId))
      $("#serviceDialog").close();
  });
}
