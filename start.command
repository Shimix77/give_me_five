#!/bin/bash

set -u

APP_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$APP_DIR"
APP_URL="http://127.0.0.1:4173"
EXPECTED_VERSION="$(/usr/bin/sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$APP_DIR/package.json")"

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

RUNNING_HEALTH="$(curl -fsS "$APP_URL/api/health" 2>/dev/null || true)"
RUNNING_VERSION="$(/usr/bin/printf '%s' "$RUNNING_HEALTH" | /usr/bin/sed -n 's/.*"version":"\([^"]*\)".*/\1/p')"

if [ -n "$RUNNING_HEALTH" ] && [ "$RUNNING_VERSION" = "$EXPECTED_VERSION" ]; then
  echo "Give Me Five Editor $RUNNING_VERSION už beží. Otváram Google Chrome…"
  open_editor
  exit 0
fi

if [ -n "$RUNNING_HEALTH" ]; then
  echo "Beží starší Give Me Five Editor ${RUNNING_VERSION:-bez verzie}; potrebná je verzia $EXPECTED_VERSION. Reštartujem ho…"
  LISTENER_PIDS="$(/usr/sbin/lsof -tiTCP:4173 -sTCP:LISTEN 2>/dev/null || true)"
  for LISTENER_PID in $LISTENER_PIDS; do
    /bin/kill "$LISTENER_PID" >/dev/null 2>&1 || true
  done
  for _stop_attempt in $(seq 1 40); do
    if ! curl -fsS "$APP_URL/api/health" >/dev/null 2>&1; then
      break
    fi
    sleep 0.25
  done
  if curl -fsS "$APP_URL/api/health" >/dev/null 2>&1; then
    echo "CHYBA: Staršiu verziu editora sa nepodarilo ukončiť. Zatvorte jej okno Terminálu a skúste to znova."
    pause_if_terminal
    exit 1
  fi
fi

NODE_BIN="$(command -v node || true)"
PNPM_BIN="$(command -v pnpm || true)"
DEPENDENCY_VERSION_FILE="$APP_DIR/node_modules/.gmf-app-version"
INSTALLED_DEPENDENCY_VERSION="$(/usr/bin/sed -n '1p' "$DEPENDENCY_VERSION_FILE" 2>/dev/null || true)"

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

if [ ! -d "node_modules" ] || [ "$INSTALLED_DEPENDENCY_VERSION" != "$EXPECTED_VERSION" ] || ! "$NODE_BIN" -e "require('express'); require('ffmpeg-static'); require('ffprobe-static'); require.resolve('@huggingface/transformers')" >/dev/null 2>&1; then
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
  /usr/bin/printf '%s\n' "$EXPECTED_VERSION" > "$DEPENDENCY_VERSION_FILE"
fi

echo "Spúšťam Give Me Five Editor…"
echo "Správna adresa je $APP_URL"
export GMF_OPEN_BROWSER=0
"$NODE_BIN" server.js &
SERVER_PID=$!
SERVER_READY=0

for _attempt in $(seq 1 80); do
  STARTED_HEALTH="$(curl -fsS "$APP_URL/api/health" 2>/dev/null || true)"
  STARTED_VERSION="$(/usr/bin/printf '%s' "$STARTED_HEALTH" | /usr/bin/sed -n 's/.*"version":"\([^"]*\)".*/\1/p')"
  if [ "$STARTED_VERSION" = "$EXPECTED_VERSION" ]; then
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
