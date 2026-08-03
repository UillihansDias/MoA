#!/bin/bash

set -euo pipefail

HOME_DIR="${HOME:?HOME must be set}"
APP_DIR="$HOME_DIR/.MoA"
LOG_FILE="$APP_DIR/moa-webui.log"
APP_PATH="$HOME_DIR/.local/bin:$HOME_DIR/.antigravity-ide/antigravity-ide/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

export HOME="$HOME_DIR"
export PATH="$APP_PATH"
cd "$APP_DIR"

exec >> "$LOG_FILE" 2>&1
exec node "$APP_DIR/server.mjs"
