#!/bin/bash
set -euo pipefail

export DISPLAY="${DISPLAY:-:99}"
export CHROME_LIVE="${CHROME_LIVE:-true}"
export HEADLESS="${HEADLESS:-false}"

echo "[entrypoint] DISPLAY=$DISPLAY CHROME_LIVE=$CHROME_LIVE HEADLESS=$HEADLESS"

# Virtual framebuffer for headed Chromium
if ! pgrep -x Xvfb >/dev/null 2>&1; then
  Xvfb "$DISPLAY" -screen 0 1440x900x24 -ac +extension RANDR -nolisten tcp &
  sleep 0.8
fi

# Lightweight WM so Chromium has a desktop
if command -v fluxbox >/dev/null 2>&1; then
  fluxbox >/tmp/fluxbox.log 2>&1 &
fi

# VNC server (localhost only)
if ! pgrep -x x11vnc >/dev/null 2>&1; then
  x11vnc -display "$DISPLAY" -forever -shared -rfbport 5900 -nopw -xkb \
    -listen localhost -localhost -ncache 10 -ncache_cr \
    >/tmp/x11vnc.log 2>&1 &
  sleep 0.5
fi

# WebSocket bridge for noVNC (no public web UI — Express serves /chrome-live)
if ! pgrep -f "websockify.*6080" >/dev/null 2>&1; then
  websockify 6080 localhost:5900 >/tmp/websockify.log 2>&1 &
  sleep 0.3
fi

echo "[entrypoint] Xvfb + x11vnc + websockify ready — starting app"
exec node server.js
