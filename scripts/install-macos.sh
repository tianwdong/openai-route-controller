#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_DIR=$(dirname "$SCRIPT_DIR")
INSTALL_DIR=${INSTALL_DIR:-"$HOME/Library/Application Support/OpenAI Route Controller"}
PLIST_PATH=${PLIST_PATH:-"$HOME/Library/LaunchAgents/com.local.openai-route-controller.plist"}
MIHOMO_SOCKET=${MIHOMO_SOCKET:-/tmp/verge/verge-mihomo.sock}
MIHOMO_PROXY=${MIHOMO_PROXY:-http://127.0.0.1:7897}
OPENAI_GROUP=${OPENAI_GROUP:-OpenAI 自动选择}
MACOS_SYSTEM_PROXY_SYNC=${MACOS_SYSTEM_PROXY_SYNC:-0}
MACOS_PROXY_SERVICES=${MACOS_PROXY_SERVICES:-Wi-Fi}
NETWORK_TRANSITION_GRACE_MS=${NETWORK_TRANSITION_GRACE_MS:-20000}
SERVICE_ID="com.local.openai-route-controller"

if [ "$(uname -s)" != "Darwin" ]; then
  echo "This installer is for macOS." >&2
  exit 1
fi

NODE_PATH=$(command -v node || true)
CURL_PATH=$(command -v curl || true)
if [ -z "$NODE_PATH" ]; then
  echo "Node.js 22 or newer is required." >&2
  exit 1
fi
if [ -z "$CURL_PATH" ]; then
  echo "curl is required." >&2
  exit 1
fi
NODE_MAJOR=$(node -p 'Number(process.versions.node.split(".")[0])')
if [ "$NODE_MAJOR" -lt 22 ]; then
  echo "Node.js 22 or newer is required; found $(node --version)." >&2
  exit 1
fi
if [ ! -S "$MIHOMO_SOCKET" ]; then
  echo "Mihomo socket not found: $MIHOMO_SOCKET" >&2
  echo "Set MIHOMO_SOCKET to the socket shown by Clash Verge Rev." >&2
  exit 1
fi

cd "$REPO_DIR"
npm run verify

SHADOW_DIR=$(mktemp -d "${TMPDIR:-/tmp}/openai-route-controller.XXXXXX")
trap 'rm -rf "$SHADOW_DIR"' EXIT HUP INT TERM
MIHOMO_SOCKET="$MIHOMO_SOCKET" \
MIHOMO_PROXY="$MIHOMO_PROXY" \
OPENAI_GROUP="$OPENAI_GROUP" \
MACOS_SYSTEM_PROXY_SYNC="$MACOS_SYSTEM_PROXY_SYNC" \
MACOS_PROXY_SERVICES="$MACOS_PROXY_SERVICES" \
NETWORK_TRANSITION_GRACE_MS="$NETWORK_TRANSITION_GRACE_MS" \
STATE_PATH="$SHADOW_DIR/state.json" \
CURL_PATH="$CURL_PATH" \
"$NODE_PATH" "$REPO_DIR/controller.mjs" --once --shadow

TIMESTAMP=$(date '+%Y%m%d-%H%M%S')
BACKUP_DIR="$INSTALL_DIR/backups/$TIMESTAMP"
mkdir -p "$INSTALL_DIR" "$(dirname "$PLIST_PATH")"
chmod 700 "$INSTALL_DIR"

if [ -e "$INSTALL_DIR/controller.mjs" ] || [ -e "$INSTALL_DIR/lib.mjs" ] || [ -e "$PLIST_PATH" ]; then
  mkdir -p "$BACKUP_DIR"
  [ ! -e "$INSTALL_DIR/controller.mjs" ] || cp "$INSTALL_DIR/controller.mjs" "$BACKUP_DIR/controller.mjs"
  [ ! -e "$INSTALL_DIR/lib.mjs" ] || cp "$INSTALL_DIR/lib.mjs" "$BACKUP_DIR/lib.mjs"
  [ ! -e "$PLIST_PATH" ] || cp "$PLIST_PATH" "$BACKUP_DIR/$(basename "$PLIST_PATH")"
  echo "Existing files backed up to: $BACKUP_DIR"
fi

cp "$REPO_DIR/controller.mjs" "$INSTALL_DIR/controller.mjs"
cp "$REPO_DIR/lib.mjs" "$INSTALL_DIR/lib.mjs"
chmod 600 "$INSTALL_DIR/controller.mjs" "$INSTALL_DIR/lib.mjs"

escape_sed() {
  printf '%s' "$1" | sed 's/[\\&|]/\\&/g'
}

PLIST_TEMP=$(mktemp "${TMPDIR:-/tmp}/openai-route-controller-plist.XXXXXX")
sed \
  -e "s|__NODE_PATH__|$(escape_sed "$NODE_PATH")|g" \
  -e "s|__INSTALL_DIR__|$(escape_sed "$INSTALL_DIR")|g" \
  -e "s|__MIHOMO_SOCKET__|$(escape_sed "$MIHOMO_SOCKET")|g" \
  -e "s|__MIHOMO_PROXY__|$(escape_sed "$MIHOMO_PROXY")|g" \
  -e "s|__OPENAI_GROUP__|$(escape_sed "$OPENAI_GROUP")|g" \
  -e "s|__MACOS_SYSTEM_PROXY_SYNC__|$(escape_sed "$MACOS_SYSTEM_PROXY_SYNC")|g" \
  -e "s|__MACOS_PROXY_SERVICES__|$(escape_sed "$MACOS_PROXY_SERVICES")|g" \
  -e "s|__NETWORK_TRANSITION_GRACE_MS__|$(escape_sed "$NETWORK_TRANSITION_GRACE_MS")|g" \
  -e "s|__CURL_PATH__|$(escape_sed "$CURL_PATH")|g" \
  "$REPO_DIR/launchd/com.local.openai-route-controller.plist.template" \
  > "$PLIST_TEMP"
plutil -lint "$PLIST_TEMP"
mv "$PLIST_TEMP" "$PLIST_PATH"
chmod 600 "$PLIST_PATH"

DOMAIN="gui/$(id -u)"
if launchctl print "$DOMAIN/$SERVICE_ID" >/dev/null 2>&1; then
  launchctl bootout "$DOMAIN/$SERVICE_ID"
fi
launchctl bootstrap "$DOMAIN" "$PLIST_PATH"
launchctl kickstart -k "$DOMAIN/$SERVICE_ID"

echo "Installed and started $SERVICE_ID"
echo "Status: launchctl print $DOMAIN/$SERVICE_ID"
echo "Log: $INSTALL_DIR/controller.log"
