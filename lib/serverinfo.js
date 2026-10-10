"use strict";
// Server information (System, Network, Docker) for the "Server info" panel.
// Only what is useful and harmless to show: no environment variables, MAC addresses, paths or secrets.
// Rarely changing values are cached; the public IP is only looked up when switched on in Settings.

const fs = require("fs");
const fsp = fs.promises;
const net = require("net");
const os = require("os");
const path = require("path");
const {
  SERVERINFO_FILE,
  DISKS_DIR,
  HOST_PROC,
  PUBLIC_IP_URL,
} = require("./env");
const { writeAtomic } = require("./config");
const { badRequest } = require("./http");
const { getDockerInfo } = require("./docker");

const MIN = 60_000;
const IN_DOCKER = fs.existsSync("/.dockerenv");
// Same idea as the host stats: inside Docker the container only sees its own network.
const HOST_NET = fs.existsSync(path.join(HOST_PROC, "1/net/fib_trie"))
  ? path.join(HOST_PROC, "1/net")
  : null;
const VIRTUAL_IFACE =
  /^(lo|docker|br-|veth|virbr|vnet|tun|tap|wg|tailscale|zt|cni|flannel|cali|kube|vethernet|loopback|vmware|virtualbox)/i;

const readText = (file) =>
  fsp.readFile(file, "utf8").then(
    (s) => s.trim(),
    () => "",
  );

/** Calls fn at most once per ttl; concurrent callers share one run. ttl may depend on the value. */
function memo(fn, ttl) {
  let expires = 0;
  let value;
  let pending = null;
  const get = () => {
    if (Date.now() < expires) return value;
    return (pending ||= fn()
      .then((v) => {
        value = v;
        expires = Date.now() + (typeof ttl === "function" ? ttl(v) : ttl);
        return v;
      })
      .finally(() => (pending = null)));
  };
  get.reset = () => (expires = 0);
  return get;
}

// ---------- Setting: how the public IP is found (off by default) ----------
// mode: 'off' | 'lookup' (ask an external service) | 'manual' (an address the user typed)

const MODES = ["off", "lookup", "manual"];
let settings = null;

async function getSettings() {
  if (settings) return settings;
  try {
    const file = JSON.parse(await fsp.readFile(SERVERINFO_FILE, "utf8"));
    if (!file || typeof file !== "object" || Array.isArray(file))
      throw new Error("Invalid serverinfo store");
    const mode = MODES.includes(file.mode)
      ? file.mode
      : file.publicIp === true
        ? "lookup"
        : "off"; // older files: { publicIp: true }
    const manualIp = net.isIP(String(file.manualIp || ""))
      ? String(file.manualIp)
      : "";
    settings = {
      mode: mode === "manual" && !manualIp ? "off" : mode,
      manualIp,
    };
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
    settings = { mode: "off", manualIp: "" };
  }
  return settings;
}

async function saveSettings(input) {
  const mode = input?.mode;
  if (!MODES.includes(mode))
    throw badRequest(`Mode must be ${MODES.join(" / ")}`);
  const typed = String(input.manualIp ?? "").trim();
  if (mode === "manual" && !net.isIP(typed))
    throw badRequest("Enter a valid IPv4 or IPv6 address");
  // The typed address is kept when switching away from manual, so it isn't lost.
  const current = await getSettings(); // Never overwrite an unreadable store.
  const next = {
    mode,
    manualIp: net.isIP(typed) ? typed : current.manualIp,
  };
  await writeAtomic(SERVERINFO_FILE, JSON.stringify(next));
  settings = next;
  publicLookup.reset();
  return next;
}

// ---------- System ----------

