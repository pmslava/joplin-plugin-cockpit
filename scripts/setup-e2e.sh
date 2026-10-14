#!/usr/bin/env bash
#
# Downloads and extracts the Joplin desktop AppImage used by the real-app E2E tests, and downloads the
# released Jot plugin (.jpl) that the Jot integration spec installs beside Cockpit.
# Idempotent: skips each download/extract when its result already exists.
#
# Override the versions with JOPLIN_E2E_VERSION (must be >= the plugin's app_min_version) and
# JOT_E2E_VERSION (a Jot release whose jot.open contract Cockpit calls).
#
set -euo pipefail

JOPLIN_VERSION="${JOPLIN_E2E_VERSION:-3.6.14}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CACHE_DIR="$REPO_ROOT/.e2e-cache"
APPIMAGE="$CACHE_DIR/Joplin.AppImage"
BINARY="$CACHE_DIR/squashfs-root/joplin"
URL="https://github.com/laurent22/joplin/releases/download/v${JOPLIN_VERSION}/Joplin-${JOPLIN_VERSION}.AppImage"
JOT_VERSION="${JOT_E2E_VERSION:-0.2.2}"
JOT_JPL="$CACHE_DIR/io.github.pmslava.jot.jpl"
JOT_URL="https://github.com/pmslava/joplin-plugin-jot/releases/download/v${JOT_VERSION}/io.github.pmslava.jot.jpl"

mkdir -p "$CACHE_DIR"

# Jot first, because the Joplin half below exits early once the AppImage is extracted, which on a
# developer machine is every run but the first.
if [ ! -f "$JOT_JPL" ]; then
  echo "[setup-e2e] Downloading Jot $JOT_VERSION ..."
  # Same rules as the AppImage below: fail on an HTTP error, retry blips, never cache a partial file.
  if ! curl -fSL --retry 3 --retry-delay 2 -o "$JOT_JPL" "$JOT_URL"; then
    echo "[setup-e2e] ERROR: failed to download Jot $JOT_VERSION from $JOT_URL" >&2
    rm -f "$JOT_JPL"
    exit 1
  fi
  # A .jpl is a tar of the built plugin, about 120 KB; a few KB is an error page that slipped through.
  if [ "$(stat -c%s "$JOT_JPL" 2>/dev/null || echo 0)" -lt 20000 ]; then
    echo "[setup-e2e] ERROR: downloaded Jot plugin is implausibly small — treating as a failed download" >&2
    rm -f "$JOT_JPL"
    exit 1
  fi
else
  echo "[setup-e2e] Jot already at $JOT_JPL — nothing to do."
fi

if [ -x "$BINARY" ]; then
  echo "[setup-e2e] Joplin already extracted at $BINARY — nothing to do."
  exit 0
fi

if [ ! -f "$APPIMAGE" ]; then
  echo "[setup-e2e] Downloading Joplin $JOPLIN_VERSION ..."
  # -f: fail (non-zero exit) on an HTTP error such as a 404 for a mistyped/withdrawn version, rather
  # than silently saving the error page as "Joplin.AppImage" and failing confusingly at extract time.
  # --retry: ride out transient network/CDN blips. rm on failure so a partial file is not cached.
  if ! curl -fSL --retry 3 --retry-delay 2 -o "$APPIMAGE" "$URL"; then
    echo "[setup-e2e] ERROR: failed to download Joplin $JOPLIN_VERSION from $URL" >&2
    rm -f "$APPIMAGE"
    exit 1
  fi
  # A valid AppImage is well over 100 MB; anything tiny is an error page that slipped through.
  if [ "$(stat -c%s "$APPIMAGE" 2>/dev/null || echo 0)" -lt 10000000 ]; then
    echo "[setup-e2e] ERROR: downloaded AppImage is implausibly small — treating as a failed download" >&2
    rm -f "$APPIMAGE"
    exit 1
  fi
  chmod +x "$APPIMAGE"
fi

echo "[setup-e2e] Extracting AppImage (no FUSE required) ..."
( cd "$CACHE_DIR" && "$APPIMAGE" --appimage-extract >/dev/null )

if [ ! -x "$BINARY" ]; then
  echo "[setup-e2e] ERROR: expected Electron binary not found at $BINARY" >&2
  exit 1
fi

echo "[setup-e2e] Ready: $BINARY"
