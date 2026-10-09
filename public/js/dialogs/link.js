// Add / edit quick action dialog: a link that opens a URL, or a text that is copied on click.

import { state } from "../state.js";
import { $ } from "../dom.js";
import * as actions from "../actions.js";
import { field, value } from "./common.js";
import { iconPicker } from "./icon-picker.js";

let picker;

const typeOf = (form) => field(form, "type").value;

/** Shows only the field that belongs to the chosen type. */
function syncType(form) {
  const copy = typeOf(form) === "copy";
  $("#linkUrlField").hidden = copy;
  $("#linkTextField").hidden = !copy;
  field(form, "url").required = !copy;
  field(form, "text").required = copy;
  $("#linkIconHint").textContent = copy
    ? "Leave blank to show a copy symbol."
    : "Leave blank to use the site's own icon.";
}

export function openLinkEditor(linkId = null) {
  const form = $("#linkForm");
  form.reset();
  const link =
    (linkId && state.config.settings.links.find((l) => l.id === linkId)) || {};
  form.dataset.linkId = linkId || "";
  $("#linkDialogTitle").textContent = linkId
    ? "Edit quick action"
    : "Add quick action";
  $("#linkDelete").hidden = !linkId;
  for (const key of ["name", "url", "text", "icon"])
    field(form, key).value = link[key] || "";
  field(form, "type").value = link.type === "copy" ? "copy" : "link";
  syncType(form);
  picker.reset();
  $("#linkDialog").showModal();
  if (!linkId) field(form, "name").focus();
}

export function initLinkForm() {
  const form = $("#linkForm");
  picker = iconPicker(form, $("#linkIconPreview"), $("#linkIconSuggest"));
  field(form, "type").addEventListener("change", () => syncType(form));

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const copy = typeOf(form) === "copy";
    const fields = {
      name: value(form, "name"),
      type: copy ? "copy" : "link",
      url: copy ? "" : value(form, "url"),
      text: copy ? field(form, "text").value : "", // kept exactly as typed (spaces and line breaks matter)
      icon: value(form, "icon"),
    };
    if (await actions.saveLink(form.dataset.linkId || null, fields))
      $("#linkDialog").close();
  });

  $("#linkDelete").addEventListener("click", async () => {
    if (await actions.deleteLink(form.dataset.linkId)) $("#linkDialog").close();
  });
}
