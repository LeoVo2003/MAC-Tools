/**
 * (S6) Quản lý display + VNC riêng cho từng user.
 * Mỗi user có: Xvfb display riêng (:100+), x11vnc riêng, websockify riêng.
 * User A mở Live không thấy Chrome của user B.
 */
import { spawn, spawnSync } from 'child_process';
import net from 'net';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const BASE_DISPLAY = 100; // :100 - :199
const BASE_VNC_PORT = 5900; // 5900 - 5999 (VNC)
const BASE_WS_PORT = 6080; // 6080 - 6179 (websockify)
const MAX_USERS = 50;
const IDLE_STOP_MS = Number(process.env.CHROME_LIVE_IDLE_MS) || 120_000;

// userId -> { display, vncPort, wsPort, xvfb, x11vnc, websockify, idleTimer, refCount }
const userStacks = new Map();

function hashUserId(userId) {
  const h = crypto.createHash('md5').update(String(userId)).digest();
  return h.readUInt16BE(0) % MAX_USERS;
}

function getUserPorts(userId) {
  const idx = hashUserId(userId);
  return {
    display: `:${BASE_DISPLAY + idx}`,
    vncPort: BASE_VNC_PORT + idx,
    wsPort: BASE_WS_PORT + idx,
  };
}

function probePort(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host }, () => {
      sock.end();
      resolve(true);
    });
    sock.on('error', () => resolve(false));
    sock.setTimeout(600, () => {
      sock.destroy();
      resolve(false);
    });
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitPort(port, tries = 40) {
  for (let i = 0; i < tries; i += 1) {
    if (await probePort(port)) return true;
    await sleep(150);
  }
  return false;
}

function which(bin) {
  const r = spawnSync('sh', ['-c', `command -v ${bin}`], { encoding: 'utf8' });
  return (r.stdout || '').trim() || null;
}

/** Display Xvfb cho user — dùng cho Chrome của job */
export function getUserDisplay(userId) {
  const { display } = getUserPorts(userId);
  return display;
}

/** Đảm bảo Xvfb chạy cho display của user */
async function ensureXvfb(display) {
  // Kiểm tra Xvfb đã chạy chưa bằng cách thử kết nối
  const displayNum = display.replace(':', '');
  const sockPath = `/tmp/.X11-unix/X${displayNum}`;
  try {
    if (fs.existsSync(sockPath)) return true;
  } catch {}
  
  const xvfbBin = which('Xvfb');
  if (!xvfbBin) {
    console.warn('[live-display] Xvfb không tìm thấy, dùng DISPLAY chung');
    return false;
  }
  
  const child = spawn(xvfbBin, [display, '-screen', '0', '1440x900x24'], {
    stdio: 'ignore',
    detached: false,
  });
  child.on('error', (err) => {
    console.warn('[live-display] Xvfb error:', err?.message);
  });
  
  // Đợi socket xuất hiện
  for (let i = 0; i < 30; i++) {
    try {
      if (fs.existsSync(sockPath)) return true;
    } catch {}
    await sleep(200);
  }
  return false;
}

/** Đảm bảo VNC stack chạy cho user — gọi khi user mở Live */
export async function ensureUserVnc(userId) {
  let stack = userStacks.get(userId);
  if (stack?.ready) {
    stack.refCount++;
    clearIdleTimer(userId);
    return stack;
  }

  const { display, vncPort, wsPort } = getUserPorts(userId);
  
  // Đảm bảo Xvfb chạy
  const xvfbOk = await ensureXvfb(display);
  if (!xvfbOk) {
    throw new Error('Không khởi động được Xvfb cho Live');
  }

  const x11vncBin = which('x11vnc');
  const wsBin = which('websockify');
  if (!x11vncBin || !wsBin) {
    throw new Error('Thiếu x11vnc hoặc websockify');
  }

  // x11vnc cho display của user
  const x11vnc = spawn(x11vncBin, [
    '-display', display,
    '-rfbport', String(vncPort),
    '-localhost',
    '-nopw',
    '-shared',
    '-forever',
    '-ncache', '10',
  ], {
    stdio: 'ignore',
    detached: false,
    env: { ...process.env, DISPLAY: display },
  });

  const vncOk = await waitPort(vncPort);
  if (!vncOk) {
    x11vnc.kill();
    throw new Error('x11vnc không khởi động được');
  }

  // websockify cho VNC của user
  const websockify = spawn(wsBin, [
    '127.0.0.1:' + wsPort,
    '127.0.0.1:' + vncPort,
  ], {
    stdio: 'ignore',
    detached: false,
  });

  const wsOk = await waitPort(wsPort);
  if (!wsOk) {
    x11vnc.kill();
    websockify.kill();
    throw new Error('websockify không khởi động được');
  }

  stack = {
    display, vncPort, wsPort,
    x11vnc, websockify,
    refCount: 1,
    ready: true,
    idleTimer: null,
  };
  userStacks.set(userId, stack);
  console.log(`[live-display] VNC stack sẵn sàng cho user ${userId}: ${display} → :${vncPort} → :${wsPort}`);
  return stack;
}

function clearIdleTimer(userId) {
  const stack = userStacks.get(userId);
  if (stack?.idleTimer) {
    clearTimeout(stack.idleTimer);
    stack.idleTimer = null;
  }
}

/** Giảm refCount, tự tắt sau idle timeout */
export function releaseUserVnc(userId) {
  const stack = userStacks.get(userId);
  if (!stack) return;
  
  stack.refCount = Math.max(0, stack.refCount - 1);
  if (stack.refCount > 0) return;
  
  clearIdleTimer(userId);
  stack.idleTimer = setTimeout(() => {
    stopUserVnc(userId);
  }, IDLE_STOP_MS);
  // Không giữ process
  if (stack.idleTimer.unref) stack.idleTimer.unref();
}

function stopUserVnc(userId) {
  const stack = userStacks.get(userId);
  if (!stack) return;
  
  try { stack.x11vnc?.kill('SIGTERM'); } catch {}
  try { stack.websockify?.kill('SIGTERM'); } catch {}
  userStacks.delete(userId);
  console.log(`[live-display] Đã dừng VNC stack của user ${userId}`);
}

/** Lấy wsPort của user để proxy WebSocket tới đúng VNC */
export function getUserWsPort(userId) {
  const stack = userStacks.get(userId);
  return stack?.ready ? stack.wsPort : null;
}

/** Dọn dẹp khi server shutdown */
export function stopAllUserVnc() {
  for (const userId of userStacks.keys()) {
    stopUserVnc(userId);
  }
}
