#!/bin/bash

set -euo pipefail

HOME_DIR="${HOME:?HOME must be set}"
APP_DIR="$HOME_DIR/.MoA"

cd "$APP_DIR"

if [ ! -d node_modules ]; then
  npm install
fi

if [ ! -f dist/index.html ]; then
  npm run build
fi

if [ ! -x "$APP_DIR/MoA.app/Contents/MacOS/MoA" ] || \
   [ "$APP_DIR/macos/MoAApp.swift" -nt "$APP_DIR/MoA.app/Contents/MacOS/MoA" ] || \
   [ "$APP_DIR/macos/Info.plist" -nt "$APP_DIR/MoA.app/Contents/MacOS/MoA" ] || \
   [ "$APP_DIR/macos/ApplicationIcon.icns" -nt "$APP_DIR/MoA.app/Contents/MacOS/MoA" ]; then
  "$APP_DIR/build-macos-app.sh"
fi

"$APP_DIR/service-manager.sh" start

open "$APP_DIR/MoA.app"
