// Add / edit service dialog.

import { state, findServer, isFavorite } from "../state.js";
import { $, h, fill } from "../dom.js";
import * as actions from "../actions.js";
import { field, value, pendingForm } from "./common.js";
import { iconPicker } from "./icon-picker.js";
import { safeUrl } from "../utils.js";

let picker;
let urlRows = [];

function readUrlRows() {
  return urlRows.map(({ label, url }) => ({ label: label.value.trim(), url: url.value.trim() }));
}

function renderUrlRows(entries) {
  const form = $("#serviceForm");
  urlRows = (entries.length ? entries : [{ label: "", url: "" }]).map((entry, index) => {
    const label = h("input", { type: "text", maxlength: 60, value: entry.label || "",
      placeholder: "Local, Public, Admin…", oninput: updateTypeFields });
    const url = h("input", { type: "url", maxlength: 2000, value: entry.url || "",
      placeholder: "https://example.com", "aria-describedby": "serviceUrlsHelp", oninput: updateTypeFields });
    const primary = h("button", {
      type: "button", class: "btn", disabled: index === 0,
      "aria-label": index === 0 ? `URL ${index + 1} is primary` : `Make URL ${index + 1} primary`,
      onclick: () => {
        if (form.dataset.saving) return;
        const rows = readUrlRows();
        rows.unshift(...rows.splice(index, 1));
        renderUrlRows(rows);
        urlRows[0].url.focus();
      },
    }, index === 0 ? "Primary" : "Make primary");
    const remove = h("button", {
      type: "button", class: "btn", "aria-label": `Remove URL ${index + 1}`,
      onclick: () => {
        if (form.dataset.saving) return;
        const rows = readUrlRows();
        rows.splice(index, 1);
        renderUrlRows(rows);
        urlRows[Math.min(index, urlRows.length - 1)].url.focus();
      },
    }, "Remove URL");
    const node = h("div", { class: "service-url-row" },
      h("label", { class: "field" }, `URL ${index + 1} label`, label),
      h("label", { class: "field" }, `URL ${index + 1}`, url),
      h("div", { class: "service-url-actions" }, primary, remove));
    return { label, url, node };
  });
  fill($("#serviceUrls"), urlRows.map(({ node }) => node));
  $("#serviceAddUrl").disabled = urlRows.length >= 50;
  updateTypeFields();
}

function updateTypeFields() {
  const form = $("#serviceForm");
  const type = field(form, "type").value;
  const docker = type === "docker";
  const legacy = type === "";
  const needsUrl = type === "web" || type === "bookmark";
  field(form, "type").setCustomValidity(
    ["", "docker", "web", "bookmark"].includes(type) ? "" : "Choose a supported service type.",
  );
  $("#serviceTypeHelp").textContent = {
    docker: "Explicit Docker container required on a server marked This machine. URLs are optional; HTTP cannot replace missing Docker state.",
    web: "At least one HTTP(S) URL required. Checked from the dashboard server, never matched to Docker.",
    bookmark: "At least one HTTP(S) URL required. Saved link only: no health checks or Docker monitoring.",
    "": "Legacy: existing automatic Docker matching and HTTP fallback remain unchanged until you choose a type.",
  }[type] || "Unsupported type. Choose a supported service type to save.";
  const container = field(form, "container");
  $("#serviceContainerField").hidden = !docker && !legacy;
  container.disabled = !docker && !legacy;
  container.required = docker;
  container.placeholder = docker ? "Exact container name" : "Auto-match by port or name";
  container.setCustomValidity(docker && !container.value.trim() ? "Enter an explicit container name." : "");
  $("#serviceContainerHelp").textContent = docker
    ? "Explicit name only; no automatic port or service-name fallback."
    : "Only used on servers marked This machine. Leave blank to auto-match.";
  const hasUrl = urlRows.some(({ url }) => url.value.trim());
  for (const [index, { label, url }] of urlRows.entries()) {
    const labelText = label.value.trim();
    const urlText = url.value.trim();
    label.required = Boolean(urlText);
    url.required = Boolean(labelText) || (needsUrl && !hasUrl && index === 0);
    label.setCustomValidity(labelText.length > 60 ? "Use at most 60 characters for the label."
      : urlText && !labelText ? "Enter a label for this URL." : "");
    url.setCustomValidity(urlText && (!safeUrl(urlText) || urlText.length > 2000)
      ? "Use an HTTP(S) URL of at most 2000 characters."
      : labelText && !urlText ? "Enter a URL or remove this row." : "");
  }
}

function updateGroupOptions() {
  const server = findServer(field($("#serviceForm"), "serverId").value);
  fill(
    $("#groupList"),
    (server?.groups || []).map((g) => h("option", { value: g })),
  );
}

export function openServiceEditor(serverId, svcId = null, preset = {}) {
  const form = $("#serviceForm");
  if (form.dataset.saving) return;
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
    "container",
    "group",
  ])
    field(form, key).value = svc[key] || "";
  const legacy = Boolean(svcId) && !Object.hasOwn(svc, "type");
  const type = field(form, "type");
  const selected = legacy ? "" : Object.hasOwn(svc, "type") ? svc.type : "web";
  const options = [["docker", "Docker"], ["web", "Web"], ["bookmark", "Bookmark"]];
  if (legacy) options.unshift(["", "Legacy (unchanged)"]);
  const unsupported = !legacy && !options.some(([key]) => key === selected);
  if (unsupported) options.unshift(["unsupported", "Unsupported type — choose a type"]);
  fill(type, options.map(([key, label]) => h("option", { value: key }, label)));
  type.value = unsupported ? "unsupported" : selected;
  const entries = Object.hasOwn(svc, "urls")
    ? (Array.isArray(svc.urls) ? svc.urls.map((entry) => ({ label: entry?.label, url: entry?.url })) : [])
    : [{ label: "Local", url: svc.url }, { label: "Public", url: svc.altUrl }].filter((entry) => entry.url);
  renderUrlRows(entries);
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
  field(form, "type").addEventListener("change", updateTypeFields);
  field(form, "container").addEventListener("input", updateTypeFields);
  $("#serviceAddUrl").addEventListener("click", () => {
    if (form.dataset.saving || urlRows.length >= 50) return;
    renderUrlRows([...readUrlRows(), { label: "", url: "" }]);
    urlRows.at(-1).label.focus();
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (form.dataset.saving) return;
    updateTypeFields();
    if (!form.reportValidity()) return;
    // Only entirely blank rows are omitted. Partial rows must be corrected above.
    const urls = readUrlRows().filter(({ label, url }) => label || url);
    await pendingForm(form, async () => {
      const ok = await actions.saveService({
        fromServerId: form.dataset.serverId,
        toServerId: field(form, "serverId").value,
        svcId: form.dataset.svcId,
        pinned: field(form, "favorite").checked,
        fields: {
          ...(value(form, "type") ? { type: value(form, "type") } : {}),
          name: value(form, "name"),
          icon: value(form, "icon"),
          description: value(form, "description"),
          notes: value(form, "notes"),
          urls,
          url: urls[0]?.url || "",
          altUrl: urls[1]?.url || "",
          container: field(form, "container").disabled ? "" : value(form, "container"),
          group: value(form, "group"),
        },
      });
      if (ok) $("#serviceDialog").close();
    });
  });

  $("#serviceDelete").addEventListener("click", async () => {
    await pendingForm(form, async () => {
      const { serverId, svcId } = form.dataset;
      if (await actions.deleteService(serverId, svcId))
        $("#serviceDialog").close();
    });
  });
}
