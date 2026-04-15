#!/usr/bin/env bash
# lucerna installer — macOS & Linux
#
# Usage (one-liner):
#   curl -fsSL https://raw.githubusercontent.com/upstart-gg/lucerna/main/install/install.sh | bash
#
# Environment overrides:
#   INSTALL_DIR   — where to install the binary (default: /usr/local/bin)
#   LUCERNA_TAG   — specific release tag to install (default: latest)

set -euo pipefail

REPO="upstart-gg/lucerna"
BINARY_NAME="lucerna"
INSTALL_DIR="${INSTALL_DIR:-/usr/local/bin}"

# ── Helpers ────────────────────────────────────────────────────────────────────

info()  { printf '\033[1;34m→\033[0m  %s\n' "$*"; }
ok()    { printf '\033[1;32m✓\033[0m  %s\n' "$*"; }
error() { printf '\033[1;31m✗\033[0m  %s\n' "$*" >&2; }
die()   { error "$*"; exit 1; }

# ── Platform detection ─────────────────────────────────────────────────────────

OS="$(uname -s)"
ARCH="$(uname -m)"

case "$OS" in
  Darwin)
    case "$ARCH" in
      arm64)           BINARY="lucerna-darwin-arm64" ;;
      x86_64)          BINARY="lucerna-darwin-x64" ;;
      *) die "Unsupported macOS architecture: $ARCH" ;;
    esac
    ;;
  Linux)
    # Detect musl (Alpine) vs glibc
    LIBC="glibc"
    if ldd --version 2>&1 | grep -q musl 2>/dev/null; then
      LIBC="musl"
    elif [ -f /etc/alpine-release ]; then
      LIBC="musl"
    fi

    case "$ARCH" in
      x86_64)
        [ "$LIBC" = "musl" ] && BINARY="lucerna-linux-x64-musl" || BINARY="lucerna-linux-x64"
        ;;
      aarch64|arm64)
        [ "$LIBC" = "musl" ] && BINARY="lucerna-linux-arm64-musl" || BINARY="lucerna-linux-arm64"
        ;;
      *) die "Unsupported Linux architecture: $ARCH" ;;
    esac
    ;;
  *)
    die "Unsupported OS: $OS. For Windows, use install.ps1."
    ;;
esac

# ── Resolve release tag ────────────────────────────────────────────────────────

if [ -n "${LUCERNA_TAG:-}" ]; then
  TAG="$LUCERNA_TAG"
else
  info "Fetching latest release…"
  API_URL="https://api.github.com/repos/${REPO}/releases/latest"

  if command -v curl &>/dev/null; then
    TAG="$(curl -fsSL "$API_URL" | grep '"tag_name"' | sed 's/.*"tag_name": *"\([^"]*\)".*/\1/')"
  elif command -v wget &>/dev/null; then
    TAG="$(wget -qO- "$API_URL" | grep '"tag_name"' | sed 's/.*"tag_name": *"\([^"]*\)".*/\1/')"
  else
    die "Neither curl nor wget is available. Please install one and retry."
  fi

  [ -n "$TAG" ] || die "Could not determine the latest release tag."
fi

DOWNLOAD_URL="https://github.com/${REPO}/releases/download/${TAG}/${BINARY}"

# ── Download ───────────────────────────────────────────────────────────────────

TMP_FILE="$(mktemp)"
trap 'rm -f "$TMP_FILE"' EXIT

info "Downloading $BINARY ($TAG)…"

if command -v curl &>/dev/null; then
  curl -fsSL --progress-bar "$DOWNLOAD_URL" -o "$TMP_FILE" || die "Download failed: $DOWNLOAD_URL"
elif command -v wget &>/dev/null; then
  wget -q --show-progress "$DOWNLOAD_URL" -O "$TMP_FILE" || die "Download failed: $DOWNLOAD_URL"
else
  die "Neither curl nor wget is available."
fi

chmod +x "$TMP_FILE"

# ── Install ────────────────────────────────────────────────────────────────────

install_to() {
  local dir="$1"
  local dest="${dir}/${BINARY_NAME}"

  if [ -w "$dir" ]; then
    mv "$TMP_FILE" "$dest"
  else
    info "Requesting sudo to write to $dir…"
    sudo mv "$TMP_FILE" "$dest"
    sudo chmod +x "$dest"
  fi

  ok "Installed to $dest"
}

if [ -d "$INSTALL_DIR" ]; then
  install_to "$INSTALL_DIR"
else
  # Fallback: try ~/.local/bin
  FALLBACK_DIR="${HOME}/.local/bin"
  if mkdir -p "$FALLBACK_DIR" 2>/dev/null; then
    info "$INSTALL_DIR does not exist; falling back to $FALLBACK_DIR"
    install_to "$FALLBACK_DIR"

    # Hint if not in PATH
    case ":${PATH}:" in
      *":${FALLBACK_DIR}:"*) ;;
      *)
        printf '\n\033[1;33m!\033[0m  Add %s to your PATH:\n' "$FALLBACK_DIR"
        printf '     export PATH="%s:$PATH"\n\n' "$FALLBACK_DIR"
        ;;
    esac
  else
    die "Cannot create install directory. Set INSTALL_DIR to a writable path and retry."
  fi
fi

# ── Verify ─────────────────────────────────────────────────────────────────────

if command -v lucerna &>/dev/null; then
  VERSION="$(lucerna --version 2>/dev/null || true)"
  ok "lucerna ${VERSION} is ready."
else
  ok "Installation complete. Open a new shell or update your PATH to use lucerna."
fi
