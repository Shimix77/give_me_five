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
SWIFT_TARGET="arm64-apple-macosx13.0"
SWIFT_MODULE_CACHE="${GMF_SWIFT_MODULE_CACHE:-/private/tmp/give-me-five-swift-module-cache}"

if [ "$MACOS_ARCH" != "arm64" ]; then
  echo "Give Me Five Editor podporuje iba Apple Silicon (M1/M2/M3/M4). Tento Mac má architektúru $MACOS_ARCH." >&2
  exit 1
fi
if [ -z "$NODE_BIN" ] || [ ! -x "$NODE_BIN" ]; then
  echo "Chýba Node runtime pre zostavenie aplikácie. Nastavte GMF_NODE_RUNTIME na binárku Node.js 24." >&2
  exit 1
fi
if ! /usr/bin/file "$NODE_BIN" | /usr/bin/grep -q "arm64"; then
  echo "Zvolený Node runtime nie je Apple-Silicon (arm64), preto by výsledná aplikácia nebola natívna." >&2
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
# Finder metadata ani binárky pre Linux, Windows a Intel Mac nie sú runtime
# súčasťou Apple-Silicon aplikácie. Ich vynechanie šetrí miesto a zaručí, že
# výsledný balík neobsahuje nepoužiteľné cudzie architektúry.
/usr/bin/rsync -a \
  --exclude '.DS_Store' \
  --exclude '@img+sharp-linux-*' \
  --exclude '@img+sharp-linuxmusl-*' \
  --exclude '@img+sharp-win32-*' \
  --exclude '@img+sharp-darwin-x64*' \
  --exclude '@img+sharp-libvips-darwin-x64*' \
  --exclude '@img+sharp-libvips-linux*' \
  --exclude '*/onnxruntime-node/bin/napi-v6/linux/***' \
  --exclude '*/onnxruntime-node/bin/napi-v6/win32/***' \
  "$PROJECT_DIR/node_modules/" "$ENGINE/node_modules/"
/usr/bin/ditto "$MODEL_SOURCE" "$RESOURCES/models"

FFMPEG_BIN="$PROJECT_DIR/node_modules/ffmpeg-static/ffmpeg"
if [ ! -x "$FFMPEG_BIN" ] || ! /usr/bin/file "$FFMPEG_BIN" | /usr/bin/grep -q "arm64"; then
  echo "Chýba natívny Apple-Silicon FFmpeg." >&2
  exit 1
fi
/usr/bin/ditto "$FFMPEG_BIN" "$ENGINE/bin/ffmpeg"
/bin/chmod +x "$ENGINE/bin/ffmpeg"

/usr/bin/plutil -lint "$CONTENTS/Info.plist" >/dev/null
echo "Hotovo: $APP_DIR"
echo "Prečo je appka väčšia: obsahuje lokálny video engine a slovenský AI model, aby videá neopúšťali Mac."

if [ "${GMF_CREATE_DMG:-0}" = "1" ]; then
  APP_VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$CONTENTS/Info.plist")"
  DMG_PATH="$BUILD_DIR/Give_Me_Five_Editor-${APP_VERSION}-${MACOS_ARCH}.dmg"
  if /usr/bin/hdiutil create -volname "$APP_NAME" -srcfolder "$APP_DIR" -format UDZO -ov "$DMG_PATH"; then
    echo "DMG je pripravené: $DMG_PATH"
  else
    ZIP_PATH="$BUILD_DIR/Give_Me_Five_Editor-${APP_VERSION}-${MACOS_ARCH}.zip"
    /bin/rm -f "$DMG_PATH" "$ZIP_PATH"
    /usr/bin/ditto -c -k --sequesterRsrc --keepParent "$APP_DIR" "$ZIP_PATH"
    echo "DMG sa na tomto macOS prostredí nepodarilo vytvoriť; pripravil som Finder-kompatibilný ZIP: $ZIP_PATH"
  fi
fi
