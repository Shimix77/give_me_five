#!/bin/bash

# Vytvorí samostatnú macOS aplikáciu bez Chrome, Terminálu a systémového Node.js.
# Všetky vstupné médiá zostávajú v Application Support a server ich pri štarte
# po páde alebo pri ukončení odstráni. Model je v appke, aby prvé použitie
# prepisu nepotrebovalo internet.

set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
APP_NAME="Give Me Five Editor"
BUILD_DIR="$PROJECT_DIR/dist"
APP_DIR="$BUILD_DIR/$APP_NAME.app"
CONTENTS="$APP_DIR/Contents"
RESOURCES="$CONTENTS/Resources"
ENGINE="$RESOURCES/engine"
NODE_BIN="${GMF_NODE_RUNTIME:-$(command -v node || true)}"
MODEL_SOURCE="${GMF_MODEL_SOURCE:-$PROJECT_DIR/.gmf-work/models}"
MACOS_SDK="${GMF_MACOS_SDK:-/Library/Developer/CommandLineTools/SDKs/MacOSX15.4.sdk}"
MACOS_ARCH="$(uname -m)"
SWIFT_TARGET="${MACOS_ARCH}-apple-macosx13.0"
SWIFT_MODULE_CACHE="${GMF_SWIFT_MODULE_CACHE:-/private/tmp/give-me-five-swift-module-cache}"

if [ -z "$NODE_BIN" ] || [ ! -x "$NODE_BIN" ]; then
  echo "Chýba Node runtime pre zostavenie aplikácie. Nastavte GMF_NODE_RUNTIME na binárku Node.js 24." >&2
  exit 1
fi
if [ ! -d "$PROJECT_DIR/node_modules" ]; then
  echo "Chýbajú lokálne závislosti. Pred balením spustite pnpm install." >&2
  exit 1
fi
if [ ! -d "$MODEL_SOURCE" ]; then
  echo "Chýba lokálny slovenský AI model v $MODEL_SOURCE." >&2
  exit 1
fi
if [ ! -d "$MACOS_SDK" ]; then
  MACOS_SDK="$(/usr/bin/xcrun --show-sdk-path)"
fi

rm -rf "$APP_DIR"
mkdir -p "$CONTENTS/MacOS" "$ENGINE/runtime" "$ENGINE/bin"

mkdir -p "$SWIFT_MODULE_CACHE"
CLANG_MODULE_CACHE_PATH="$SWIFT_MODULE_CACHE" /usr/bin/swiftc \
  -parse-as-library -sdk "$MACOS_SDK" -target "$SWIFT_TARGET" \
  "$PROJECT_DIR/macos-app/GiveMeFiveEditorApp.swift" \
  -framework AppKit -framework WebKit \
  -o "$CONTENTS/MacOS/$APP_NAME"

/usr/bin/ditto "$PROJECT_DIR/macos-app/Info.plist" "$CONTENTS/Info.plist"
/usr/bin/ditto "$NODE_BIN" "$ENGINE/runtime/node"
/bin/chmod +x "$ENGINE/runtime/node"

for source in server.js transcribe-worker.js render-timing.js marker-analysis.js visual-entry.js music-suitability.js package.json give_me_five.html; do
  /usr/bin/ditto "$PROJECT_DIR/$source" "$ENGINE/$source"
done
/usr/bin/ditto "$PROJECT_DIR/assets" "$ENGINE/assets"
/usr/bin/ditto "$PROJECT_DIR/tools" "$ENGINE/tools"
# Finder metadata nie je runtime súčasť aplikácie a pri kopírovaní môže mať
# zamknuté atribúty. Rsync ho preto vynechá, bez zásahu do zdrojového projektu.
/usr/bin/rsync -a --exclude '.DS_Store' "$PROJECT_DIR/node_modules/" "$ENGINE/node_modules/"
/usr/bin/ditto "$MODEL_SOURCE" "$RESOURCES/models"

FFMPEG_BIN="$PROJECT_DIR/node_modules/ffmpeg-static/ffmpeg"
FFPROBE_BIN="$PROJECT_DIR/node_modules/ffprobe-static/bin/darwin/$(uname -m)/ffprobe"
if [ ! -x "$FFMPEG_BIN" ] || [ ! -x "$FFPROBE_BIN" ]; then
  echo "Chýba FFmpeg alebo FFprobe pre architektúru $(uname -m)." >&2
  exit 1
fi
/usr/bin/ditto "$FFMPEG_BIN" "$ENGINE/bin/ffmpeg"
/usr/bin/ditto "$FFPROBE_BIN" "$ENGINE/bin/ffprobe"
/bin/chmod +x "$ENGINE/bin/ffmpeg" "$ENGINE/bin/ffprobe"

/usr/bin/plutil -lint "$CONTENTS/Info.plist" >/dev/null
echo "Hotovo: $APP_DIR"
echo "Prečo je appka väčšia: obsahuje lokálny video engine a slovenský AI model, aby videá neopúšťali Mac."

if [ "${GMF_CREATE_DMG:-0}" = "1" ]; then
  APP_VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$CONTENTS/Info.plist")"
  DMG_PATH="$BUILD_DIR/Give_Me_Five_Editor-${APP_VERSION}-${MACOS_ARCH}.dmg"
  /usr/bin/hdiutil create -volname "$APP_NAME" -srcfolder "$APP_DIR" -format UDZO -ov "$DMG_PATH"
  echo "DMG je pripravené: $DMG_PATH"
fi
