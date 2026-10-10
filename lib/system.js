"use strict";
// Host stats: CPU, memory, disks, network, temperatures and fans (Linux /proc and /sys; partial elsewhere).

const fs = require("fs");
const fsp = fs.promises;
const os = require("os");
const path = require("path");
const { DISKS_DIR, HOST_PROC, HOST_STATS_INTERVAL } = require("./env");
const { getAvailability } = require("./availability");

const readText = (file) =>
  fsp.readFile(file, "utf8").then(
    (s) => s.trim(),
    () => "",
  );

// ---------- CPU & memory ----------

function cpuTimes() {
  let idle = 0;
  let total = 0;
  for (const cpu of os.cpus()) {
    for (const t of Object.values(cpu.times)) total += t;
    idle += cpu.times.idle;
  }
  return { idle, total };
}

let lastCpu = cpuTimes();

/** CPU usage since the previous collection, in percent (first: since module load).
 * HOST_STATS_INTERVAL is the browser polling preference, not a sampler timer.
 * Concurrent callers share work; staggered callers change the averaging window.
 * No completed-snapshot cache or background sampler is introduced here.
 */
function cpuPercent() {
  const now = cpuTimes();
  const dTotal = now.total - lastCpu.total;
  const dIdle = now.idle - lastCpu.idle;
  lastCpu = now;
  return dTotal > 0 ? Math.round((1 - dIdle / dTotal) * 1000) / 10 : 0;
}

async function readMemory() {
  const total = os.totalmem();
  if (process.platform === "linux") {
    const m = (await readText("/proc/meminfo")).match(/MemAvailable:\s+(\d+)/);
    if (m) return { total, used: total - Number(m[1]) * 1024 };
  }
  return { total, used: total - os.freemem() };
}

// ---------- Sensors ----------

/** Fallback CPU temperature from /sys/class/thermal when hwmon has no CPU chip. */
async function readThermalZone() {
  const base = "/sys/class/thermal";
  let zones;
  try {
    zones = (await fsp.readdir(base)).filter((z) =>
      z.startsWith("thermal_zone"),
    );
  } catch {
    return null;
  }
  let max = null;
  for (const zone of zones) {
    const [type, raw] = await Promise.all([
      readText(path.join(base, zone, "type")),
      readText(path.join(base, zone, "temp")),
    ]);
    const c = Number(raw) / 1000;
    if (!(c > 0)) continue;
    if (type === "x86_pkg_temp") return Math.round(c);
    max = Math.max(max ?? 0, c);
  }
  return max == null ? null : Math.round(max);
}

const CPU_CHIPS = new Set(["coretemp", "k10temp", "zenpower"]);
const DRIVE_CHIPS = new Set(["nvme", "drivetemp"]);
const CHIP_NAMES = {
  acpitz: "Motherboard (ACPI)",
  amdgpu: "GPU",
  nouveau: "GPU",
  iwlwifi: "Wi-Fi",
  pch: "Chipset",
};
const KIND_ORDER = { cpu: 0, disk: 1, other: 2 };

async function readChip(dir) {
  let files;
  try {
    files = await fsp.readdir(dir);
  } catch {
    return { temp: null, fans: [] };
  }
  const chip = await readText(path.join(dir, "name"));
  const model = (await readText(path.join(dir, "device", "model"))).replace(
    /\s+/g,
    " ",
  );
  const keysOf = (re) =>
    files.filter((f) => re.test(f)).map((f) => f.slice(0, -"_input".length));

  const inputs = (
    await Promise.all(
      keysOf(/^temp\d+_input$/).map(async (key) => ({
        label: await readText(path.join(dir, `${key}_label`)),
        temp: Number(await readText(path.join(dir, `${key}_input`))) / 1000,
      })),
    )
  ).filter((i) => i.temp > 0 && i.temp < 150);

  const fans = [];
  for (const key of keysOf(/^fan\d+_input$/)) {
    const raw = await readText(path.join(dir, `${key}_input`));
    if (raw !== "" && Number.isFinite(Number(raw))) {
      fans.push({
        name:
          (await readText(path.join(dir, `${key}_label`))) ||
          `Fan ${key.slice(3)}`,
        rpm: Number(raw),
      });
    }
  }
  if (!inputs.length) return { temp: null, fans };

  const hottest = inputs.reduce((a, b) => (b.temp > a.temp ? b : a));
  let temp;
  if (CPU_CHIPS.has(chip)) {
    const main =
      inputs.find((i) => /package|tctl|tdie/i.test(i.label)) || hottest;
    const cores = inputs.filter((i) => /^core/i.test(i.label));
    temp = {
      kind: "cpu",
      name: "CPU",
      temp: main.temp,
      detail: cores
        .map((c) => `${c.label} ${Math.round(c.temp)}°C`)
        .join(" · "),
    };
  } else if (DRIVE_CHIPS.has(chip)) {
    const main = inputs.find((i) => /composite/i.test(i.label)) || inputs[0];
    const nvme = chip === "nvme";
    temp = {
      kind: "disk",
      name: model || (nvme ? "NVMe SSD" : "Drive"),
      temp: main.temp,
      detail: nvme ? "NVMe" : "SATA",
    };
  } else {
    const name =
      CHIP_NAMES[chip] ||
      CHIP_NAMES[chip.replace(/_.*$/, "")] ||
      chip ||
      "Sensor";
    temp = { kind: "other", name, temp: hottest.temp, detail: hottest.label };
  }
  temp.temp = Math.round(temp.temp);
  return { temp, fans };
}

