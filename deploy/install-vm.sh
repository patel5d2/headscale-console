#!/usr/bin/env bash
# Installs Headscale Console as a systemd service on a Debian/Ubuntu VM.
# Usage: sudo ./deploy/install-vm.sh [https://your-headscale-url]
set -euo pipefail

SRC_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DEST=/opt/headscale-console
HS_URL="${1:-}"

if [[ $EUID -ne 0 ]]; then echo "Run as root (sudo)." >&2; exit 1; fi

if ! command -v node >/dev/null || [[ "$(node -p 'process.versions.node.split(".")[0]')" -lt 18 ]]; then
  echo "Node.js 18+ is required. Install it first, e.g.:"
  echo "  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs"
  exit 1
fi

id headscale-console >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin headscale-console

mkdir -p "$DEST"
cp -r "$SRC_DIR/server.js" "$SRC_DIR/package.json" "$SRC_DIR/public" "$DEST/"
chown -R root:root "$DEST"
chmod -R a+rX "$DEST"

cp "$SRC_DIR/deploy/headscale-console.service" /etc/systemd/system/headscale-console.service
if [[ -n "$HS_URL" ]]; then
  sed -i "s|^# Environment=HEADSCALE_URL=.*|Environment=HEADSCALE_URL=${HS_URL}|" /etc/systemd/system/headscale-console.service
fi

systemctl daemon-reload
systemctl enable --now headscale-console
sleep 1
systemctl --no-pager --lines=5 status headscale-console || true
echo
echo "Headscale Console is running on http://$(hostname -I | awk '{print $1}'):8090"
