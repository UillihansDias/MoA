#!/bin/bash

set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")" && pwd)"
SOURCE="$APP_DIR/macos/MoAApp.swift"
BUNDLE="$APP_DIR/MoA.app"
CONTENTS="$BUNDLE/Contents"
ARCH="$(uname -m)"
MINIMUM_MACOS_VERSION="${MOA_MINIMUM_MACOS_VERSION:-14.0}"

case "$ARCH" in
  arm64|x86_64) ;;
  *) printf 'Unsupported Mac architecture: %s\n' "$ARCH" >&2; exit 1 ;;
esac

for tool in xcrun codesign xattr; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    printf 'Missing required macOS build tool: %s. Install Xcode Command Line Tools with: xcode-select --install\n' "$tool" >&2
    exit 1
  fi
done

mkdir -p "$CONTENTS/MacOS" "$CONTENTS/Resources"
/bin/cp "$APP_DIR/macos/Info.plist" "$CONTENTS/Info.plist"
/bin/cp "$APP_DIR/macos/ApplicationIcon.icns" "$CONTENTS/Resources/ApplicationIcon.icns"

xcrun swiftc \
  -parse-as-library \
  -target "$ARCH-apple-macos$MINIMUM_MACOS_VERSION" \
  -framework SwiftUI \
  -framework WebKit \
  "$SOURCE" \
  -o "$CONTENTS/MacOS/MoA"

xattr -cr "$BUNDLE"
codesign --force --deep --sign - "$BUNDLE" >/dev/null
printf 'Built %s\n' "$BUNDLE"
