// Full service previews. Direct Docker reads are strictly local and per-container.
import { $, h, fill, iconNode, external, toast } from "../dom.js";
import { state, allServers, sourceOf } from "../state.js";
import { serviceUrls, hostOf } from "../utils.js";
import { containerFor, serviceStatus, statusNode } from "../status.js";
import { usageNode } from "../view/usage.js";
import { containerDetailsNode } from "../view/container-details.js";
import { ensureCanEdit } from "../actions.js";
import { editApi } from "../edit-api.js";
import { openServiceEditor } from "./service.js";

let selected = null;
let pending = null;
const fullId = (id) => /^[a-f0-9]{64}$/.test(id || "");

function lookup(selection) {
  const server = selection && allServers().find((item) => item.id === selection.serverId);
  if (!server) return null;
  if (selection.discovered) {
    if (!server.local || server.remote) return null;
    const container = state.docker.containers.find((item) => selection.containerId
      ? item.id === selection.containerId : item.name === selection.containerName);
    if (!container) return null;
    const host = hostOf(server.mainUrl) || location.hostname;
    const service = { name: container.name, type: "docker", container: container.name,
      icon: container.image.split("/").pop().split(/[:@]/)[0],
      urls: container.ports.map((port) => ({ label: `Port ${port}`, url: `http://${host}:${port}` })) };
    return { server, service, container };
  }
  const service = server.services.find((item) => item.id === selection.serviceId);
  return service ? { server, service, container: containerFor(service, server) } : null;
}

const section = (title, content) => h("section", { class: "service-preview-section" }, h("h3", {}, title), content);
const detail = (label, value) => value !== undefined && value !== null && value !== ""
  ? [h("dt", {}, label), h("dd", {}, String(value))] : [];

async function refreshContainer() {
  const selection = selected;
  if (!selection?.dockerId || !$("#servicePreviewDialog").open || pending) return;
  const found = lookup(selection);
  if (!found || !found.server.local || found.server.remote || state.locked) return;
  const controller = new AbortController();
  pending = controller;
  const current = () => selected === selection && pending === controller && $("#servicePreviewDialog").open && !state.locked;
  const refresh = $("#servicePreviewRefresh");
  const feedback = $("#servicePreviewFeedback");
  const output = $("#servicePreviewDocker");
  refresh.disabled = true;
  refresh.classList.add("spin");
  feedback.textContent = "Refreshing this container’s details and usage…";
  output.setAttribute("aria-busy", "true");
  try {
    const result = await editApi("GET", `/api/docker/details?id=${encodeURIComponent(selection.dockerId)}`,
      undefined, { signal: controller.signal, current, timeout: 16000 });
    if (!current()) return;
    if (!result) {
      feedback.textContent = "Container refresh cancelled.";
      return;
    }
    const { res, data } = result;
    if (!res.ok) throw new Error(data.error || "Container details unavailable");
    if (data.container?.id !== selection.dockerId || !Number.isFinite(data.fetchedAt))
      throw new Error("Invalid container preview response");
    fill(output, containerDetailsNode(data));
    selection.fetchedAt = data.fetchedAt;
    feedback.textContent = `Updated ${new Date(data.fetchedAt).toLocaleTimeString()} · This container only${data.usageError ? " · Usage unavailable" : ""}`;
  } catch (err) {
    if (!current()) return;
    feedback.textContent = `${err instanceof TypeError ? "Dashboard server unreachable" : err.message}${selection.fetchedAt ? ` · Showing snapshot from ${new Date(selection.fetchedAt).toLocaleTimeString()}` : ""}`;
  } finally {
    if (pending === controller) {
      pending = null;
      refresh.disabled = false;
      refresh.classList.remove("spin");
      output.setAttribute("aria-busy", "false");
    }
  }
}