/** Host folders to read /etc files from: the mounted disks (inside Docker) or "/" itself. */
async function hostRoots() {
  if (!IN_DOCKER) return ["/"];
  try {
    return (await fsp.readdir(DISKS_DIR, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => path.join(DISKS_DIR, d.name));
  } catch {
    return [];
  }
}

async function readHostFile(rel) {
  for (const root of await hostRoots()) {
    const text = await readText(path.join(root, rel));
    if (text) return text;
  }
  return "";
}

function parseOsRelease(text) {
  const out = {};
  for (const line of text.split("\n")) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (m) out[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
  }
  return out;
}

const readStatic = memo(async () => {
  const cpus = os.cpus();
  const linux = process.platform === "linux";
  const release = linux
    ? parseOsRelease(await readHostFile("etc/os-release"))
    : {};
  const hostname = linux
    ? (await readHostFile("etc/hostname")) || (IN_DOCKER ? "" : os.hostname())
    : os.hostname();
  return {
    hostname,
    os: linux
      ? release.NAME || release.PRETTY_NAME || ""
      : os.version?.() || os.type(),
    osVersion: linux
      ? release.VERSION || release.VERSION_ID || ""
      : os.release(),
    kernel: linux ? os.release() : "",
    arch: os.arch(),
    cpuModel: (cpus[0]?.model || "").replace(/\s+/g, " ").trim(),
    cpuCores: cpus.length,
  };
}, 10 * MIN);

// ---------- Network ----------

const ipToInt = (ip) =>
  ip.split(".").reduce((n, part) => n * 256 + Number(part), 0);
const hexToInt = (hex) =>
  Number.parseInt(hex.match(/../g).reverse().join(""), 16); // /proc/net/route is little-endian

/** 10/8, 172.16/12, 192.168/16 and 100.64/10 (CGNAT, Tailscale-style). */
function isPrivate(ip) {
  const [a, b] = ip.split(".").map(Number);
  return (
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127)
  );
}

/** The host's addresses from its own /proc/net (inside Docker, via the mounted host /proc). */
async function readHostNetwork() {
  const [fib, routeText, inet6, dev] = await Promise.all(
    ["fib_trie", "route", "if_inet6", "dev"].map((f) =>
      readText(path.join(HOST_NET, f)),
    ),
  );

  // Which interface owns an address: the most specific connected route that contains it.
  const routes = routeText
    .split("\n")
    .slice(1)
    .map((line) => line.split(/\s+/))
    .filter(
      (f) =>
        f.length > 7 &&
        /^[0-9A-F]{8}$/i.test(f[1]) &&
        /^[0-9A-F]{8}$/i.test(f[7]),
    )
    .map((f) => ({ iface: f[0], dest: hexToInt(f[1]), mask: hexToInt(f[7]) }))
    .filter((r) => r.mask !== 0)
    .sort((a, b) => b.mask - a.mask);

  const addresses = new Set();
  let last = "";
  for (const line of fib.split("\n")) {
    const ip = /\|--\s+(\d+\.\d+\.\d+\.\d+)/.exec(line);
    if (ip) last = ip[1];
    else if (/\/32 host LOCAL/.test(line) && last) addresses.add(last);
  }
  const ipv4 = [...addresses]
    .filter((ip) => !ip.startsWith("127."))
    .map((address) => {
      const n = ipToInt(address);
      const route = routes.find((r) => (n & r.mask) >>> 0 === r.dest);
      return { address, iface: route?.iface || "" };
    })
    .filter((a) => a.iface && !VIRTUAL_IFACE.test(a.iface));

  const ipv6 = inet6
    .split("\n")
    .map((line) => line.split(/\s+/))
    .filter(
      (f) =>
        f.length >= 6 &&
        f[0].length === 32 &&
        f[3] === "00" &&
        !VIRTUAL_IFACE.test(f[5]),
    ) // scope 00 = global
    .map((f) => ({
      address: new URL(
        `http://[${f[0].match(/.{4}/g).join(":")}]`,
      ).hostname.slice(1, -1),
      iface: f[5],
    }));

  const interfaces = dev
    .split("\n")
    .slice(2)
    .map((line) => line.split(":")[0].trim())
    .filter((name) => name && !VIRTUAL_IFACE.test(name));
  return { ipv4, ipv6, interfaces };
}

function readLocalNetwork() {
  const ipv4 = [];
  const ipv6 = [];
  const interfaces = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    if (VIRTUAL_IFACE.test(name)) continue;
    let used = false;
    for (const a of list || []) {
      if (a.internal) continue;
      if (a.family === "IPv4" || a.family === 4) {
        if (!a.address.startsWith("169.254."))
          (ipv4.push({ address: a.address, iface: name }), (used = true));
      } else if (!/^fe80/i.test(a.address))
        (ipv6.push({ address: a.address, iface: name }), (used = true));
    }
    if (used) interfaces.push(name);
  }
  return { ipv4, ipv6, interfaces };
}

