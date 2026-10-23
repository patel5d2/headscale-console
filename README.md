# Headscale Console

[![CI](https://github.com/patel5d2/headscale-console/actions/workflows/ci.yml/badge.svg)](https://github.com/patel5d2/headscale-console/actions/workflows/ci.yml)
[![Container image](https://github.com/patel5d2/headscale-console/actions/workflows/docker.yml/badge.svg)](https://github.com/patel5d2/headscale-console/pkgs/container/headscale-console)

A clean, Tailscale-style web admin console for [Headscale](https://headscale.net). It talks to your Headscale server's REST API — on first open it asks for your Headscale URL and an API key, then gives you Machines, Routes, Users, Access controls, DNS and Settings pages modelled on `login.tailscale.com/admin`.

- **More than a viewer.** Bulk actions, an audit log of every change, policy version history with one-click restore, backup and restore, Browser SSH, log analysis, one-click Headscale updates, and an `hsconsole` command-line tool.
- **Zero runtime dependencies.** Written in strict TypeScript, compiled to plain JavaScript: one small Node.js server (static files + API proxy) and a framework-free front end.
- **Runs anywhere.** A prebuilt multi-arch image (amd64/arm64), Docker Compose, a VM with systemd, or just `node dist/server/server.js`.
- **Light and dark themes**, keyboard shortcuts, responsive down to phone width.
- **Tested against Headscale v0.29.5** (latest stable). Works with 0.26+; some fallbacks are included for older API shapes.

---

## Quick start

### Run it (one command)

Creates and starts the container; nothing to download or build first:

```bash
docker run -d --name headscale-console --restart unless-stopped -p 8090:8080 -v headscale-console-data:/data ghcr.io/patel5d2/headscale-console:latest
```

Open **http://localhost:8090** (or `http://<host>:8090`), enter your Headscale URL and an API key.

To lock the console to your server (turns on Browser SSH, the audit log and policy history), add `-e HEADSCALE_URL=https://your-headscale` before the image name. To update later: `docker rm -f headscale-console && docker pull ghcr.io/patel5d2/headscale-console:latest`, then run the command again (settings are kept in the `headscale-console-data` volume).

With Compose instead: `curl -fsSLO https://raw.githubusercontent.com/patel5d2/headscale-console/main/docker-compose.ghcr.yml && docker compose -f docker-compose.ghcr.yml up -d`

### Every feature (Docker on the Headscale server)

On the machine where Headscale is installed from its `.deb`, `docker-compose.full.yml` turns everything on: Browser SSH, the audit log, policy history, all three Logs tabs (Headscale's journal, device logs, network activity) and one-click Headscale updates.

```bash
sudo ./deploy/install-vm.sh --helper-only   # once: the root helper behind updates and "Allow device logs"
cp .env.example .env                        # set HEADSCALE_URL; optionally PUBLIC_URL and COLLECTOR_API_KEY
docker compose -f docker-compose.full.yml up -d
```

It uses the `-host` image (adds `journalctl`). The container starts as root only to switch to an unprivileged user that can read the mounted journal, keeps just `SETUID`/`SETGID` for that, and runs read-only. With `COLLECTOR_API_KEY` set, log collection is on from the start; with `PUBLIC_URL`, device log commands use that address.

### Docker Compose (build from source)

```bash
cd headscale-console
cp .env.example .env      # optional: set HEADSCALE_URL=https://your-headscale
docker compose up -d --build
```

Open **http://&lt;host&gt;:8090**. Without `HEADSCALE_URL` the login page asks for your Headscale URL (e.g. `https://headscale.example.com`) and an API key; it remembers the last few servers you used. With it, the URL is fixed and only the key is asked for. To change it later, edit `.env` and run `docker compose up -d` again.

Create an API key on the Headscale host:

```bash
headscale apikeys create --expiration 90d
# Headscale in Docker:
docker exec -it headscale headscale apikeys create --expiration 90d
```

### On a VM without Docker (systemd)

Requires Node.js 22.15 or newer.

```bash
sudo ./deploy/install-vm.sh --url https://headscale.example.com
# → builds if needed, installs to /opt/headscale-console, links the hsconsole CLI,
#   and starts headscale-console.service on port 8090
```

Options: `--port N`, `--host-actions` (Logs and one-click updates, see below), `--uninstall` (keeps data), `--purge` (removes data too), `-h` for help. Re-running it upgrades in place.

Or just run it: `npm ci && npm run build && PORT=8090 node dist/server/server.js`

---

## Configuration

All settings are environment variables; none are required.

| Variable | Default | What it does |
|---|---|---|
| `PORT` | `8080` | Port the console listens on (inside the container). |
| `HOST` | `0.0.0.0` | Interface to bind. |
| `HEADSCALE_URL` | — | **Recommended.** Locks the console to one Headscale server. The login screen then only asks for the API key, and the proxy refuses any other destination. |
| `ALLOWED_HEADSCALE_HOSTS` | — | When `HEADSCALE_URL` isn't set, a comma-separated allowlist of hostnames users may enter. |
| `HEADSCALE_INSECURE_TLS` | `false` | Accept a self-signed certificate on the Headscale server. |
| `PROXY_TIMEOUT_MS` | `20000` | Upstream request timeout. |
| `HOST_ACTIONS` | `false` | Enables the **Logs** page and **one-click Headscale updates** when the console runs on the Headscale VM. Requires `HEADSCALE_URL`. See below. |
| `HEADSCALE_UNIT` | `headscale` | systemd unit whose journal the Logs page reads. |
| `BROWSER_SSH` | on | Set `false` to turn off Browser SSH. It's only ever on when `HEADSCALE_URL` is set and the SSH client is built. |
| `DATA_DIR` | `./data` (`/data` in Docker) | Where the audit log and policy history are kept. Mount a volume here. |
| `AUDIT_LOG` | on | Set `false` to stop recording changes. Needs `HEADSCALE_URL`. |
| `AUDIT_MAX_BYTES` | `10485760` | The audit log rotates to `audit.jsonl.1` past this size. |
| `POLICY_HISTORY_MAX` | `200` | Policy versions kept. |
| `PUBLIC_URL` | — | The console's address as devices reach it; the default for device log commands (otherwise the address in your browser). |
| `COLLECTOR_API_KEY` | — | Turns automatic log collection on at start-up with this API key (instead of the button on the Logs page). |
| `RUN_AS` | `1000` | The user the `-host` image switches to after starting as root. |
| `ACTIVITY_POLL_MS` | `30000` | How often automatic collection checks the tailnet for network activity. |
| `DEVICE_LOG_MAX_BYTES` | `5242880` | Each device's log rotates to `.1` past this size. |
| `HEADSCALE_RELEASES_URL` | GitHub releases API | Release feed for update checks (e.g. a mirror). |
| `RELEASES_CACHE_MS` | `3600000` | How long the release feed is cached. |

### Same Docker host as Headscale

Join Headscale's Docker network and point the console at the container name:

```yaml
services:
  headscale-console:
    # ...
    environment:
      HEADSCALE_URL: "http://headscale:8080"
    networks: [headscale]
networks:
  headscale:
    external: true   # use the network your headscale container is on
```

### Headscale settings that unlock features

- **Editing access controls** needs the policy stored in the database. In Headscale's `config.yaml`:
  ```yaml
  policy:
    mode: database
  ```
  With `mode: file` the policy page is read-only.
- **MagicDNS full names**: set *Settings → General → MagicDNS base domain* (or the DNS page) to the same value as `dns.base_domain`. Headscale's API doesn't expose it, so the console stores it in your browser.

---

## What's included (vs. the Tailscale admin console)

| Tailscale console | Headscale Console | Notes |
|---|---|---|
| **Overview** | ✅ | Tailnet stats and a *Needs attention* list: routes awaiting approval, expired or expiring machine keys, machines unseen for 30+ days, tags missing from `tagOwners`, this console's API key expiring, Headscale updates. |
| **Machines** list, search, filters, sort | ✅ | Filter by status, owner, tag, exit node, subnet router, pending approval, expiry disabled, ephemeral. Auto-refreshes every 15 s. |
| Machine details page | ✅ | Owner, addresses, MagicDNS name, keys, created/last seen, registration method, auth key used. |
| Edit machine name | ✅ | Validates MagicDNS label rules. |
| Edit route settings (subnets + exit node) | ✅ | Approve/unapprove advertised routes, pre-approve routes, toggle exit node. |
| Edit ACL tags | ✅ | Suggests tags from `tagOwners`. |
| Disable / enable key expiry, expire key | ✅ | Plus "set expiry date" (1 day … 1 year or a custom date). |
| Remove machine | ✅ | |
| Add device | ✅ | Generates an auth key with ready-to-paste Linux/macOS/Windows/Docker commands (accept routes/DNS, exit node, shields up, operator, SSH, QR, hostname, advertised routes…), or registers a device from its login URL. |
| **Browser SSH** | ✅ | *SSH* on any machine opens a terminal in the browser over Tailscale SSH, connecting as a Headscale user you pick. See below. |
| **Routes** overview | ✅ | All subnet routes and exit nodes, primary/standby (HA) status, approve in one click, "Awaiting approval" view, nav badge with pending count. |
| **Users** | ✅ | Create, rename, delete (offers to remove their machines first), machine counts, last active, add device / auth key for a user. |
| **Access controls** | ✅ | **Visual editor** for access rules, SSH rules, groups, tag owners and hosts, with suggestions for every user, group, tag and host. **Access checker**: "can machine A reach machine B on port N, and SSH in as user X?", naming the rule that decides. HuJSON editor with syntax highlighting, line numbers and live syntax checking; server-side validation; templates; **Add rules** (prebuilt snippets: admins, own devices, exit nodes, web/DNS services, SSH, ping, auto-approvers); Format; import/export; Ctrl+S to save; *Preview rules* (filter by user or tag), a *Tags* view and a *Changes* diff against the saved policy. |
| **Logs** | ✅ automatic | Three tabs, collected without running anything by hand once turned on: **Headscale server** (its journald log with error/warning counts, *Top issues*, level filter, search, download; needs host actions), **Devices** (every Linux, macOS, Windows and Docker device's Tailscale log) and **Network activity** (machines joining, leaving, going online/offline, route, tag, owner, address and key-expiry changes). See below. |
| **Updates** | ✅ | *Settings → Updates* compares your version with the latest stable release. With host actions: one-click update with checksum verification, database backup and automatic rollback. Otherwise: copy-paste commands for .deb and Docker. |
| **DNS** | ✅ / config | MagicDNS names for every machine with copy buttons. Nameservers, split DNS and extra records are configured in Headscale's `config.yaml` (not its API) — the page shows a ready-made snippet. |
| **Settings → Keys** (auth keys) | ✅ | Reusable / ephemeral / tagged / expiry (presets or an exact date and time), revoke, delete, Active/Used/Expired tabs. |
| **Settings → API keys** | ✅ | Create (shown once), expire, delete; marks the key used by this session. |
| **Device approval** | ✅ | Register a device or approve/reject an auth request (e.g. SSH check mode) by its ID. Headscale's API has no list of pending requests. |
| Server info / health | ✅ | Version, commit, database health, tailnet stats, IP backfill. |
| **Bulk actions** | ➕ | Select machines (or *select all shown*) to approve routes, add/remove tags, disable expiry, expire keys or remove them in one go, with a per-machine result. |
| **Audit log** | ➕ | Every change made through the console: who (API key prefix), what, when, the result. Search, failures-only filter, CSV export. Secrets are redacted; policies are recorded as a size and SHA-256. |
| **Policy history** | ➕ | Each saved policy is versioned (including the one before the console's first change). Diff any version against the current policy and restore it. |
| **Backup and restore** | ➕ | *Settings → Backup*: download users, machines, key metadata and the policy as JSON (no secrets). Restore previews what it will do, recreates missing users and replaces the policy. |
| **Command line** | ➕ | `hsconsole` does the same from a terminal or script. See below. |
| Funnel/Serve, Services/Apps, billing, user roles & invites, device posture, webhooks, sharing machines | ❌ | Not features of Headscale, so there's no API to drive. |
| Client OS / version per machine | ❌ | Headscale's API doesn't expose them. |
| Change machine owner | ❌ | Removed from Headscale's API; tag the machine or re-register it under another user instead. |

### Keyboard shortcuts

`/` focus search · `g` then `o` Overview · `g m` Machines · `g r` Routes · `g u` Users · `g a` Access controls · `g d` DNS · `g l` Logs · `g h` Audit log · `g s` Settings · `g k` Auth keys · `Ctrl/⌘ + S` save policy · `Esc` close dialogs/menus

### Command line: `hsconsole`

Installed with the VM installer and inside the image (`docker exec headscale-console hsconsole …`), or run `node dist/cli/hsconsole.js` from a checkout. Set `HEADSCALE_URL` and `HEADSCALE_API_KEY` (or pass `--url` / `--key`); add `--json` for machine-readable output.

```bash
hsconsole status                          # version, health, what needs attention
hsconsole machines --search laptop
hsconsole routes --pending && hsconsole approve router
hsconsole join --user alice --os mac      # single-use key + the join command
hsconsole policy get --out policy.hujson
hsconsole policy set policy.hujson        # shows the diff; add --yes to save it
hsconsole check laptop server --port 22   # would the policy allow it, and which rule?
hsconsole backup --out backup.json
```

`hsconsole help` lists every command. Exit codes: `0` success, `1` error, `2` usage error.

---

## How it works & security

```
Browser ──(same origin)──> Headscale Console (Node server) ──> Headscale REST API (/api/v1)
          Authorization: Bearer <API key>                    forwarded unchanged
```

- Headscale's API doesn't send CORS headers, so the browser can't call it directly. The server serves the UI and proxies `/proxy/api/v1/*` (plus `/version`) to your Headscale server. Nothing else is reachable through it.
- The API key lives only in your browser — `localStorage` if you tick "Remember me", otherwise just the current tab — and is sent with each request. The server never stores or logs it; the audit log records only the key's public prefix.
- The console's own endpoints (audit log, policy history, host actions) verify the API key against the locked Headscale server before answering.
- **An API key is full admin access.** Put the console somewhere only you can reach (your LAN or tailnet), or behind a reverse proxy with its own auth. Set `HEADSCALE_URL` so the proxy can't be pointed at other hosts.
- Strict security headers (CSP with no inline scripts, `frame-ancestors 'none'`, `nosniff`, no referrer). The container runs as a non-root user with a read-only filesystem and all capabilities dropped.

### Browser SSH

The browser runs a Tailscale client compiled to WebAssembly. It's Tailscale's `tsconnect`, as packaged by [Headplane](https://github.com/tale/headplane) (MIT), and the terminal is [xterm.js](https://xtermjs.org). For each session, the client joins your tailnet as a temporary machine (`hsconsole-ssh-…`) owned by the Headscale user you pick, and opens a Tailscale SSH session.

How a session is handled:

- **Short-lived key:** the console creates a single-use, ephemeral auth key that expires after 5 minutes.
- **Cleanup:** the temporary machine is removed when you close or reload the page. Any left over are removed the next time you connect.
- **Control traffic:** goes through the console's own server (`/key`, `/ts2021`), and only to `HEADSCALE_URL`. Headscale needs no CORS changes.
- **No log uploads:** the client is built with Tailscale's log uploading compiled out, so nothing is sent to `log.tailscale.io`.

Requirements:

- `HEADSCALE_URL` set, and Headscale 0.29.2 or newer.
- On each target machine: `sudo tailscale set --ssh`. A regular SSH server isn't used.
- `ssh` rules in your policy that let the chosen user log in. *Access controls → Add rules → SSH into your own devices* is a good start.
- A reverse proxy in front of the console must forward WebSocket upgrades (Caddy does by default), and the console must be served at the root of its domain.

Run `scripts/build-ssh.sh` once (needs Go and git). It puts the client in `public/ssh/`, which the server serves and the Docker build copies as is. If it's missing, the Docker build compiles it in a Go stage instead, which takes a few minutes and about 4 GB of free Docker disk space. To build without SSH, run `docker build --target app .`.

### Automatic logs

Run the console on the Headscale server, then everything is collected for you:

```bash
sudo ./deploy/install-vm.sh --url https://hs.example.com --host-actions
# or in Docker: see "Every feature" above (docker-compose.full.yml)
```

1. **Logs → Turn on automatic collection** (one click). The console creates an API key of its own (valid one year, stored in `DATA_DIR/collector.json`, readable only by the console) so collection keeps running when nobody is signed in. Network activity starts being recorded straight away; nothing is installed on any device.
2. **Logs → Devices → Allow device logs** (one click). Headscale tells devices not to send their logs unless `logtail.enabled: true` is in its config; the console's root helper sets it, restarts Headscale, and restores the previous config if Headscale doesn't come back. Without host actions, add those two lines yourself.
3. Check **Address devices use to reach this console**: it goes into the join commands, so it must be reachable from every device. Use the console's public `https://` address (see *Behind a reverse proxy*) or its tailnet address; the page warns about `localhost` and unencrypted public addresses.

From then on, devices added with **Add device** send their Tailscale log as they join (Linux, macOS, Windows, Docker and Compose; untick *Send logs to the console* to skip it). Machines that joined earlier show **Set up…** with the one command for their platform. Under the hood the command sets `TS_LOG_TARGET` in tailscaled's environment file (`/etc/default/tailscaled`, `%ProgramData%\Tailscale\tailscaled-env.txt`, or the macOS app's container) and restarts Tailscale.

How it stays safe and small: devices post to `/ingest/<token>/…`, where the random token is the only way in (wrong tokens get a plain 404); bodies are capped at 512 KB (4 MB decompressed), lines at 2 KB, and each device's log rotates past `DEVICE_LOG_MAX_BYTES`. Turning collection off refuses devices, expires the console's API key and keeps what was collected. In Docker (no host actions), network activity and device logs work the same way; only Headscale's own log needs the console on the Headscale server.

### Logs and one-click updates (host actions)

Headscale has no API for its logs or for upgrading itself, so these need the console on the same VM as a Headscale installed from the official `.deb`:

```bash
sudo ./deploy/install-vm.sh --url https://headscale.example.com --host-actions
```

How it stays safe:

- The console process never gets root. It reads the journal through the `systemd-journal` group and can write only to `/var/lib/headscale-console`.
- **Update** writes just a version number to a request file. A separate root unit (`headscale-console-update.path` → `/usr/local/sbin/headscale-console-update`) re-validates it as `X.Y.Z` and downloads that release from GitHub. It checks the SHA-256 against the release's `checksums.txt`, stops Headscale and backs up `db.sqlite`, then installs. If Headscale doesn't come back up, it reinstalls the previous version and restores the database.
- Every host action needs a valid Headscale API key, checked against `HEADSCALE_URL` (which is why it's required). Version numbers must be real stable releases.
- Docker deployments can't use host actions; the Updates page shows the manual commands instead.

### Behind a reverse proxy

Caddy:
```
console.example.com {
  reverse_proxy 127.0.0.1:8090
}
```

nginx:
```nginx
location / {
  proxy_pass http://127.0.0.1:8090;
  proxy_set_header Host $host;
}
```

The console uses relative paths, so it also works under a sub-path (e.g. `/console/`) as long as the proxy strips the prefix.

---

## Development

TypeScript in `src/`, compiled with `tsc` (no bundler, no runtime dependencies). Node.js 22.15+.

```bash
npm ci
npm run build        # src/client → public/js, src/server + src/cli + src/shared → dist
npm run typecheck
npm run dev          # build, then serve on :8080
npm test             # build + Playwright: API, end-to-end, unit and CLI tests, with coverage
```

Tests run against an in-memory mock Headscale (`tests/support/mock-headscale.ts`) and four console servers with different settings. The coverage report (server, CLI and browser code combined, mapped back to the TypeScript) is in `coverage/index.html`; `npm test` fails if coverage drops below the floor in `tests/support/coverage.ts` (currently 98% of statements, 89% of branches); `COVERAGE_REPORT_ONLY=1 npm test` reports without enforcing it. Run one file with `npx playwright test tests/e2e/machines.spec.ts`.

CI (`.github/workflows/ci.yml`) typechecks, runs ShellCheck and the test suite on every push and pull request. `.github/workflows/docker.yml` builds the amd64/arm64 image, with Browser SSH, and publishes it to `ghcr.io/patel5d2/headscale-console` from `main` and `v*.*.*` tags.

### Project layout

```
src/server/          HTTP server, Headscale API proxy, SSH relay, audit log + policy history, host actions
src/client/          front end: app shell and router, DOM helpers, pages/ (one module per page)
src/shared/          used by both: API client, join commands, policy checker, backup, log parsing
src/cli/hsconsole.ts command-line tool
public/              index.html, css/, vendor/xterm/ (xterm.js 5.5.0, MIT); js/ and ssh/ are generated
tests/               api/, e2e/, unit/ specs; support/ has the mock Headscale and test servers
deploy/              systemd units, VM installer, root update helper
scripts/build-ssh.sh builds the Browser SSH client into public/ssh/ (pinned Headplane commit)
```

## Troubleshooting

- **The server URL field can't be edited** — the console was started with `HEADSCALE_URL`, which fixes the server. Change it (in `.env` for Docker Compose) and restart, or remove it to type the URL on the login page.
- **"No Headscale API found"** — use the exact `server_url` from your Headscale config (e.g. `https://hs.example.com`), not the metrics port.
- **"Could not reach Headscale"** from inside Docker — `localhost` is the container itself. Use the host's LAN IP, the public URL, or join Headscale's Docker network.
- **Certificate errors** with a self-signed cert — set `HEADSCALE_INSECURE_TLS=true`.
- **Policy won't save** — set `policy.mode: database` in Headscale's config.
- **"requested tags are invalid or not permitted"** — add the tag under `tagOwners` in the policy first.
