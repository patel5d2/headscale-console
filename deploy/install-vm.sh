#!/usr/bin/env bash
# Installs (or upgrades, or removes) Headscale Console as a systemd service on a
# Debian/Ubuntu VM. Safe to re-run: it updates the files and restarts the service.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: sudo ./deploy/install-vm.sh [--url URL] [--port PORT] [--host-actions]
       sudo ./deploy/install-vm.sh --uninstall [--purge]

  --url URL        Lock the console to this Headscale server (recommended; needed
                   for Browser SSH, the audit log and host actions).
  --port PORT      Port to listen on (default 8090).
  --host-actions   Also enable the Logs page and one-click Headscale updates. Only
                   when Headscale itself was installed from the official .deb here.
  --uninstall      Stop and remove the console. Its data (audit log, policy
                   history) is kept unless --purge is given too.
  -h, --help       Show this help.

The URL may also be given as the first argument (older form).
EOF
}

SRC_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DEST=/opt/headscale-console
UNIT=/etc/systemd/system/headscale-console.service
HS_URL="" PORT=8090 HOST_ACTIONS=0 UNINSTALL=0 PURGE=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --url) HS_URL="${2:-}"; shift 2 ;;
    --port) PORT="${2:-}"; shift 2 ;;
    --host-actions) HOST_ACTIONS=1; shift ;;
    --uninstall) UNINSTALL=1; shift ;;
    --purge) PURGE=1; shift ;;
    -h|--help) usage; exit 0 ;;
    http://*|https://*) HS_URL="$1"; shift ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

die() { echo "Error: $*" >&2; exit 1; }
step() { echo "==> $*"; }

[[ $EUID -eq 0 ]] || die "run as root (sudo)."

if [[ $UNINSTALL == 1 ]]; then
  step "Removing Headscale Console"
  systemctl disable --now headscale-console headscale-console-update.path 2>/dev/null || true
  rm -f "$UNIT" /etc/systemd/system/headscale-console-update.{service,path} /usr/local/sbin/headscale-console-update /usr/local/bin/hsconsole
  rm -rf "$DEST"
  systemctl daemon-reload
  if [[ $PURGE == 1 ]]; then
    rm -rf /var/lib/headscale-console /var/lib/headscale-console-update
    userdel headscale-console 2>/dev/null || true
    echo "Removed, including the audit log and policy history."
  else
    echo "Removed. The audit log and policy history are still in /var/lib/headscale-console (use --purge to delete them)."
  fi
  exit 0
fi

# Validate input before it reaches sed and the systemd unit.
if [[ -n $HS_URL && ! $HS_URL =~ ^https?://[A-Za-z0-9.-]+(:[0-9]+)?(/[A-Za-z0-9._~/-]*)?$ ]]; then
  die "--url must look like https://hs.example.com (got: $HS_URL)"
fi
[[ $PORT =~ ^[0-9]+$ && $PORT -ge 1 && $PORT -le 65535 ]] || die "--port must be a number between 1 and 65535."
[[ $HOST_ACTIONS == 0 || -n $HS_URL ]] || die "--host-actions needs --url."

if ! command -v node >/dev/null || [[ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]]; then
  echo "Node.js 20 or newer is required. Install it first, e.g.:" >&2
  echo "  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs" >&2
  exit 1
fi

if [[ ! -f $SRC_DIR/dist/server/server.js || ! -f $SRC_DIR/public/js/client/app.js ]]; then
  step "Building (TypeScript → JavaScript)"
  command -v npm >/dev/null || die "npm is needed to build. Install Node.js with npm, or copy a built release."
  (cd "$SRC_DIR" && npm ci --no-audit --no-fund && npm run build)
fi
[[ -f $SRC_DIR/public/ssh/hp_ssh.wasm ]] || echo "Note: Browser SSH is off until you build its client: scripts/build-ssh.sh (needs Go)."

step "Installing to $DEST"
id headscale-console >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin headscale-console
rm -rf "$DEST.new"
mkdir -p "$DEST.new"
cp -r "$SRC_DIR/dist" "$SRC_DIR/public" "$SRC_DIR/package.json" "$DEST.new/"
rm -rf "$DEST"
mv "$DEST.new" "$DEST"
chown -R root:root "$DEST"
chmod -R a+rX "$DEST"
chmod 0755 "$DEST/dist/cli/hsconsole.js"
ln -sf "$DEST/dist/cli/hsconsole.js" /usr/local/bin/hsconsole

step "Configuring the service"
install -m 0644 "$SRC_DIR/deploy/headscale-console.service" "$UNIT"
sed -i "s|^Environment=PORT=.*|Environment=PORT=${PORT}|" "$UNIT"
[[ -z $HS_URL ]] || sed -i "s|^# Environment=HEADSCALE_URL=.*|Environment=HEADSCALE_URL=${HS_URL}|" "$UNIT"

if [[ $HOST_ACTIONS == 1 ]]; then
  step "Enabling host actions (logs + updates)"
  sed -i "s|^# Environment=HOST_ACTIONS=.*|Environment=HOST_ACTIONS=true|" "$UNIT"
  install -o root -g root -m 0755 "$SRC_DIR/deploy/headscale-update.sh" /usr/local/sbin/headscale-console-update
  install -o root -g root -m 0644 "$SRC_DIR/deploy/headscale-console-update.service" "$SRC_DIR/deploy/headscale-console-update.path" /etc/systemd/system/
  systemctl daemon-reload
  systemctl enable --now headscale-console-update.path
fi

systemctl daemon-reload
systemctl enable headscale-console >/dev/null
systemctl restart headscale-console

step "Checking it's up"
for _ in $(seq 1 20); do
  if node -e "fetch('http://127.0.0.1:${PORT}/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"; then
    echo
    echo "Headscale Console is running: http://$(hostname -I | awk '{print $1}'):${PORT}"
    [[ -n $HS_URL ]] && echo "Locked to $HS_URL" || echo "Tip: re-run with --url https://your-headscale to lock it to your server."
    echo "CLI: hsconsole help"
    exit 0
  fi
  sleep 0.5
done
systemctl --no-pager --lines=20 status headscale-console || true
die "the service didn't answer on port ${PORT}; see the log above (journalctl -u headscale-console)."
