#!/usr/bin/env sh
# Install deepseek-code from the latest GitHub release (no git required).
#
#   curl -fsSL https://raw.githubusercontent.com/kwlcode/deepseek-code/main/scripts/install.sh | sh
#   ./scripts/install.sh ./deepseek-code-0.1.0.tgz
#
# Env: REPO=owner/repo (default kwlcode/deepseek-code), NO_GLOBAL=1 to install
# into the current project instead of globally.
set -eu

REPO="${REPO:-kwlcode/deepseek-code}"
TARBALL="${1:-}"

if [ -z "$TARBALL" ]; then
  url=$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" 2>/dev/null \
    | grep -o '"browser_download_url": *"[^"]*\.tgz"' \
    | head -n 1 \
    | sed 's/.*"\(https[^"]*\)".*/\1/') || true

  if [ -z "$url" ]; then
    echo "No published release with a .tgz asset found for $REPO." >&2
    echo "Install from git instead: npm install -g github:$REPO" >&2
    exit 1
  fi

  tmp=$(mktemp -d)
  TARBALL="$tmp/$(basename "$url")"
  echo "Downloading $(basename "$url") from the latest release ..."
  curl -fsSL "$url" -o "$TARBALL"
elif [ ! -f "$TARBALL" ]; then
  echo "No such file: $TARBALL" >&2
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo 'npm was not found on PATH. Install Node.js 18.17 or newer first: https://nodejs.org' >&2
  exit 1
fi

if [ "${NO_GLOBAL:-0}" = "1" ]; then
  echo "Installing $TARBALL into the current project ..."
  npm install "$TARBALL"
else
  echo "Installing $TARBALL globally ..."
  npm install -g "$TARBALL"
fi

echo
echo 'Installed. Check it with: deepseek-code doctor'
