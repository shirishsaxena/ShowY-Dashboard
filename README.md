<div align="center">

# ShowY Dashboard

**Your homelab, at a glance.**

A lightweight, self-hosted dashboard for organizing services, monitoring Docker containers, and keeping an eye on multiple servers — all from one place.

![Node.js](https://img.shields.io/badge/Node.js-18%2B-339933?logo=nodedotjs&logoColor=white) [![Docker](https://img.shields.io/badge/GHCR-Docker%20Image-2496ED?logo=docker&logoColor=white)](https://github.com/shirishsaxena/ShowY-Dashboard/pkgs/container/showy-dashboard) ![No dependencies](https://img.shields.io/badge/npm_dependencies-0-brightgreen) ![Self-hosted](https://img.shields.io/badge/Self--hosted-Yes-blue)

</div>

![ShowY Dashboard overview](screenshots/dashboard.png)

ShowY Dashboard uses Node.js with a plain HTML/CSS/JavaScript frontend—**no database, frontend build step, or npm packages**. Manage services in your browser; settings and history are stored in local JSON files.

## Screenshots

Click a preview to view the full-size screenshot.

<table>
  <tr>
    <td align="center" width="25%">
      <a href="screenshots/server-monitoring.png"><img src="screenshots/server-monitoring.png" alt="Server monitoring and Docker containers" width="180"></a><br>
      <sub>Server monitoring</sub>
    </td>
    <td align="center" width="25%">
      <a href="screenshots/remote-dashboards.png"><img src="screenshots/remote-dashboards.png" alt="Remote dashboards" width="180"></a><br>
      <sub>Remote dashboards</sub>
    </td>
    <td align="center" width="25%">
      <a href="screenshots/shared-clipboard.png"><img src="screenshots/shared-clipboard.png" alt="Shared clipboard" width="180"></a><br>
      <sub>Shared clipboard</sub>
    </td>
    <td align="center" width="25%">
      <a href="screenshots/settings.png"><img src="screenshots/settings.png" alt="Settings and customization" width="180"></a><br>
      <sub>Settings</sub>
    </td>
  </tr>
</table>

## Features

| Area | What you get |
| --- | --- |
| **Service directory** | Icons, descriptions, local and alternate URLs, groups, drag-and-drop sorting, favorites, and notes |
| **Health checks** | Server-side HTTP checks; 404 and 5xx responses are errors, connection failures are down, and other HTTP responses count as reachable |
| **Docker integration** | Automatic container matching, state, CPU/memory/network usage, and a list of containers not yet on the dashboard |
| **Server stats** | CPU, RAM, disks, uptime, network speed/history, temperatures, and fans |
| **Server information** | Hostname, OS, kernel, CPU, IP addresses, network interfaces, and Docker engine details |
| **Remote dashboards** | Read-only views of other dashboard instances, with configurable refresh and stale/unreachable indicators |
| **Outage tracking** | Estimated 24-hour, 7-day, and 30-day availability plus outage history |
| **Shared clipboard** | Text/link sharing between devices, persistent history, configurable entry count, and copy/delete actions |
| **Quick actions** | Open a saved link or copy saved text with one click |
| **Customization** | Card, compact, and list layouts; auto/light/dark themes; accent colors; searchable icons and icon caching |
| **Convenience** | Search (`/` shortcut), QR codes, PWA installation, JSON export/import, and optional password protection |
| **Backend logging** | Configurable severity, console output, rotating persistent files, and authorized download/clear actions in Settings |

Icons can come from [dashboard-icons](https://github.com/homarr-labs/dashboard-icons), an emoji, or a custom image URL. Saved icons are cached locally for faster loading.

## Quick start (Docker)

**Requirements:** Linux and Docker; Docker Compose is optional for the direct command below. Use the [prebuilt Docker image](https://github.com/shirishsaxena/ShowY-Dashboard/pkgs/container/showy-dashboard)—no repository clone, package installation, or local build is needed.

### Docker CLI

Run these commands from the directory where you want to keep your dashboard data:

```bash
mkdir -p showy-dashboard && cd showy-dashboard
docker pull ghcr.io/shirishsaxena/showy-dashboard:latest
docker run -d \
  --name showy-dashboard \
  --restart unless-stopped \
  -p 8011:8080 \
  -v "$(pwd)/data:/data" \
  -v /var/run/docker.sock:/var/run/docker.sock:ro \
  -v /:/disks/System:ro \
  -v /proc:/host/proc:ro \
  ghcr.io/shirishsaxena/showy-dashboard:latest
```

Open **http://YOUR-SERVER-IP:8011**, select **Edit**, add a server, mark the local host as **This machine**, and add services. Configuration, history, and backend logs persist in `./data`.

This command starts without a password and is intended for a trusted LAN only. For password protection, export `DASHBOARD_PASSWORD` in your shell and add `-e DASHBOARD_PASSWORD` before the image name; view locking defaults to enabled. Public access also requires HTTPS and firewall protection as described below. Docker socket access remains privileged even with a read-only mount.

To update a CLI installation, pull the image again, run `docker stop showy-dashboard` followed by `docker rm showy-dashboard`, then repeat the run command from the same directory with the same volume and environment options. Do not delete `./data`. Use either this method or Compose, not both with the same container name.

### Docker Compose

For a declarative deployment managed with Docker Compose:

1. Create a directory for your dashboard and a `compose.yaml` file:

   ```bash
   mkdir -p showy-dashboard && cd showy-dashboard
   nano compose.yaml
   ```

2. Add the following configuration:

   ```yaml
   services:
     dashboard:
       image: ghcr.io/shirishsaxena/showy-dashboard:latest
       container_name: showy-dashboard
       restart: unless-stopped
       ports:
         - "8011:8080"
       environment:
         TZ: Asia/Kolkata
         # DASHBOARD_PASSWORD: "set-a-strong-password"
       volumes:
         - ./data:/data
         - /var/run/docker.sock:/var/run/docker.sock:ro
         - /:/disks/System:ro
         - /proc:/host/proc:ro
   ```

3. Pull and start the dashboard:

   ```bash
   docker compose up -d
   ```

4. Open **`http://YOUR-SERVER-IP:8011`**. Select **Edit**, add a server, mark the local host as **This machine**, and add services manually or from **Not on dashboard**.

Your configuration is stored in `./data` and persists across container updates. Adjust the published port, password, and disk mounts for your setup. **Docker socket access is privileged even when mounted `:ro`**; deploy only on trusted hosts and protect access to the dashboard.

### Update

To pull the latest published image and recreate the container if needed:

```bash
docker compose pull
docker compose up -d
```

### Use a specific version

Replace `:latest` in `compose.yaml` with a numbered image tag, such as `:1.6.0`. Numbered tags are useful for predictable deployments and rollbacks. See [GitHub Releases](https://github.com/shirishsaxena/ShowY-Dashboard/releases) for published versions.

### Build from source (optional)

If you want to modify the dashboard or build locally:

```bash
git clone https://github.com/shirishsaxena/ShowY-Dashboard.git
cd ShowY-Dashboard
docker compose up -d --build
```

The repository's `docker-compose.yml` builds the Node.js 22 Alpine image locally. Its service is **showy-dashboard**, container name is **showy-dashy**, and published port is **8080** (unlike port 8011 in the prebuilt example above). Open **http://YOUR-SERVER-IP:8080**. The repository stack limits the container to 128 MiB RAM and 0.5 CPU.

To update a source-built installation, run `git pull` followed by `docker compose up -d --build`. Persistent data stays in `./data`; back it up before upgrades.

### Additional disk monitoring

Add read-only disk mounts under `volumes` in your Compose file (`compose.yaml` for the prebuilt image), for example:

```yaml
volumes:
  - /mnt/hdd:/disks/HDD:ro
```

For SATA HDD/SSD temperatures on Linux, load the host's `drivetemp` module:

```bash
echo drivetemp | sudo tee /etc/modules-load.d/drivetemp.conf
sudo modprobe drivetemp
```

## Public deployment (HTTPS)

The application serves HTTP only. No VPS Compose file, reverse-proxy configuration, or `.env.example` is included. Supply your own HTTPS reverse proxy (for example, Caddy or Nginx), DNS, certificates, and firewall rules.

- Set a strong dashboard password and retain full-view locking.
- If the proxy runs on the host, bind the published port to loopback, for example `127.0.0.1:8080:8080`, rather than exposing it directly.
- Forward `X-Forwarded-Proto: https` so session cookies are marked Secure.
- Only enable `TRUST_PROXY` when direct backend access is blocked and the proxy supplies trustworthy `X-Forwarded-For` headers. The backend uses the last forwarded address for login rate limiting.

With the repository Compose file, set the password under `environment`, or replace its empty literal with `DASHBOARD_PASSWORD: "${DASHBOARD_PASSWORD:-}"` and create a private `.env` containing your password. Compose reads `.env` for substitution; it does **not** automatically pass all its variables into the container. Do not commit credentials. The application itself does not load `.env` files.

## Connect multiple dashboards

Install an instance on each machine. Each instance monitors its own host and services; a main dashboard can display other instances as read-only remote servers.

1. On the remote instance, go to **Edit → Settings → Share this dashboard → Turn on**, then copy its share token.
2. On your main instance, go to **Settings → Remote dashboards** and add the remote URL and token.
3. Select the remote machine from the server switcher to see its services, host stats, and Docker usage.

Remote information is fetched server-to-server. The remote must be reachable from the dashboard server (for example, over your LAN or a VPN). **Use HTTPS across the public internet** to protect tokens in transit. Remote refresh defaults to 10 seconds; Settings offers 5, 10, 15, 30, or 60 seconds. Disconnected remotes retain their last known server/service directory, but live stats, usage, health, and availability are cleared rather than presented as current. Share tokens authorize the peer APIs independently of dashboard login, grant read access only, and are not forwarded to the browser as part of remote data.

Alternatively, define remotes in your Compose environment:

```yaml
environment:
  SHARE_TOKEN: "replace-with-a-random-token-at-least-16-characters"
  REMOTE_DASHBOARDS: |
    VPS | https://dash.example.com | token-of-the-vps
    NAS | http://192.168.1.20:8011 | token-of-the-nas
```

You can generate a token with `openssl rand -hex 24`. Environment-defined remotes appear as fixed entries in Settings; UI-defined remotes are kept alongside them.

## Outage tracking

ShowY Dashboard records a heartbeat for its own machine every **1, 5, or 10 minutes** (default: 5 minutes; tracking enabled by default). On startup and delayed heartbeats, it checks gaps against a **5, 10, 15, or 30-minute** threshold (default: 10 minutes). The effective threshold is at least one minute longer than the heartbeat interval. History retains up to 500 outages.

- If the host rebooted, the gap is recorded as a host outage.
- If the host stayed up but the dashboard stopped, the gap is recorded separately and **does not count as host downtime**.
- Late heartbeats caused by a suspended or paused host can also register as outages.

The dashboard reports estimated availability over **24 hours, 7 days, and 30 days** based on the period actually monitored. Accuracy is limited by heartbeat frequency and the reliability of host uptime reporting. Configure or clear records in **Settings → Outage tracking**. This is **not** a substitute for independent, external uptime monitoring.

## Password protection

| Mode | Configuration | Access |
| --- | --- | --- |
| No password (default) | Leave `DASHBOARD_PASSWORD` empty | Anyone who can reach the dashboard can view and edit |
| Edit-only lock | Set `DASHBOARD_PASSWORD` and `DASHBOARD_LOCK_VIEW=false` | Everyone can view; editing and clipboard sharing require login |
| Full lock | Set `DASHBOARD_PASSWORD` and keep `DASHBOARD_LOCK_VIEW=true` | Login required to view anything |

Use **full lock and HTTPS** when exposing the dashboard to the internet. Notes, quick-action text, and clipboard entries may be visible to anyone with view access: **do not store passwords or secrets there**.

## Configuration

All application environment variables are listed below and in **Backend logging**. They are read by the backend; browser polling values are supplied through the API, not frontend build-time environment variables. Every variable is optional for startup, though a password and HTTPS are essential for public deployments. Paths must be accessible inside the container, and data/log directories must be writable.

Set overrides under `environment` in your Compose file and recreate the container afterward. The repository Compose file explicitly passes password/view locking, logging, host/container intervals, and remote configuration; other supported options are deliberately left to application defaults (some are shown as commented examples). `PORT` and `DATA_DIR` are provided by the Dockerfile. Its `NODE_ENV=production` is not read by application code; the prebuilt example's `TZ` configures the container timezone, but log timestamps are always UTC.

The repository's active Compose entries are literals, not `.env` substitutions. To use a private `.env` for an override, add or replace the corresponding Compose entry, for example `LOG_LEVEL: "${LOG_LEVEL:-INFO}"`. Exporting a variable on the host alone does not override a literal Compose value. No additional environment pass-through is required for the default deployment.

| Variable | Default | Purpose |
| --- | --- | --- |
| `DASHBOARD_PASSWORD` | Empty | Optional dashboard password |
| `DASHBOARD_LOCK_VIEW` | `true` | Require login to view when a password is configured |
| `PORT` | `8080` | Backend HTTP port; changing it in Docker also requires updating the published port's container side |
| `DATA_DIR` | Repository-root `data/` (`/data` in Docker) | Backend persistent data directory; relative overrides resolve from the process working directory |
| `HOST_STATS_INTERVAL` | `5` | Host stats interval metadata, seconds; nonpositive values disable scheduled host updates, positive values round with minimum 2. Local browser polling uses the shared dashboard interval below |
| `CONTAINER_STATS_INTERVAL` | `30` | Container usage refresh, seconds; nonpositive values disable, positive values round with minimum 5 |
| `SHARE_TOKEN` | Empty | Fixed remote-sharing token (at least 16 characters) |
| `REMOTE_DASHBOARDS` | Empty | Remote definitions, one `Name \| URL \| token` per line |
| `REMOTE_REFRESH_INTERVAL` | `0` (use saved Settings value, initially 10 s) | Remote fetch/poll interval; positive overrides round and clamp to 3–3600 seconds and lock Settings; empty/nonpositive values use Settings |
| `DISKS_DIR` | `/disks` | Root of mounted disks shown in stats |
| `HOST_PROC` | `/host/proc` | Mounted host `/proc` for network information |
| `DOCKER_SOCKET` | `/var/run/docker.sock` (Windows: `//./pipe/docker_engine`) | Backend Docker API socket; changing it also requires suitable socket access/mounts |
| `PUBLIC_IP_URL` | `https://api.ipify.org` | Backend plain-text IP lookup service, contacted only when lookup is enabled in Settings; default public-IP mode is off |
| `TRUST_PROXY` | `false` | Trust reverse-proxy visitor IPs; only enable when direct access is blocked |
| `SESSION_DAYS` | `30` | Login session lifetime in days; whole number 1–365 |
| `LOGIN_MAX_FAILURES` | `5` | Failed login attempts per IP before lockout; whole number 1–100 |
| `LOGIN_LOCKOUT` | `60` | Login lockout duration, seconds; whole number 5–86400 |

### Monitoring timings and limits

These values use **valid environment override → saved Settings value → default** precedence. Overrides must be whole numbers within the listed range; invalid/empty values are ignored and do not lock Settings. Valid overrides lock their corresponding **Settings → Monitoring** controls. All timings are seconds.

| Variable | Default | Range | Component and purpose |
| --- | --- | --- | --- |
| `LOCAL_DASHBOARD_REFRESH_INTERVAL` | `30` | 5–3600 | Shared local dashboard polling: Docker status, host stats, container usage and service health (Settings: Local dashboard refresh) |
| `HEALTH_REFRESH_INTERVAL` | `60` | 10–3600 | Shared clipboard polling; service health uses the local dashboard interval |
| `LOCAL_STALE_AFTER` | `90` | 15–3600 | Browser local-data stale indicator |
| `REFRESH_MIN_GAP` | `5` | 1–60 | Backend minimum gap between forced health/container refreshes |
| `HEALTH_TIMEOUT` | `6` | 1–60 | Backend timeout per service HTTP check |
| `HEALTH_CACHE` | `45` | 5–600 | Backend service-check cache lifetime |
| `HEALTH_PARALLEL` | `8` | 1–32 | Backend concurrent service checks (count) |
| `REMOTE_TIMEOUT` | `8` | 2–60 | Backend remote-dashboard request timeout |
| `LOAD_TIMEOUT` | `15` | 5–120 | Browser initial loading timeout |
| `DOCKER_PARALLEL` | `6` | 1–16 | Backend concurrent container-stat requests (count) |

The local dashboard interval also accepts the legacy `DOCKER_REFRESH_INTERVAL` environment variable when no valid `LOCAL_DASHBOARD_REFRESH_INTERVAL` override is set. Existing saved Docker refresh values are carried forward to **Local dashboard refresh**.

Local and remote browser polls are serialized, with the interval measured from completion of the previous cycle. Hidden pages pause dashboard polling; returning resumes the remaining delay or performs one overdue refresh, rather than refreshing solely because the tab became visible. The refresh button remains disabled and spinning while dashboard refresh operations are active.

The age chip represents the last successful complete dashboard snapshot, not each endpoint response or a cached response's arrival time. Partial failures preserve the previous successful timestamp and show an incomplete/stale warning; healthy chips show only the icon and elapsed age. Elapsed labels and stale indicators update locally without fetching data. Container-usage failures retain the last successful sample instead of replacing it with apparently fresh empty data.

Authentication limit overrides outside their documented ranges fall back to defaults. `DASHBOARD_LOCK_VIEW` disables full-view locking for `0`, `false`, `no`, or `off`; `TRUST_PROXY` enables proxy trust for `1`, `true`, `yes`, or `on` (case-insensitive).

## Run without Docker

Requires **Node.js 18+**, a checkout of this repository, and writable persistent storage. No package installation or build step is needed. Run from the repository root:

```bash
node server.js
```

Visit `http://localhost:8080`. Basic dashboard features work on Windows and macOS; Docker matching and Linux host network statistics require suitable Linux host access and Docker socket access.

For example, to select a port and existing private data directory in a POSIX shell:

```bash
PORT=8011 DATA_DIR=/path/to/dashboard-data node server.js
```

Export any password or other overrides into the process environment before startup. Environment changes require a backend restart; Settings changes are applied by the application without one. A service manager is needed if you want automatic restart outside Docker.

## Backend logging

The backend writes timestamped DEBUG/INFO/WARN messages to stdout, ERROR messages and
stack traces to stderr, and all enabled levels to persistent log files. Console
output is available through `docker logs`. The minimum severity defaults to INFO,
so DEBUG diagnostics are disabled by default. The same threshold applies to console
and file output, including rotation and log-management notices.
Requests include method, route, status, and duration, without bodies or query strings.
Service health changes, authentication, lifecycle, and log-management actions are logged.

| Variable | Default | Purpose |
| --- | --- | --- |
| `LOG_DIR` | `DATA_DIR/logs` | Log directory, created automatically (`/data/logs` in Docker) |
| `LOG_FILE` | `backend.log` | Active filename; path components are stripped (use `LOG_DIR` for the directory) |
| `LOG_MAX_BYTES` | `10485760` (10 MiB) | Rotation threshold in bytes; whole number 1024–1073741824, invalid values use the default |
| `LOG_LEVEL` | `INFO` | Minimum severity: `DEBUG`, `INFO`, `WARN`, or `ERROR` (case-insensitive) |

The included Compose file exposes `LOG_LEVEL`, `LOG_DIR`, `LOG_FILE`, and
`LOG_MAX_BYTES` under `environment`. Set `LOG_LEVEL: "INFO"` for INFO/WARN/ERROR,
`LOG_LEVEL: "WARN"` for WARN/ERROR, `LOG_LEVEL: "ERROR"` for errors only, or
`LOG_LEVEL: "DEBUG"` for all levels. Severity order is DEBUG < INFO < WARN < ERROR;
the selected level and all higher levels are logged. Invalid or missing levels
fall back to INFO. Recreate the container after changing Compose environment
values, for example with `docker compose up -d --build`.

| Level | Purpose |
| --- | --- |
| DEBUG | Incoming-request and access-denial diagnostics for troubleshooting |
| INFO | Startup/shutdown, successful requests/logins, recovery events, and log-management notices |
| WARN | Failed checks/logins, unavailable remotes, 4xx responses, and interrupted requests/downloads |
| ERROR | 5xx responses, exceptions, startup failures, and persistence failures |

For the repository deployment, inspect console output with:

```bash
docker logs --tail 100 -f showy-dashy
# Equivalent, using the Compose service name:
docker compose logs --tail 100 -f showy-dashboard
```

For the prebuilt quick-start example, use `docker logs --tail 100 -f showy-dashboard` instead.

Rotation occurs before an append that would exceed the threshold on a nonempty file. It keeps the active file and one `.1` backup, replacing the older backup; this is size-based, not time-based retention. A single large entry or rotation notice can exceed the threshold, so it is not a strict file-size cap.
Writes and log-management operations are serialized. Disk failures leave console
logging enabled; pending file data is bounded to 1 MiB and excess entries are dropped
from disk with an error diagnostic on stderr. File failures trigger a five-second retry delay; those failure diagnostics bypass the severity filter. Use a single backend process per log directory.

In **Settings → Data → Backend Logs**, **Download Logs** streams the previous backup
followed by the current log as a single text download. **Clear Logs** requires
confirmation, removes both logs, and records the clear action in the new active log
when INFO logging is enabled.
Both `GET /api/logs` and `DELETE /api/logs` require existing edit authorization.
Without a configured dashboard password, anyone who can access the app can use them.
Logs contain operational diagnostics: protect downloads and stored files accordingly.

The existing Docker data volume also persists `/data/logs`; no deployment change is
required. To store logs separately, set `LOG_DIR=/logs` and mount a writable volume
there. Restart the backend after changing environment values. Concurrent downloads
retain open file snapshots across clearing/rotation, so their earlier content can
finish downloading even after a clear. Clearing files does not erase Docker's console-log history.

### Troubleshooting

- **No file logs or downloads return 503:** inspect console errors, writable-volume permissions, available disk space, and the configured log path. Newly created log directories/files use modes 0700/0600; changing `LOG_DIR` requires a writable mount if it is outside `/data`.
- **Too little diagnostic detail:** temporarily select DEBUG and recreate/restart the backend. INFO request-completion logs can be frequent because the UI polls; use WARN or ERROR to reduce routine output.
- **Missing containers:** verify socket access and `DOCKER_SOCKET`. The dashboard only monitors containers; it cannot start or stop them.
- **Missing host network/disks/sensors:** verify Linux host access, the `/proc:/host/proc:ro` mount, disk mounts under `/disks`, and available `/sys` sensors. Docker Desktop reports its Linux VM rather than full macOS/Windows host metrics.
- **Service looks down despite opening in your browser:** checks originate from the backend, using the service's primary URL (or alternate URL if no primary is set). Check container DNS/routing and timeout settings. HTTP 401/403 count as reachable; 404 and 5xx do not.
- **Remote unavailable:** confirm backend reachability, URL, share-token validity, and timeout settings. Cached directory entries are not proof that the remote is currently online.

## Data and backups

Backend persistent state lives in `DATA_DIR` (repository-root `data/` by default, `/data` in Docker). Logs can be stored elsewhere with `LOG_DIR`.

| Path | Contents |
| --- | --- |
| `config.json` | Servers, services, groups, quick actions, and settings |
| `config.json.bak` | Previous configuration copied before a save, when available |
| `clipboard.json` | Shared clipboard history |
| `remotes.json` | Sharing tokens and remote connections |
| `availability.json` | Heartbeats and outage history |
| `serverinfo.json` | Public IP lookup preference |
| `tunables.json` | Monitoring timing preferences |
| `icons/` | Downloaded icon cache (safe to regenerate) |
| `logs/` | Active backend log and one rotated backup (unless `LOG_DIR` is overridden) |
| `session.key` | Session secret when authentication is enabled |

Use **Settings → Data → Export JSON / Import JSON** for dashboard configuration only. Exports do not include sharing tokens, remote connections, clipboard history, availability history, or separate monitoring/public-IP preferences. Back up the entire data directory and any separate log volume to retain backend state; stop the backend during filesystem backup for a consistent snapshot. Preserve `session.key` to retain sessions across restarts; changing the password invalidates existing sessions. Browser-local preferences such as theme/layout are not part of a backend filesystem backup.

The repository mounts `./data:/data`, the Docker socket, the host root at `/disks/System`, and host `/proc` at `/host/proc`. Only the data/log storage needs write access. Optional disk mounts add tiles labeled by their directory names. Keep the same persistent mount when replacing the container; changing `DATA_DIR` also requires adjusting its volume mapping and, if needed, the explicitly configured `LOG_DIR`.

Clipboard history defaults to 10 entries, with Settings choices of 5, 10, 25, or 50; each entry is limited to 10,000 characters. Outage history is estimated, not external monitoring. Hardware metrics depend on platform/kernel exposure, and the backend has no multi-process shared-state or log coordination.

**Do not commit persistent state or private `.env` files:** they may contain private URLs, clipboard content, passwords, and access tokens.

## Security considerations

- The app uses the Docker API for **read-only operations**; it does not expose container start/stop controls. **Note:** mounting `/var/run/docker.sock:ro` does *not* itself enforce read-only Docker API permissions. Treat access to the Docker socket as privileged and restrict who can access the dashboard host.
- Protect internet-facing installations with HTTPS, a strong password, and appropriate firewall rules.
- Sharing tokens grant access to remote host and service information; rotate or disable them when no longer needed.
- The included standard Compose configuration limits the container to **128 MB RAM and 0.5 CPU**.
- Icon downloads are validated and cached; SVGs are served with protections against script execution.

## License

Licensed under the [MIT License](LICENSE).

## Acknowledgments

Service icon search uses the community-maintained [Homarr dashboard-icons](https://github.com/homarr-labs/dashboard-icons) collection.

---

<div align="center">

**Built for homelabs, NAS setups, VPS instances, and anyone who wants a simpler view of their self-hosted services.**

</div>
