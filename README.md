# Headscale Console

A clean, Tailscale-style web admin console for [Headscale](https://headscale.net). It talks to your Headscale server's REST API — on first open it asks for your Headscale URL and an API key, then gives you Machines, Routes, Users, Access controls, DNS and Settings pages modelled on `login.tailscale.com/admin`.

- **Zero dependencies.** One small Node.js server (static files + API proxy) and a vanilla-JS front end. Nothing to `npm install`, no build step.
- **Runs anywhere.** Docker / Docker Compose, a VM with systemd, or just `node server.js`.
- **Light and dark themes**, keyboard shortcuts, responsive down to phone width.
- **Tested against Headscale v0.29.5** (latest stable). Works with 0.26+; some fallbacks are included for older API shapes.

---

## Quick start

### Docker Compose (recommended)

```bash
cd headscale-console
docker compose up -d --build
```

Open **http://&lt;host&gt;:8090**, enter your Headscale URL (e.g. `https://headscale.example.com`) and an API key.

Create an API key on the Headscale host:

```bash
headscale apikeys create --expiration 90d
# Headscale in Docker:
docker exec -it headscale headscale apikeys create --expiration 90d
```

### Plain Docker

```bash
docker build -t headscale-console .
docker run -d --name headscale-console --restart unless-stopped \
  -p 8090:8080 \
  -e HEADSCALE_URL=https://headscale.example.com \
  headscale-console
```

### On a VM without Docker (systemd)

Requires Node.js 18 or newer.

```bash
sudo ./deploy/install-vm.sh https://headscale.example.com
# → installs to /opt/headscale-console and starts headscale-console.service on port 8090
```

Or just run it: `PORT=8090 node server.js`

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
| **Machines** list, search, filters, sort | ✅ | Filter by status, owner, tag, exit node, subnet router, pending approval, expiry disabled, ephemeral. Auto-refreshes every 15 s. |
| Machine details page | ✅ | Owner, addresses, MagicDNS name, keys, created/last seen, registration method, auth key used. |
| Edit machine name | ✅ | Validates MagicDNS label rules. |
| Edit route settings (subnets + exit node) | ✅ | Approve/unapprove advertised routes, pre-approve routes, toggle exit node. |
| Edit ACL tags | ✅ | Suggests tags from `tagOwners`. |
| Disable / enable key expiry, expire key | ✅ | Plus "set expiry date" (1 day … 1 year or a custom date). |
| Remove machine | ✅ | |
| Add device | ✅ | Generates an auth key with ready-to-paste Linux/macOS/Windows/Docker commands, or registers a device from its login URL. |
| **Routes** overview | ✅ | All subnet routes and exit nodes, primary/standby (HA) status, approve in one click, "Awaiting approval" view, nav badge with pending count. |
| **Users** | ✅ | Create, rename, delete (offers to remove their machines first), machine counts, last active, add device / auth key for a user. |
| **Access controls** | ✅ | HuJSON editor with syntax highlighting, line numbers and live syntax checking; server-side validation; templates; **Add rules** (prebuilt snippets: admins, own devices, exit nodes, web/DNS services, SSH, ping, auto-approvers); Format; import/export; Ctrl+S to save; *Preview rules* (filter by user or tag) and a *Tags* view. |
| **Logs** | ✅ host actions | Headscale's journald log with error/warning counts, similar messages grouped into *Top issues*, level filter, search and download. |
| **Updates** | ✅ | *Settings → Updates* compares your version with the latest stable release. With host actions: one-click update with checksum verification, database backup and automatic rollback. Otherwise: copy-paste commands for .deb and Docker. |
| **DNS** | ✅ / config | MagicDNS names for every machine with copy buttons. Nameservers, split DNS and extra records are configured in Headscale's `config.yaml` (not its API) — the page shows a ready-made snippet. |
| **Settings → Keys** (auth keys) | ✅ | Reusable / ephemeral / tagged / expiry, revoke, delete, Active/Used/Expired tabs. |
| **Settings → API keys** | ✅ | Create (shown once), expire, delete; marks the key used by this session. |
| **Device approval** | ✅ | Register a device or approve/reject an auth request (e.g. SSH check mode) by its ID. Headscale's API has no list of pending requests. |
| Server info / health | ✅ | Version, commit, database health, tailnet stats, IP backfill. |
| Funnel/Serve, Services/Apps, billing, user roles & invites, device posture, webhooks, sharing machines | ❌ | Not features of Headscale, so there's no API to drive. |
| Client OS / version per machine | ❌ | Headscale's API doesn't expose them. |
| Change machine owner | ❌ | Removed from Headscale's API; tag the machine or re-register it under another user instead. |

### Keyboard shortcuts

`/` focus search · `g` then `m` Machines · `g r` Routes · `g u` Users · `g a` Access controls · `g d` DNS · `g s` Settings · `g k` Auth keys · `Ctrl/⌘ + S` save policy · `Esc` close dialogs/menus

---

## How it works & security

```
Browser ──(same origin)──> Headscale Console (server.js) ──> Headscale REST API (/api/v1)
          Authorization: Bearer <API key>                    forwarded unchanged
```

- Headscale's API doesn't send CORS headers, so the browser can't call it directly. `server.js` serves the UI and proxies `/proxy/api/v1/*` (plus `/version`) to your Headscale server. Nothing else is reachable through it.
- The API key lives only in your browser — `localStorage` if you tick "Remember me", otherwise just the current tab — and is sent with each request. The server never stores or logs it.
- **An API key is full admin access.** Put the console somewhere only you can reach (your LAN or tailnet), or behind a reverse proxy with its own auth. Set `HEADSCALE_URL` so the proxy can't be pointed at other hosts.
- Strict security headers (CSP with no inline scripts, `frame-ancestors 'none'`, `nosniff`, no referrer). The container runs as a non-root user with a read-only filesystem and all capabilities dropped.

### Logs and one-click updates (host actions)

Headscale has no API for its logs or for upgrading itself, so these need the console on the same VM as a Headscale installed from the official `.deb`:

```bash
sudo ./deploy/install-vm.sh https://headscale.example.com --host-actions
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

## Project layout

```
server.js                 static server + Headscale API proxy (Node 18+, no deps)
host.js                   optional host actions: logs, update requests (HOST_ACTIONS)
public/index.html
public/css/app.css        design tokens, light/dark theme, components
public/js/app.js          shell, router, connection state
public/js/api.js          Headscale REST client (with version fallbacks)
public/js/ui.js           DOM helpers: modals, menus, toasts, toggles, chips…
public/js/util.js         time/format helpers, HuJSON parser, storage
public/js/pages/*.js      machines, machine, routes, users, acls, dns, settings, login
Dockerfile · docker-compose.yml · deploy/ (systemd units, VM installer, root update helper)
tests/check.mjs           self-check for policy merging, log parsing, join commands (npm test)
```

## Troubleshooting

- **"No Headscale API found"** — use the exact `server_url` from your Headscale config (e.g. `https://hs.example.com`), not the metrics port.
- **"Could not reach Headscale"** from inside Docker — `localhost` is the container itself. Use the host's LAN IP, the public URL, or join Headscale's Docker network.
- **Certificate errors** with a self-signed cert — set `HEADSCALE_INSECURE_TLS=true`.
- **Policy won't save** — set `policy.mode: database` in Headscale's config.
- **"requested tags are invalid or not permitted"** — add the tag under `tagOwners` in the policy first.
