#!/bin/bash

set -e

APP_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$APP_DIR"

NODE_BIN="$(command -v node || true)"
PNPM_BIN="$(command -v pnpm || true)"

if [ -z "$NODE_BIN" ] && [ -x "/Users/jakubsimonak/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node" ]; then
  NODE_BIN="/Users/jakubsimonak/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node"
fi

if [ -z "$PNPM_BIN" ] && [ -x "/Users/jakubsimonak/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/fallback/pnpm" ]; then
  PNPM_BIN="/Users/jakubsimonak/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/fallback/pnpm"
fi

if [ -z "$NODE_BIN" ]; then
  echo "Node.js 20 or newer is required."
  echo "Install it from https://nodejs.org and run this file again."
  read -r -p "Press Enter to close."
  exit 1
fi

NODE_DIR="$(dirname "$NODE_BIN")"
export PATH="$NODE_DIR:$PATH"

if [ ! -d "node_modules" ]; then
  if [ -n "$PNPM_BIN" ]; then
    "$PNPM_BIN" install
  elif command -v npm >/dev/null 2>&1; then
    npm install
  else
    echo "The application dependencies are missing."
    echo "Install npm or pnpm and run this file again."
    read -r -p "Press Enter to close."
    exit 1
  fi
fi

export GMF_OPEN_BROWSER=1
"$NODE_BIN" server.js
