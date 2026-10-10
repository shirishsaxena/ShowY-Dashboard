// App state, per-device preferences (localStorage) and config helpers.

function readPref(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(`dash.${key}`)) ?? fallback;
  } catch {
    return fallback;
  }
}

export const prefs = {
  tab: readPref("tab", null),
  tabName: readPref("tabName", ""), // name of that server, to show while a remote one is still loading
  layout: readPref("layout", "cards"), // cards | compact | list
  theme: readPref("theme", "auto"), // auto | light | dark
  accent: readPref("accent", ""), // last known accent, applied before the config loads
  collapsed: new Set(readPref("collapsed", [])), // "serverId::group"
  unlistedOpen: readPref("unlistedOpen", true),
  clipSeen: readPref("clipSeen", 0), // updatedAt of the last shared clipboard this device has seen
};

export function setPref(key, value) {
  prefs[key] = value;
  try {
    localStorage.setItem(
      `dash.${key}`,
      JSON.stringify(value instanceof Set ? [...value] : value),
    );
  } catch {
    // Blocked or full storage must not prevent using preferences in this session.
  }
}

export const state = {
  config: normalizeConfig({}),
  configRevision: null,
  configSaving: 0,
  configEpoch: 0,
  auth: { passwordSet: false, lockView: false, authenticated: false },
  docker: { available: false, containers: [] },
  health: {}, // service id -> { state: 'up' | 'error' | 'down', code, ms, error }
  usage: { interval: 0, stats: {} }, // container name -> { cpu, mem, memLimit, rx, tx }
  stats: null,
  clip: { text: "", updatedAt: 0, entries: [], max: 10 }, // shared clipboard (text/updatedAt = newest entry)
  // Other dashboards: { id, name, url, ok, error, servers, docker, usage, stats, health } (read-only)
  remotes: [],
  remotesReady: false, // the first remotes request ended (until then the server switcher shows a loading bar)
  remotesInterval: 10, // seconds between remote updates (the server tells us: Settings / REMOTE_REFRESH_INTERVAL)
  localAt: 0, // last successfully completed local dashboard refresh (shown as the age chip)
  localError: "", // required data failed; does not change localAt
  remotesError: "", // polling this dashboard's remote directory failed
  tunables: {
    localDashboardRefresh: 30,
    healthRefresh: 60,
    localStale: 90,
    remoteTimeout: 60,
    loadTimeout: 75,
  }, // seconds; the server sends the real ones (Settings / docker-compose)
  version: "", // server version, from /api/config
  activeId: prefs.tab,
  // While the selected server's data first loads (see loading.js): { kind: 'remote' | 'local', serverId, remoteId, name,
  // stage, progress (0-1 or null = unknown), error, blocking (nothing to show yet, so a panel replaces the page) } or null.
  loading: null,
  query: "",
  editing: false,
  showHidden: false,
  locked: false,
};

/** Fill in fields that older or hand-edited config files may miss. */
export function normalizeConfig(cfg) {
  const settings = {
    title: "Home Lab",
    accent: "",
    hiddenContainers: [],
    favorites: [],
    links: [],
    ...cfg.settings,
  };
  const servers = (cfg.servers || []).map((server) => {
    const services = (server.services || []).map((svc) => ({
      group: "",
      ...svc,
    }));
    const groups = [
      ...new Set(
        [...(server.groups || []), ...services.map((s) => s.group)].filter(
          Boolean,
        ),
      ),
    ];
    return { ...server, groups, services };
  });
  return { settings, servers };
}

/** This dashboard's servers, then the ones shown from remote dashboards. */
export const allServers = () => [
  ...state.config.servers,
  ...state.remotes.flatMap((r) => r.servers),
];

/** Where a server's live data (Docker, usage, host stats, health) comes from: here or its remote dashboard. */
export const sourceOf = (server) =>
  (server?.remote && state.remotes.find((r) => r.id === server.remote)) ||
  state;

/** The selected server tab (falls back to the first server). */
export function activeServer() {
  // A remote server picked before its dashboard answered: not the first server in its place.
  if (state.loading?.kind === "remote" && state.loading.blocking) return null;
  const servers = allServers();
  return servers.find((s) => s.id === state.activeId) || servers[0] || null;
}

export const findServer = (id) =>
  state.config.servers.find((s) => s.id === id) || null;

export function findService(svcId) {
  for (const server of state.config.servers) {
    const svc = server.services.find((s) => s.id === svcId);
    if (svc) return { svc, server };
  }
  return null;
}

export const isFavorite = (svcId) =>
  state.config.settings.favorites.includes(svcId);
