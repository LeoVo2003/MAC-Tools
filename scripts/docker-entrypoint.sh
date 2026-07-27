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

# Virtual framebuffer (Chrome headed cần DISPLAY) — giữ 1440x900
pkill -x Xvfb >/dev/null 2>&1 || true
Xvfb "$DISPLAY" -screen 0 1440x900x24 -ac +extension RANDR -nolisten tcp >/tmp/xvfb.log 2>&1 &
sleep 0.8
if ! pgrep -x Xvfb >/dev/null 2>&1; then
  echo "[entrypoint] ERROR: Xvfb failed"
  cat /tmp/xvfb.log || true
  exit 1
fi
echo "[entrypoint] Xvfb OK ($DISPLAY)"

# Không chạy fluxbox — taskbar làm Chrome nhỏ / bị cắt trong Live

# x11vnc + websockify: KHÔNG start sẵn (CPU nặng). App bật on-demand khi user Mở Live.
pkill -x x11vnc >/dev/null 2>&1 || true
pkill -f "websockify.*6080" >/dev/null 2>&1 || true
echo "[entrypoint] x11vnc/websockify deferred (on-demand via /api/chrome-live/start)"

echo "[entrypoint] Xvfb ready — starting app"
exec node server.js
