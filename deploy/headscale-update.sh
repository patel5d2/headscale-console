#!/usr/bin/env bash
# Root helper behind Headscale Console's "Update Headscale" button.
# Run by headscale-console-update.service when the console writes a version to
# $REQUEST. Nothing in that file is trusted except a strictly validated version.
# Steps: download the official .deb from GitHub, verify it against the release's
# checksums.txt, back up the SQLite database, install, and roll back (old .deb +
# database backup) if Headscale doesn't come back up.
set -euo pipefail
umask 022

REQUEST=/var/lib/headscale-console/update-request
OUT=/var/lib/headscale-console-update            # root-owned; the console only reads it
UNIT=${HEADSCALE_UNIT:-headscale}
DB=${HEADSCALE_DB:-/var/lib/headscale/db.sqlite}
REPO=https://github.com/juanfont/headscale/releases/download
SEMVER='^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$'

[[ -f $REQUEST && ! -L $REQUEST ]] || exit 0     # removing the file re-triggers us; nothing to do
VERSION=$(head -c 16 "$REQUEST" | tr -d '[:space:]')
rm -f "$REQUEST"
[[ $VERSION =~ $SEMVER ]] || { echo "Ignoring invalid update request" >&2; exit 1; }

mkdir -p "$OUT" && chmod 755 "$OUT"
exec > >(tee "$OUT/update.log") 2>&1

FROM=$(headscale version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -n1 || true)
ARCH=$(dpkg --print-architecture)
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

status() { # state message — messages are fixed strings, so this is valid JSON
  printf '{"state":"%s","from":"%s","to":"%s","at":"%s","message":"%s"}\n' \
    "$1" "$FROM" "$VERSION" "$(date -u +%FT%TZ)" "$2" > "$OUT/status.json.tmp"
  mv -f "$OUT/status.json.tmp" "$OUT/status.json"
}

fetch_deb() { # version -> prints path of a checksum-verified .deb
  local v=$1 deb="headscale_${1}_linux_${ARCH}.deb" dir="$WORK/$1"
  mkdir -p "$dir"
  curl -fsSL --proto '=https' --tlsv1.2 -o "$dir/$deb" "$REPO/v$v/$deb" &&
    curl -fsSL --proto '=https' --tlsv1.2 -o "$dir/checksums.txt" "$REPO/v$v/checksums.txt" &&
    (cd "$dir" && awk -v f="$deb" '$2 == f' checksums.txt | sha256sum -c --status) || {
      echo "Download or checksum verification failed for $deb" >&2; return 1; }
  echo "$dir/$deb"
}

echo "Headscale update: ${FROM:-unknown} -> $VERSION ($(date -u +%FT%TZ))"
if [[ $FROM == "$VERSION" ]]; then status done "Already on this version"; exit 0; fi
status running "Downloading"

# Phase 1: download + verify. Headscale is untouched if anything here fails.
NEW_DEB=$(fetch_deb "$VERSION") || { status failed "Download or checksum failed; Headscale was not changed"; exit 1; }
OLD_DEB=""
if [[ $FROM =~ $SEMVER ]]; then
  OLD_DEB=$(fetch_deb "$FROM") || echo "Warning: could not fetch $FROM; automatic rollback will not reinstall it"
fi
echo "Verified $(basename "$NEW_DEB")"

# Phase 2: stop, back up, install, start.
status running "Installing"
systemctl stop "$UNIT"
BACKUP=""
if [[ -f $DB ]]; then
  BACKUP="$DB.pre-$VERSION.$(date +%Y%m%d%H%M%S).bak"
  if ! cp -a "$DB" "$BACKUP"; then
    systemctl start "$UNIT"; status failed "Database backup failed; Headscale was not changed"; exit 1
  fi
  echo "Database backed up to $BACKUP"
else
  echo "No SQLite database at $DB (PostgreSQL?) - skipping backup"
fi

if DEBIAN_FRONTEND=noninteractive dpkg --force-confold -i "$NEW_DEB" &&
   systemctl start "$UNIT" && sleep 8 && systemctl is-active --quiet "$UNIT"; then
  echo "Headscale $VERSION is running"
  status done "Updated"
  exit 0
fi

echo "Headscale did not start after the update - rolling back"
systemctl --no-pager --lines=20 status "$UNIT" || true
systemctl stop "$UNIT" || true
if [[ -n $BACKUP ]]; then rm -f "$DB-wal" "$DB-shm"; cp -a "$BACKUP" "$DB"; fi
if [[ -n $OLD_DEB ]]; then
  DEBIAN_FRONTEND=noninteractive dpkg --force-confold --force-downgrade -i "$OLD_DEB"
  systemctl start "$UNIT" || true
  status failed "Update failed; rolled back"
else
  systemctl start "$UNIT" || true
  status failed "Update failed and the previous version could not be reinstalled"
fi
exit 1