function openPreview(selection) {
  const found = lookup(selection);
  if (!found || state.locked) return toast("This service is no longer available. Refresh the dashboard.", true);
  pending?.abort();
  pending = null;
  selected = selection;
  const { server, service, container } = found;
  const docker = service.type === "docker" || Boolean(container);
  const localDocker = docker && server.local && !server.remote;
  selection.dockerId = localDocker && fullId(container?.id) ? container.id : "";
  const status = selection.discovered ? null : serviceStatus(service, server);
  const urls = serviceUrls(service);
  const health = service.type !== "bookmark" && !selection.discovered ? sourceOf(server).health?.[service.id] : null;
  $("#servicePreviewTitle").textContent = service.name;
  $("#servicePreviewServer").textContent = [server.name, service.group, server.remote ? "Remote · read-only" : ""].filter(Boolean).join(" · ");
  fill($("#servicePreviewIcon"), iconNode(service.icon, service.name));
  fill($("#servicePreviewBody"),
    status ? statusNode(status) : null,
    section("Description", h("p", { class: "service-preview-text" }, service.description || "No description added.")),
    section("Service", h("dl", { class: "service-preview-details" },
      detail("Type", service.type || "Legacy (automatic matching)"), detail("Server", server.name),
      detail("Group", service.group || "Ungrouped"),
      detail("Monitoring", service.type === "bookmark" ? "Not monitored" : docker ? "Docker container state" : "HTTP reachability"),
      detail("HTTP state", health?.state), detail("HTTP status", health?.code),
      detail("Response time", health?.ms != null ? `${health.ms} ms` : ""))),
    urls.length ? section("Links", h("div", { class: "service-preview-links" },
      urls.map(({ label, url }) => h("a", { href: url, ...external }, h("strong", {}, label), h("span", {}, url))))) : null,
    service.notes ? section("Notes", h("p", { class: "service-preview-text" }, service.notes)) : null,
  );
  const output = $("#servicePreviewDocker");
  output.hidden = !docker;
  output.setAttribute("aria-busy", "false");
  fill(output, docker ? [
    section("Container", h("dl", { class: "service-preview-details" },
      detail("Name", container?.name || service.container || "Not matched"), detail("Image", container?.image),
      detail("State", container?.status || container?.state || "Unavailable"), detail("ID", container?.id),
      detail("Published ports", container?.ports?.join(", ")))),
    container ? usageNode(container, server) : null,
  ] : []);
  $("#servicePreviewFeedback").textContent = !docker ? "" : server.remote
    ? "Remote dashboard snapshot. Direct container refresh is available on the originating dashboard."
    : !selection.dockerId ? "Container details unavailable. Match a local container and refresh the dashboard." : "";
  const refresh = $("#servicePreviewRefresh");
  refresh.hidden = !localDocker;
  refresh.disabled = !selection.dockerId;
  refresh.classList.remove("spin");
  const edit = $("#servicePreviewEdit");
  edit.hidden = Boolean(server.remote);
  edit.disabled = false;
  edit.textContent = selection.discovered ? "Add to dashboard" : "Edit service";
  const dialog = $("#servicePreviewDialog");
  if (!dialog.open) dialog.showModal();
  return refreshContainer();
}

export function openServicePreview(serverId, serviceId) {
  return openPreview({ serverId, serviceId });
}

export function openContainerPreview(serverId, container) {
  return openPreview({ serverId, discovered: true, containerId: container.id, containerName: container.name });
}

export function initServicePreview() {
  const dialog = $("#servicePreviewDialog");
  const button = $("#servicePreviewEdit");
  $("#servicePreviewRefresh").addEventListener("click", refreshContainer);
  button.addEventListener("click", async () => {
    if (button.disabled || !selected) return;
    const selection = selected;
    button.disabled = true;
    try {
      if (!(await ensureCanEdit()) || selected !== selection || !dialog.open || state.locked) return;
      const found = lookup(selection);
      if (!found || found.server.remote) return toast("This service is no longer editable on this server.", true);
      dialog.close();
      if (selection.discovered) openServiceEditor(selection.serverId, null, {
        type: "docker", name: found.service.name, container: found.container.name,
        icon: found.service.icon, url: serviceUrls(found.service)[0]?.url || "",
      });
      else openServiceEditor(selection.serverId, selection.serviceId);
    } catch (err) {
      toast(err.message || "Could not open the service editor", true);
    } finally {
      if (selected === selection) button.disabled = false;
    }
  });
  dialog.addEventListener("close", () => {
    if (dialog.open) return;
    pending?.abort();
    pending = null;
    selected = null;
    for (const id of ["#servicePreviewBody", "#servicePreviewDocker", "#servicePreviewIcon"]) fill($(id));
    $("#servicePreviewTitle").textContent = "Service preview";
    $("#servicePreviewServer").textContent = "";
    $("#servicePreviewFeedback").textContent = "";
  });
}
