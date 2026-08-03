#!/bin/bash

set -euo pipefail

SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
HOME_DIR="${HOME:?HOME must be set}"
INSTALL_DIR="$HOME_DIR/.MoA"
APP_BUNDLE="$INSTALL_DIR/MoA.app"
BUNDLE_IDENTIFIER="com.uillihansdias.moa"

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    printf 'Missing required command: %s\n' "$1" >&2
    exit 1
  fi
}

add_to_dock() {
  if [ "${MOA_SKIP_DOCK:-0}" = "1" ]; then
    printf 'Skipped adding MoA to the Dock (MOA_SKIP_DOCK=1).\n'
    return
  fi

  local app_url dock_entries dock_item
  app_url=$(MOA_DOCK_APP_PATH="$APP_BUNDLE" /usr/bin/osascript -l JavaScript <<'JXA'
ObjC.import('Foundation');
const environment = $.NSProcessInfo.processInfo.environment;
const appPath = ObjC.unwrap(environment.objectForKey('MOA_DOCK_APP_PATH'));
ObjC.unwrap($.NSURL.fileURLWithPath(appPath).absoluteString);
JXA
)
  case "$app_url" in */) ;; *) app_url="$app_url/" ;; esac

  dock_entries=$(/usr/bin/defaults read com.apple.dock persistent-apps 2>/dev/null || true)
  if printf '%s\n' "$dock_entries" | /usr/bin/grep -Fq "\"bundle-identifier\" = \"$BUNDLE_IDENTIFIER\";" || \
     printf '%s\n' "$dock_entries" | /usr/bin/grep -Fq "\"_CFURLString\" = \"$app_url\";"; then
    printf 'MoA is already present in the Dock.\n'
    return
  fi

  dock_item="{tile-data={\"bundle-identifier\"=\"$BUNDLE_IDENTIFIER\";file-data={_CFURLString=\"$app_url\";_CFURLStringType=15;};file-label=\"MoA\";};tile-type=\"file-tile\";}"
  /usr/bin/defaults write com.apple.dock persistent-apps -array-add "$dock_item"
  /usr/bin/killall Dock >/dev/null 2>&1 || true
  printf 'Added %s to the Dock.\n' "$APP_BUNDLE"
}

if [ "$(uname -s)" != "Darwin" ]; then
  echo "MoA's desktop installer requires macOS."
  exit 1
fi

for command in node npm rsync xcrun codesign; do
  require_command "$command"
done

if ! node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 22 || major === 22 && minor >= 12 || major === 20 && minor >= 19 ? 0 : 1)'; then
  printf 'MoA requires Node.js 20.19+ or 22.12+. Current version: %s\n' "$(node --version)" >&2
  exit 1
fi

if [ "$SOURCE_DIR" = "$INSTALL_DIR" ]; then
  echo "Refusing to install from inside $INSTALL_DIR. Clone the repository elsewhere and run install.sh from that clone."
  exit 1
fi

mkdir -p "$INSTALL_DIR"
chmod 700 "$INSTALL_DIR"

/usr/bin/rsync -a \
  --delete \
  --checksum \
  --exclude '.git/' \
  --exclude '.github/' \
  --exclude 'node_modules/' \
  --exclude 'dist/' \
  --exclude 'MoA.app/' \
  --exclude '*.log' \
  --exclude '.DS_Store' \
  --exclude '.env' \
  --exclude '.env.*' \
  --exclude 'MoA_WebCodeContextBundle.txt' \
  --exclude '.MoA_WebCodeContextBundle.txt' \
  --exclude '.MoA_CodeContextBundle.txt' \
  --exclude 'cli-integrations.json' \
  --exclude 'optional-explorers.json' \
  --exclude 'upload-staging/' \
  --exclude 'chat-sessions/' \
  --exclude 'tmp/' \
  "$SOURCE_DIR/" "$INSTALL_DIR/"

chmod +x "$INSTALL_DIR/install.sh" "$INSTALL_DIR/build-macos-app.sh" "$INSTALL_DIR/MoA Web UI.command" "$INSTALL_DIR/MoA.command" "$INSTALL_DIR/service-manager.sh" "$INSTALL_DIR/service-process.sh"

cd "$INSTALL_DIR"
npm ci
npm run build
./build-macos-app.sh
if [ "${MOA_SKIP_SERVICE:-0}" = "1" ]; then
  printf 'Skipped LaunchAgent installation (MOA_SKIP_SERVICE=1).\n'
else
  ./service-manager.sh install
fi
add_to_dock

printf 'MoA installed at %s\n' "$INSTALL_DIR"
printf 'Application: %s\n' "$APP_BUNDLE"

if [ "${MOA_SKIP_LAUNCH:-0}" != "1" ]; then
  /usr/bin/open "$APP_BUNDLE"
fi
