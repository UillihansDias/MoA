#!/bin/bash

set -euo pipefail

HOME_DIR="${HOME:?HOME must be set}"
APP_DIR="$HOME_DIR/.MoA"
SERVICE_LABEL="com.uillihansdias.moa-webui"
DOMAIN="gui/$(id -u)"
PLIST_SOURCE="$APP_DIR/macos/$SERVICE_LABEL.plist"
PLIST_DIR="$HOME_DIR/Library/LaunchAgents"
PLIST_TARGET="$PLIST_DIR/$SERVICE_LABEL.plist"
STATUS_URL="http://127.0.0.1:4317/api/health"

service_healthy() {
  /usr/bin/curl --silent --fail --max-time 2 "$STATUS_URL" >/dev/null 2>&1
}

install_service() {
  mkdir -p "$PLIST_DIR"
  chmod 700 "$PLIST_DIR"

  local definition_changed=0
  if [ ! -f "$PLIST_TARGET" ] || ! cmp -s "$PLIST_SOURCE" "$PLIST_TARGET"; then
    /bin/cp "$PLIST_SOURCE" "$PLIST_TARGET"
    chmod 600 "$PLIST_TARGET"
    definition_changed=1
  fi

  local loaded_definition=''
  loaded_definition=$(launchctl print "$DOMAIN/$SERVICE_LABEL" 2>/dev/null || true)
  if [ "$definition_changed" -eq 1 ] || \
     [ -z "$loaded_definition" ] || \
     ! printf '%s\n' "$loaded_definition" | /usr/bin/grep -Fq "path = $PLIST_TARGET"; then
    launchctl bootout "$DOMAIN/$SERVICE_LABEL" >/dev/null 2>&1 || true
    launchctl bootstrap "$DOMAIN" "$PLIST_TARGET"
  fi

  launchctl enable "$DOMAIN/$SERVICE_LABEL" >/dev/null 2>&1 || true
}

start_service() {
  install_service
  if service_healthy; then
    exit 0
  fi

  launchctl kickstart -k "$DOMAIN/$SERVICE_LABEL" >/dev/null 2>&1 || true

  for _ in {1..60}; do
    if service_healthy; then
      exit 0
    fi
    sleep 0.25
  done

  printf 'MoA service failed to become ready. Review %s\n' "$APP_DIR/moa-webui.log" >&2
  exit 1
}

case "${1:-start}" in
  start) start_service ;;
  install) start_service ;;
  status) service_healthy ;;
  *) printf 'Usage: %s [start|install|status]\n' "$0" >&2; exit 2 ;;
esac