/**
 * Hardware sensors from /sys/class/hwmon: CPU (coretemp/k10temp), NVMe and SATA drives
 * (nvme / drivetemp - SATA needs the host's "drivetemp" kernel module), other chips and fans.
 */
async function readSensors() {
  const base = "/sys/class/hwmon";
  let dirs;
  try {
    dirs = await fsp.readdir(base);
  } catch {
    return { temps: [], fans: [] };
  }
  // Sorting by hwmon dir first keeps the "#2" suffixes stable between refreshes.
  dirs.sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
  const chips = await Promise.all(
    dirs.map((d) => readChip(path.join(base, d))),
  );

  const temps = chips.map((c) => c.temp).filter(Boolean);
  temps.sort(
    (a, b) =>
      KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.name.localeCompare(b.name),
  ); // stable sort
  const seen = {};
  for (const t of temps) {
    seen[t.name] = (seen[t.name] || 0) + 1;
    if (seen[t.name] > 1) t.name += ` #${seen[t.name]}`;
  }
  const fans = chips
    .flatMap((c) => c.fans)
    .sort((a, b) => a.name.localeCompare(b.name));
  return { temps, fans };
}

// ---------- Disks ----------

async function readDisks() {
  let entries = [];
  try {
    entries = (await fsp.readdir(DISKS_DIR, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => ({ label: d.name, dir: path.join(DISKS_DIR, d.name) }));
  } catch {
    /* no disks dir */
  }
  if (!entries.length)
    entries = [{ label: "System", dir: path.parse(process.cwd()).root }];
  const disks = await Promise.all(
    entries.map(async ({ label, dir }) => {
      try {
        const s = await fsp.statfs(dir);
        const total = s.blocks * s.bsize;
        return { label, total, used: total - s.bavail * s.bsize };
      } catch {
        return null;
      }
    }),
  );
  return disks.filter(Boolean);
}

// ---------- Network ----------

// Virtual interfaces (Docker bridges, veths, VPN tunnels...) would double count traffic.
const VIRTUAL_IFACE =
  /^(lo|docker|br-|veth|virbr|vnet|tun|tap|wg|tailscale|zt|cni|flannel|cali|kube)/;

/**
 * Inside Docker the container only sees its own network, so read the host's via the mounted
 * host /proc (process 1 = host init). Outside Docker, /proc/net/dev is already the host's.
 */
const NET_DEV = fs.existsSync(path.join(HOST_PROC, "1/net/dev"))
  ? path.join(HOST_PROC, "1/net/dev")
  : fs.existsSync("/.dockerenv")
    ? null
    : "/proc/net/dev";

async function readNetTotals() {
  if (!NET_DEV) return null;
  const text = await readText(NET_DEV);
  if (!text) return null;
  const totals = { rx: 0, tx: 0, ifaces: [], at: Date.now() };
  for (const line of text.split("\n").slice(2)) {
    const [name, rest] = line.split(":").map((s) => s.trim());
    if (!rest || VIRTUAL_IFACE.test(name)) continue;
    const f = rest.split(/\s+/).map(Number);
    if (!f[0] && !f[8]) continue; // never used
    totals.rx += f[0];
    totals.tx += f[8];
    totals.ifaces.push(name);
  }
  return totals;
}

let lastNet = null;
let lastNetResult = null;
readNetTotals().then((n) => (lastNet ??= n));

/** Bytes per second since the previous sample, plus totals since boot. */
async function readNetwork() {
  const now = await readNetTotals();
  if (!now) return null;
  // Several open dashboards poll at once: reuse a very recent reading instead of a noisy one.
  if (lastNetResult && now.at - lastNet.at < 2000) return lastNetResult;
  const prev = lastNet;
  lastNet = now;
  const secs = prev ? (now.at - prev.at) / 1000 : 0;
  const rate = (a, b) =>
    secs > 0 ? Math.max(0, Math.round((a - b) / secs)) : 0;
  lastNetResult = {
    rxRate: rate(now.rx, prev?.rx),
    txRate: rate(now.tx, prev?.tx),
    rx: now.rx,
    tx: now.tx,
    ifaces: now.ifaces,
  };
  return lastNetResult;
}

// ---------- Summary ----------

async function collectStats() {
  const cpus = os.cpus();
  const [mem, sensors, disks, net, availability] = await Promise.all([
    readMemory(),
    readSensors(),
    readDisks(),
    readNetwork(),
    getAvailability(),
  ]);
  if (!sensors.temps.some((t) => t.kind === "cpu")) {
    const temp = await readThermalZone();
    if (temp != null)
      sensors.temps.unshift({ kind: "cpu", name: "CPU", temp, detail: "" });
  }
  return {
    interval: HOST_STATS_INTERVAL,
    cpuModel: (cpus[0]?.model || "")
      .replace(/\((R|TM)\)|CPU|@.*$/g, "")
      .replace(/\s+/g, " ")
      .trim(),
    cores: cpus.length,
    cpu: cpuPercent(),
    load: os.loadavg().map((n) => Math.round(n * 100) / 100),
    mem,
    temps: sensors.temps,
    fans: sensors.fans,
    uptime: os.uptime(),
    disks,
    net,
    availability,
  };
}

let statsPending = null;

function getStats() {
  statsPending ||= collectStats().finally(() => (statsPending = null));
  return statsPending;
}

module.exports = { getStats };
