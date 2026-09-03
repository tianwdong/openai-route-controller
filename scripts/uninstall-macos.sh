#!/bin/sh
set -eu

PLIST_PATH=${PLIST_PATH:-"$HOME/Library/LaunchAgents/com.local.openai-route-controller.plist"}
SERVICE_ID="com.local.openai-route-controller"
DOMAIN="gui/$(id -u)"

if launchctl print "$DOMAIN/$SERVICE_ID" >/dev/null 2>&1; then
  launchctl bootout "$DOMAIN/$SERVICE_ID"
fi

if [ -e "$PLIST_PATH" ]; then
  DISABLED_PATH="$PLIST_PATH.disabled.$(date '+%Y%m%d-%H%M%S')"
  mv "$PLIST_PATH" "$DISABLED_PATH"
  echo "LaunchAgent disabled and preserved at: $DISABLED_PATH"
else
  echo "LaunchAgent was not installed: $PLIST_PATH"
fi

echo "Controller state and logs were preserved. Remove them manually after review if desired."
