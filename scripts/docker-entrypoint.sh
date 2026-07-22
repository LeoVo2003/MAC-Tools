#!/bin/bash
set -euo pipefail

export DISPLAY="${DISPLAY:-:99}"
export CHROME_LIVE="${CHROME_LIVE:-true}"
export HEADLESS="${HEADLESS:-false}"

echo "[entrypoint] DISPLAY=$DISPLAY CHROME_LIVE=$CHROME_LIVE HEADLESS=$HEADLESS"

wait_port() {
  local port="$1"
  local name="$2"
  local i=0
  while [ "$i" -lt 30 ]; do
    if (echo >/dev/tcp/127.0.0.1/"$port") >/dev/null 2>&1; then
      echo "[entrypoint] $name :$port OK"
      return 0
    fi
    i=$((i + 1))
    sleep 0.2
  done
  echo "[entrypoint] WARN: $name :$port chưa listen"
  return 1
}

# Virtual framebuffer
pkill -x Xvfb >/dev/null 2>&1 || true
Xvfb "$DISPLAY" -screen 0 1440x900x24 -ac +extension RANDR -nolisten tcp >/tmp/xvfb.log 2>&1 &
sleep 0.8
if ! pgrep -x Xvfb >/dev/null 2>&1; then
  echo "[entrypoint] ERROR: Xvfb failed"
  cat /tmp/xvfb.log || true
  exit 1
fi
echo "[entrypoint] Xvfb OK ($DISPLAY)"

if command -v fluxbox >/dev/null 2>&1; then
  fluxbox >/tmp/fluxbox.log 2>&1 &
fi

# VNC
pkill -x x11vnc >/dev/null 2>&1 || true
x11vnc -display "$DISPLAY" -forever -shared -rfbport 5900 -nopw -xkb \
  -localhost -ncache 10 -ncache_cr \
  >/tmp/x11vnc.log 2>&1 &
sleep 0.6
if ! wait_port 5900 "x11vnc"; then
  echo "[entrypoint] x11vnc log:"; cat /tmp/x11vnc.log || true
  exit 1
fi

# Websockify → VNC
pkill -f "websockify.*6080" >/dev/null 2>&1 || true
if command -v websockify >/dev/null 2>&1; then
  websockify --heartbeat=30 127.0.0.1:6080 127.0.0.1:5900 >/tmp/websockify.log 2>&1 &
elif python3 -c "import websockify" >/dev/null 2>&1; then
  python3 -m websockify --heartbeat=30 127.0.0.1:6080 127.0.0.1:5900 >/tmp/websockify.log 2>&1 &
else
  echo "[entrypoint] ERROR: websockify not found"
  exit 1
fi
sleep 0.5
if ! wait_port 6080 "websockify"; then
  echo "[entrypoint] websockify log:"; cat /tmp/websockify.log || true
  exit 1
fi

echo "[entrypoint] Xvfb + x11vnc + websockify ready — starting app"
exec node server.js
