// Explicit presentation of the backend's sanitized, single-container snapshot.
import { h } from "../dom.js";
import { fmtBytes, fmtUptime } from "../utils.js";

const section = (title, content) => h("section", { class: "service-preview-section" }, h("h3", {}, title), content);
const row = (label, value) => value !== undefined && value !== null && value !== ""
  ? [h("dt", {}, label), h("dd", {}, String(value))] : [];
const list = (...rows) => h("dl", { class: "service-preview-details" }, rows);
const date = (value) => value && !value.startsWith("0001-") && Number.isFinite(Date.parse(value))
  ? new Date(value).toLocaleString() : "—";
const bytes = (value) => value == null ? "Unavailable" : fmtBytes(value);
const tile = (label, value) => h("div", { class: "preview-metric" }, h("span", {}, label), h("strong", {}, value));

export function containerDetailsNode(snapshot) {
  const c = snapshot.container;
  const u = snapshot.usage;
  const uptime = c.state === "running" && Number.isFinite(Date.parse(c.startedAt))
    ? fmtUptime(Math.max(0, (snapshot.fetchedAt - Date.parse(c.startedAt)) / 1000)) : "—";
  return h("div", { class: "preview-docker-details" },
    section("Container usage", u ? [
      h("div", { class: "preview-metrics" },
        tile("CPU · share of host", `${u.cpu}%`),
        tile("RAM · excluding cache", bytes(u.mem)),
        tile("Memory usage", u.memoryPercent == null ? "Unavailable" : `${u.memoryPercent}%`),
        tile("Memory ceiling", u.memLimit ? fmtBytes(u.memLimit) : "Unavailable"),
        tile("Network received · total", bytes(u.rx)), tile("Network sent · total", bytes(u.tx)),
        tile("Disk read · total", bytes(u.blockRead)), tile("Disk written · total", bytes(u.blockWrite)),
        tile("Processes / threads", u.pids ?? "Unavailable")),
      h("small", { class: "muted" }, "Network and disk values are cumulative counters, not transfer speeds. Without an explicit memory limit, the ceiling normally reflects host memory."),
    ] : h("p", { class: "service-preview-text muted" }, snapshot.usageError || "Usage unavailable")),
    section("Container details", list(
      row("Name", c.name), row("Image", c.image), row("Image ID", c.imageId), row("Container ID", c.id),
      row("State", c.state), row("Health", c.health), row("Health failures", c.failingStreak),
      row("Uptime", uptime), row("Created", date(c.createdAt)), row("Started", date(c.startedAt)), row("Finished", date(c.finishedAt)),
      row("Restart count", c.restartCount), row("Exit code", c.exitCode), row("OOM killed", c.oomKilled ? "Yes" : "No"),
      row("Hostname", c.hostname), row("User", c.user),
      row("Compose project", c.composeProject), row("Compose service", c.composeService))),
    section("Configuration", list(
      row("Restart policy", c.restartPolicy), row("Maximum retries", c.maximumRetryCount),
      row("Memory limit", c.memoryLimit ? fmtBytes(c.memoryLimit) : "Not explicitly set"),
      row("CPU limit", c.cpuLimit ? `${c.cpuLimit} cores` : "Not explicitly set"),
      row("CPU shares", c.cpuShares || "Default"), row("CPU set", c.cpuSet || "Any"),
      row("Privileged", c.privileged ? "Yes" : "No"), row("Read-only filesystem", c.readOnlyRootfs ? "Yes" : "No"),
      row("Runtime", c.runtime), row("Network mode", c.networkMode), row("Log driver", c.logDriver))),
    c.ports?.length ? section("Ports", list(c.ports.map((port) => row(port.container,
      port.host ? `${port.address || "All interfaces"} → ${port.host}` : "Exposed, not published")))) : null,
    c.networks?.length ? section("Networks", c.networks.map((network) => h("div", { class: "preview-detail-group" },
      h("strong", {}, network.name), list(row("IPv4", network.address), row("IPv6", network.ipv6), row("Gateway", network.gateway), row("MAC", network.mac))))) : null,
    c.mounts?.length ? section("Mounts · container destinations", list(c.mounts.map((mount) => row(mount.destination,
      `${mount.type} · ${mount.writable ? "read/write" : "read-only"}`)))) : null,
    h("small", { class: "muted" }, "Environment variables, commands, arbitrary labels, host mount sources, and health-check output are intentionally excluded."),
  );
}
