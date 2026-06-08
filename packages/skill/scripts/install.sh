#!/bin/sh
# Chorum standalone-binary installer.
#
# Downloads the prebuilt `chorum-skill` binary for this machine and makes it
# runnable — no Python, pip, or Node required. This is step 1 of 2:
#
#   1. curl -fsSL https://github.com/josojo/chorum/releases/latest/download/install.sh | sh
#   2. chorum-skill install        # drops the skill/plugin into Hermes/OpenClaw
#   (then: chorum-skill onboard ...   # one-time Self identity setup)
#
# Env overrides:
#   CHORUM_VERSION   release tag to install (default: latest)
#   CHORUM_BIN_DIR   install dir (default: ~/.local/bin)
#   CHORUM_REPO      owner/repo (default: josojo/chorum)
set -eu

REPO="${CHORUM_REPO:-josojo/chorum}"
VERSION="${CHORUM_VERSION:-latest}"
BIN_DIR="${CHORUM_BIN_DIR:-$HOME/.local/bin}"
NAME="chorum-skill"

os="$(uname -s)"
arch="$(uname -m)"

case "$os" in
  Linux) os_tag="linux" ;;
  *)
    echo "chorum: only Linux prebuilt binaries are published (got '$os')." >&2
    echo "        On macOS/Windows, install from source: pip install 'git+https://github.com/${REPO}.git#subdirectory=packages/skill'" >&2
    exit 1
    ;;
esac

case "$arch" in
  x86_64 | amd64) arch_tag="x86_64" ;;
  aarch64 | arm64) arch_tag="aarch64" ;;
  *)
    echo "chorum: unsupported architecture '$arch' (have x86_64, aarch64)." >&2
    exit 1
    ;;
esac

asset="${NAME}-${os_tag}-${arch_tag}"
if [ "$VERSION" = "latest" ]; then
  url="https://github.com/${REPO}/releases/latest/download/${asset}"
else
  url="https://github.com/${REPO}/releases/download/${VERSION}/${asset}"
fi

mkdir -p "$BIN_DIR"
tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT

echo "chorum: downloading ${asset} (${VERSION})..."
if command -v curl >/dev/null 2>&1; then
  curl -fsSL "$url" -o "$tmp"
elif command -v wget >/dev/null 2>&1; then
  wget -qO "$tmp" "$url"
else
  echo "chorum: need curl or wget to download." >&2
  exit 1
fi

chmod +x "$tmp"
mv "$tmp" "$BIN_DIR/$NAME"
trap - EXIT
echo "chorum: installed $BIN_DIR/$NAME"

case ":$PATH:" in
  *":$BIN_DIR:"*) : ;;
  *)
    echo "chorum: NOTE — $BIN_DIR is not on your PATH. Add it, e.g.:" >&2
    echo "        export PATH=\"$BIN_DIR:\$PATH\"" >&2
    ;;
esac

echo ""
echo "Next:"
echo "  $NAME install        # add the skill/plugin to your Hermes/OpenClaw agent"
echo "  $NAME onboard --broker-url <url> --bridge-url <url>   # one-time identity setup"
