#!/usr/bin/env bash
# Builds the Browser SSH WebAssembly client into public/ssh/ (or the directory given).
# The client is Tailscale's tsconnect, as packaged by Headplane (MIT, github.com/tale/headplane),
# pinned to a commit. Usage: scripts/build-ssh.sh [out-dir]
set -euo pipefail

HEADPLANE_REF=fc6f6ce4f6006d3eff50f042c41f9a1cf928dc6c
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

if [[ ${1:-} == -h || ${1:-} == --help ]]; then
  sed -n '2,4p' "$0" | sed 's/^# \{0,1\}//'
  exit 0
fi
missing=()
for tool in git go patch gzip; do command -v "$tool" >/dev/null || missing+=("$tool"); done
if [[ ${#missing[@]} -gt 0 ]]; then
  echo "Missing: ${missing[*]}. Install them first (Go from https://go.dev/dl/)." >&2
  exit 1
fi

OUT="$(mkdir -p "${1:-$ROOT/public/ssh}" && cd "${1:-$ROOT/public/ssh}" && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "==> Fetching Headplane ${HEADPLANE_REF:0:12}"
git -C "$WORK" init -q
git -C "$WORK" fetch -q --depth 1 https://github.com/tale/headplane.git "$HEADPLANE_REF"
git -C "$WORK" checkout -q FETCH_HEAD
# Compile out logtail so the browser never uploads Tailscale debug logs to log.tailscale.io.
printf '%s,ts_omit_logtail\n' "$(tr -d '\n' < "$WORK/cmd/hp_ssh/build-tags.txt")" > "$WORK/cmd/hp_ssh/build-tags.txt"
(cd "$WORK" && ./build.sh --wasm --wasm-output "$OUT/hp_ssh.wasm")
gzip -9 -f -k "$OUT/hp_ssh.wasm"
cp "$WORK/LICENSE" "$OUT/LICENSE.headplane"
echo "Browser SSH client written to $OUT ($(du -h "$OUT/hp_ssh.wasm.gz" | cut -f1) gzipped)"
