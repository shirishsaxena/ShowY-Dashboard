// Full, unclamped service details without entering dashboard edit mode.
import { $, h, fill, iconNode, external, toast } from "../dom.js";
import { state, findServer } from "../state.js";
import { serviceUrls } from "../utils.js";
import { containerFor, serviceStatus, statusNode } from "../status.js";
import { usageNode } from "../view/usage.js";
import { ensureCanEdit } from "../actions.js";
import { openServiceEditor } from "./service.js";

let selected = null;

function lookup(selection) {
  const server = selection && findServer(selection.serverId);
  const service = server?.services.find((item) => item.id === selection.serviceId);
  return server?.local && !server.remote && service ? { server, service } : null;
}

const section = (title, content) => h("section", { class: "service-preview-section" },
  h("h3", {}, title), content);

export function openServicePreview(serverId, serviceId) {
  const selection = { serverId, serviceId };
  const found = lookup(selection);
  if (!found || state.locked) return toast("This service is no longer available. Refresh the dashboard.", true);
  selected = selection;
  const { server, service } = found;
  const container = containerFor(service, server);
  const status = serviceStatus(service, server);
  const urls = serviceUrls(service);
  $("#servicePreviewTitle").textContent = service.name;
  $("#servicePreviewServer").textContent = [server.name, service.group].filter(Boolean).join(" · ");
  fill($("#servicePreviewIcon"), iconNode(service.icon, service.name));
  const detail = (label, value) => value ? [h("dt", {}, label), h("dd", {}, String(value))] : [];
  fill($("#servicePreviewBody"),
    status ? statusNode(status) : null,
    section("Description", h("p", { class: "service-preview-text" }, service.description || "No description added.")),
    section("Container", h("dl", { class: "service-preview-details" },
      detail("Name", container?.name || service.container || "Not matched"),
      detail("Image", container?.image),
      detail("State", container?.status || container?.state || "Unavailable"),
      detail("ID", container?.id),
      detail("Published ports", container?.ports?.join(", ")))),
    container ? usageNode(container, server) : null,
    urls.length ? section("Links", h("div", { class: "service-preview-links" },
      urls.map(({ label, url }) => h("a", { href: url, ...external },
        h("strong", {}, label), h("span", {}, url))))) : null,
    service.notes ? section("Notes", h("p", { class: "service-preview-text" }, service.notes)) : null,
  );
  $("#servicePreviewEdit").disabled = false;
  const dialog = $("#servicePreviewDialog");
  if (!dialog.open) dialog.showModal();
}

export function initServicePreview() {
  const dialog = $("#servicePreviewDialog");
  const button = $("#servicePreviewEdit");
  button.addEventListener("click", async () => {
    if (button.disabled || !selected) return;
    const selection = selected;
    button.disabled = true;
    try {
      if (!(await ensureCanEdit()) || selected !== selection || !dialog.open || state.locked) return;
      if (!lookup(selection)) return toast("This service no longer exists on this server.", true);
      dialog.close();
      openServiceEditor(selection.serverId, selection.serviceId);
    } catch (err) {
      toast(err.message || "Could not open the service editor", true);
    } finally {
      if (selected === selection) button.disabled = false;
    }
  });
  dialog.addEventListener("close", () => {
    if (dialog.open) return;
    selected = null;
    fill($("#servicePreviewBody"));
    fill($("#servicePreviewIcon"));
    $("#servicePreviewTitle").textContent = "Service preview";
    $("#servicePreviewServer").textContent = "";
  });
}
