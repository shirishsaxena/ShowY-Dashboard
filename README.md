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
| **Health checks** | Up/down status, including failed HTTP responses such as 404 and server errors |
| **Docker integration** | Automatic container matching, state, CPU/memory/network usage, and a list of containers not yet on the dashboard |
| **Server stats** | CPU, RAM, disks, uptime, network speed/history, temperatures, and fans |
| **Server information** | Hostname, OS, kernel, CPU, IP addresses, network interfaces, and Docker engine details |
| **Remote dashboards** | Read-only views of other dashboard instances, with configurable refresh and stale/unreachable indicators |
| **Outage tracking** | Estimated 24-hour, 7-day, and 30-day availability plus outage history |
| **Shared clipboard** | Text/link sharing between devices, persistent history, configurable entry count, and copy/delete actions |
| **Quick actions** | Open a saved link or copy saved text with one click |
| **Customization** | Card, compact, and list layouts; auto/light/dark themes; accent colors; searchable icons and icon caching |
| **Convenience** | Search (`/` shortcut), QR codes, PWA installation, JSON export/import, and optional password protection |

Icons can come from [dashboard-icons](https://github.com/homarr-labs/dashboard-icons), an emoji, or a custom image URL. Saved icons are cached locally for faster loading.

## Quick start (Docker)

**Requirements:** Linux, Docker, and Docker Compose. The recommended installation uses the [prebuilt Docker image](https://github.com/shirishsaxena/ShowY-Dashboard/pkgs/container/showy-dashboard), so there is no need to clone the repository or build from source.

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

The repository's `docker-compose.yml` uses the local build setup. To update a source-built installation, run `git pull` followed by `docker compose up -d --build`.

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

## Public VPS deployment (HTTPS)

The included `docker-compose.vps.yml` runs the dashboard behind [Caddy](https://caddyserver.com), which obtains and renews HTTPS certificates automatically.

1. Point your domain's DNS **A record** to your VPS and allow inbound ports **80** and **443**.
2. Configure the environment:

   ```bash
   cp .env.example .env
   nano .env
   ```

   Set `DOMAIN` and a strong `DASHBOARD_PASSWORD`.
3. Start the VPS stack:

   ```bash
   docker compose -f docker-compose.vps.yml up -d --build
   ```

4. Open `https://your-domain`.

The VPS configuration requires a password and places the whole dashboard behind the login screen. For updates, use the same Compose command with `-f docker-compose.vps.yml`.

## Connect multiple dashboards

Install an instance on each machine. Each instance monitors its own host and services; a main dashboard can display other instances as read-only remote servers.

1. On the remote instance, go to **Edit → Settings → Share this dashboard → Turn on**, then copy its share token.
2. On your main instance, go to **Settings → Remote dashboards** and add the remote URL and token.
3. Select the remote machine from the server switcher to see its services, host stats, and Docker usage.

Remote information is fetched server-to-server. The remote must be reachable from the dashboard server (for example, over your LAN or a VPN). **Use HTTPS across the public internet** to protect tokens in transit. Remote refresh is configurable (default: 10 seconds), and disconnected remotes are marked stale or unreachable while retaining their last known data. Share tokens grant read access to the source dashboard, not edit access, and are not forwarded to the browser.

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

ShowY Dashboard records a heartbeat for its own machine every **1, 5, or 10 minutes** (configurable). On startup, it checks gaps against a **5, 10, 15, or 30-minute** threshold (default: 10 minutes).

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

Set these under `environment` in your Compose file. The full range of monitoring timings is also configurable in **Settings → Monitoring**; environment values override and lock the corresponding UI controls.

| Variable | Default | Purpose |
| --- | --- | --- |
| `DASHBOARD_PASSWORD` | Empty | Optional dashboard password |
| `DASHBOARD_LOCK_VIEW` | `true` | Require login to view when a password is configured |
| `PORT` | `8080` | Internal HTTP port |
| `DATA_DIR` | `./data` (`/data` in Docker) | Persistent data directory |
| `HOST_STATS_INTERVAL` | `5` | Host stats refresh interval, seconds; `0` disables |
| `CONTAINER_STATS_INTERVAL` | `30` | Container usage refresh interval, seconds; `0` disables |
| `SHARE_TOKEN` | Empty | Fixed remote-sharing token (at least 16 characters) |
| `REMOTE_DASHBOARDS` | Empty | Remote definitions, one `Name \| URL \| token` per line |
| `REMOTE_REFRESH_INTERVAL` | UI setting (10 s default) | Remote refresh frequency |
| `DOCKER_REFRESH_INTERVAL` | `30` | Docker status refresh, seconds |
| `HEALTH_REFRESH_INTERVAL` | `60` | Service status and clipboard refresh, seconds |
| `HEALTH_TIMEOUT` | `6` | Per-service check timeout, seconds |
| `HEALTH_CACHE` | `45` | Service check cache duration, seconds |
| `LOCAL_STALE_AFTER` | `90` | When local data is marked stale, seconds |
| `DISKS_DIR` | `/disks` | Root of mounted disks shown in stats |
| `HOST_PROC` | `/host/proc` | Mounted host `/proc` for network information |
| `DOCKER_SOCKET` | `/var/run/docker.sock` | Docker API socket |
| `PUBLIC_IP_URL` | `https://api.ipify.org` | Optional public IP lookup service |
| `TRUST_PROXY` | `false` | Trust reverse-proxy visitor IPs; only enable when direct access is blocked |
| `SESSION_DAYS` | `30` | Login session lifetime in days |
| `LOGIN_MAX_FAILURES` | `5` | Failed login attempts before lockout |
| `LOGIN_LOCKOUT` | `60` | Login lockout duration, seconds |

Additional tuning options include `REFRESH_MIN_GAP`, `HEALTH_PARALLEL`, `REMOTE_TIMEOUT`, `LOAD_TIMEOUT`, and `DOCKER_PARALLEL`. See **Settings → Monitoring** for the adjustable values.

## Run without Docker

Requires **Node.js 18+**:

```bash
node server.js
```

Visit `http://localhost:8080`. Basic dashboard features work on Windows and macOS; Docker matching and Linux host network statistics require suitable Linux host access and Docker socket access.

## Data and backups

Everything lives in the `data/` directory:

| Path | Contents |
| --- | --- |
| `config.json` | Servers, services, groups, quick actions, and settings |
| `clipboard.json` | Shared clipboard history |
| `remotes.json` | Sharing tokens and remote connections |
| `availability.json` | Heartbeats and outage history |
| `serverinfo.json` | Public IP lookup preference |
| `tunables.json` | Monitoring timing preferences |
| `icons/` | Downloaded icon cache (safe to regenerate) |
| `session.key` | Session secret when authentication is enabled |

Use **Settings → Export JSON** to back up your dashboard configuration, or back up the entire `data/` directory to retain history and authentication-related state. **Do not commit `data/` to Git:** it may contain private URLs, clipboard content, and access tokens.

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