const readAddresses = memo(async () => {
  if (HOST_NET) return readHostNetwork();
  return IN_DOCKER ? null : readLocalNetwork(); // a container's own addresses would be misleading
}, MIN);

/** Plain-text IP from the lookup service. Only called when switched on; failures are retried after a few minutes. */
const publicLookup = memo(
  async () => {
    try {
      const res = await fetch(PUBLIC_IP_URL, {
        signal: AbortSignal.timeout(4000),
        redirect: "error",
        headers: { Accept: "text/plain" },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const ip = (await res.text()).trim().slice(0, 64);
      if (!net.isIP(ip)) throw new Error("Unexpected reply");
      return { ip, error: "" };
    } catch {
      return { ip: "", error: "Lookup failed" };
    }
  },
  (r) => (r.ip ? 60 * MIN : 5 * MIN),
);

async function readNetwork() {
  const [addresses, { mode, manualIp }] = await Promise.all([
    readAddresses(),
    getSettings(),
  ]);
  const lookup = mode === "lookup" ? await publicLookup() : null;
  if (!addresses && mode === "off") return null;
  const ipv4 = addresses?.ipv4 || [];
  // Without a typed or looked-up address, one on a real interface that isn't private is the public one (typical for a VPS).
  const onInterface = ipv4.find((a) => !isPrivate(a.address))?.address || "";
  const manual = mode === "manual" ? manualIp : "";
  const value = manual || lookup?.ip || onInterface;
  const source = manual
    ? "manual"
    : lookup?.ip
      ? "lookup"
      : onInterface
        ? "interface"
        : "";
  return {
    publicIp: {
      enabled: mode !== "off",
      mode,
      value,
      source,
      error: lookup?.error || "",
    },
    ipv4: ipv4.filter((a) => isPrivate(a.address)),
    ipv6: addresses?.ipv6 || [],
    interfaces: addresses?.interfaces || [],
  };
}

// ---------- Docker ----------

const readDocker = memo(getDockerInfo, 30_000);

// ---------- Summary ----------

async function getServerInfo() {
  const [system, network, docker] = await Promise.all([
    readStatic(),
    readNetwork(),
    readDocker(),
  ]);
  return {
    at: Date.now(),
    system: { ...system, uptime: os.uptime() },
    network,
    docker,
  };
}

// ---------- Info received from a remote dashboard: keep only the known fields, bounded ----------

const str = (v, n = 200) => (typeof v === "string" ? v.slice(0, n) : "");
const int = (v) =>
  Number.isFinite(Number(v)) && Number(v) >= 0 ? Math.round(Number(v)) : null;
const addrs = (list) =>
  Array.isArray(list)
    ? list
        .slice(0, 32)
        .map((a) => ({
          address: str(a?.address, 64),
          iface: str(a?.iface, 40),
        }))
    : [];

function sanitizeInfo(data) {
  const s = data?.system || {};
  const n = data?.network;
  const d = data?.docker;
  return {
    at: int(data?.at) || Date.now(),
    system: {
      hostname: str(s.hostname),
      os: str(s.os),
      osVersion: str(s.osVersion),
      kernel: str(s.kernel),
      arch: str(s.arch, 40),
      cpuModel: str(s.cpuModel),
      cpuCores: int(s.cpuCores),
      uptime: int(s.uptime),
    },
    network: n && {
      publicIp: {
        enabled: Boolean(n.publicIp?.enabled),
        mode: str(n.publicIp?.mode, 10),
        value: str(n.publicIp?.value, 64),
        source: str(n.publicIp?.source, 20),
        error: str(n.publicIp?.error),
      },
      ipv4: addrs(n.ipv4),
      ipv6: addrs(n.ipv6),
      interfaces: Array.isArray(n.interfaces)
        ? n.interfaces.slice(0, 32).map((i) => str(i, 40))
        : [],
    },
    docker: d && {
      available: Boolean(d.available),
      error: str(d.error),
      version: str(d.version, 40),
      apiVersion: str(d.apiVersion, 40),
      running: int(d.running),
      stopped: int(d.stopped),
      total: int(d.total),
      images: int(d.images),
      storageDriver: str(d.storageDriver, 40),
    },
  };
}

module.exports = { getServerInfo, getSettings, saveSettings, sanitizeInfo };
