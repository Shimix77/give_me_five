#!/bin/bash

set -u

APP_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$APP_DIR"
APP_URL="http://127.0.0.1:4173"

pause_if_terminal() {
  if [ -t 0 ]; then
    echo
    read -r -p "Stlačte Enter pre zatvorenie."
  fi
}

open_editor() {
  if open -b com.google.Chrome "$APP_URL" >/dev/null 2>&1; then
    return 0
  fi
  open "$APP_URL"
}

if curl -fsS "$APP_URL/api/health" >/dev/null 2>&1; then
  echo "Give Me Five Editor už beží. Otváram Google Chrome…"
  open_editor
  exit 0
fi

NODE_BIN="$(command -v node || true)"
PNPM_BIN="$(command -v pnpm || true)"

if [ -z "$NODE_BIN" ] && [ -x "/Users/jakubsimonak/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node" ]; then
  NODE_BIN="/Users/jakubsimonak/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node"
fi

if [ -z "$PNPM_BIN" ] && [ -x "/Users/jakubsimonak/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/fallback/pnpm" ]; then
  PNPM_BIN="/Users/jakubsimonak/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/fallback/pnpm"
fi

if [ -z "$NODE_BIN" ]; then
  echo "CHYBA: Potrebný je Node.js 24."
  echo "Nainštalujte ho z https://nodejs.org a spustite tento súbor znovu."
  pause_if_terminal
  exit 1
fi

NODE_DIR="$(dirname "$NODE_BIN")"
export PATH="$NODE_DIR:$PATH"

if [ ! -d "node_modules" ] || ! "$NODE_BIN" -e "require('express'); require('ffmpeg-static'); require('ffprobe-static'); require.resolve('@huggingface/transformers')" >/dev/null 2>&1; then
  echo "Pripravujem lokálny video engine. Pri prvom spustení to môže chvíľu trvať…"
  if [ -n "$PNPM_BIN" ]; then
    if ! "$PNPM_BIN" install; then
      echo "CHYBA: Nepodarilo sa nainštalovať lokálny video engine."
      pause_if_terminal
      exit 1
    fi
  elif command -v npm >/dev/null 2>&1; then
    if ! npm install; then
      echo "CHYBA: Nepodarilo sa nainštalovať lokálny video engine."
      pause_if_terminal
      exit 1
    fi
  else
    echo "CHYBA: Chýba npm alebo pnpm pre inštaláciu závislostí."
    pause_if_terminal
    exit 1
  fi
fi

echo "Spúšťam Give Me Five Editor…"
echo "Správna adresa je $APP_URL"
export GMF_OPEN_BROWSER=0
"$NODE_BIN" server.js &
SERVER_PID=$!
SERVER_READY=0

for _attempt in $(seq 1 80); do
  if curl -fsS "$APP_URL/api/health" >/dev/null 2>&1; then
    SERVER_READY=1
    break
  fi
  if ! kill -0 "$SERVER_PID" >/dev/null 2>&1; then
    break
  fi
  sleep 0.25
done

if [ "$SERVER_READY" -eq 1 ]; then
  echo "Editor je pripravený. Otváram Google Chrome…"
  open_editor
else
  echo "CHYBA: Lokálny server sa nepodarilo pripraviť."
fi

if ! wait "$SERVER_PID"; then
  echo "CHYBA: Lokálny server sa nepodarilo spustiť."
  echo "Ak je port 4173 obsadený, zatvorte staré okno Terminálu a skúste to znovu."
  pause_if_terminal
  exit 1
fi
