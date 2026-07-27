/**
 * x11vnc + websockify — bật khi user mở Live, tắt khi đóng (tiết kiệm CPU).
 * Xvfb vẫn chạy sẵn từ entrypoint (Chrome headed cần DISPLAY).
 * Mở Live → scale CPU lên; đóng → hạ về idle (docker.sock).
 */
import { spawn, spawnSync } from 'child_process';
import net from 'net';
import fs from 'fs';
import { acquireCpuBoost, releaseCpuBoost, resetCpuScaleIdle } from './dockerCpuScale.js';

const VNC_PORT = 5900;
const WS_PORT = 6080;
const DISPLAY = process.env.DISPLAY || ':99';
/** Tắt VNC sau khi không còn acquire (panel đóng). ensure-only (tab) cũng dùng timer này. */
const IDLE_STOP_MS = Number(process.env.CHROME_LIVE_IDLE_MS) || 120_000;

let refCount = 0;
let startPromise = null;
let x11Child = null;
let wsChild = null;
let idleTimer = null;
let liveBoostHeld = false;

async function holdLiveBoost() {
  if (liveBoostHeld) return;
  liveBoostHeld = true;
  await acquireCpuBoost('live').catch((err) => {
    console.warn('[live-vnc] cpu boost:', err?.message || err);
  });
}

async function dropLiveBoost() {
  if (!liveBoostHeld) return;
  liveBoostHeld = false;
  await releaseCpuBoost('live').catch((err) => {
    console.warn('[live-vnc] cpu release:', err?.message || err);
  });
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
  const p = (r.stdout || '').trim();
  return p || null;
}

function killByName(patterns) {
  for (const p of patterns) {
    try {
      spawnSync('pkill', ['-f', p], { stdio: 'ignore' });
    } catch {
      /* ignore */
    }
  }
}

function spawnLogged(cmd, args, logFile) {
  const out = fs.openSync(logFile, 'a');
  const child = spawn(cmd, args, {
    stdio: ['ignore', out, out],
    detached: false,
    env: { ...process.env, DISPLAY },
  });
  child.on('error', (err) => {
    console.warn(`[live-vnc] ${cmd}:`, err?.message || err);
  });
  child.on('exit', (code, signal) => {
    console.log(`[live-vnc] ${cmd} exit code=${code} signal=${signal}`);
  });
  return child;
}

function clearIdleTimer() {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
}

function scheduleIdleStop() {
  clearIdleTimer();
  idleTimer = setTimeout(() => {
    idleTimer = null;
    if (refCount === 0) {
      stopProcesses();
    }
  }, IDLE_STOP_MS);
}

async function startProcesses() {
  const vncUp = await probePort(VNC_PORT);
  const wsUp = await probePort(WS_PORT);
  if (vncUp && wsUp) {
    return { ok: true, already: true };
  }

  if (!which('x11vnc')) {
    throw new Error('x11vnc không có trên server (chỉ VPS/Docker có Live noVNC).');
  }

  // Nới CPU trước khi spawn VNC (Live cần headroom)
  await holdLiveBoost();

  killByName(['x11vnc', 'websockify.*6080']);
  await sleep(300);

  if (!(await probePort(VNC_PORT))) {
    // -nap/-wait/-deferupdate: ít poll hơn khi màn hình ít đổi (bớt CPU)
    x11Child = spawnLogged(
      'x11vnc',
      [
        '-display',
        DISPLAY,
        '-forever',
        '-shared',
        '-rfbport',
        String(VNC_PORT),
        '-nopw',
        '-xkb',
        '-localhost',
        '-nap',
        '-wait',
        '30',
        '-deferupdate',
        '30',
      ],
      '/tmp/x11vnc.log'
    );
  }

  if (!(await waitPort(VNC_PORT))) {
    throw new Error('Không start được x11vnc (port 5900). Xem /tmp/x11vnc.log');
  }

  if (!(await probePort(WS_PORT))) {
    const wsBin = which('websockify');
    if (wsBin) {
      wsChild = spawnLogged(
        wsBin,
        ['--heartbeat=30', `127.0.0.1:${WS_PORT}`, `127.0.0.1:${VNC_PORT}`],
        '/tmp/websockify.log'
      );
    } else if (which('python3')) {
      wsChild = spawnLogged(
        'python3',
        ['-m', 'websockify', '--heartbeat=30', `127.0.0.1:${WS_PORT}`, `127.0.0.1:${VNC_PORT}`],
        '/tmp/websockify.log'
      );
    } else {
      throw new Error('websockify không có trên server.');
    }
  }

  if (!(await waitPort(WS_PORT))) {
    throw new Error('Không start được websockify (port 6080). Xem /tmp/websockify.log');
  }

  console.log('[live-vnc] x11vnc + websockify started (on-demand)');
  return { ok: true, already: false };
}

function stopProcesses() {
  clearIdleTimer();
  try {
    x11Child?.kill('SIGTERM');
  } catch {
    /* ignore */
  }
  try {
    wsChild?.kill('SIGTERM');
  } catch {
    /* ignore */
  }
  x11Child = null;
  wsChild = null;
  killByName(['x11vnc', 'websockify.*6080']);
  console.log('[live-vnc] stopped (no Live viewers)');
  dropLiveBoost();
}

async function runStart() {
  if (!startPromise) {
    startPromise = startProcesses().finally(() => {
      startPromise = null;
    });
  }
  return startPromise;
}

/** Start nếu chưa chạy — không tăng refCount (iframe / tab). */
export async function ensureLiveVnc() {
  const result = await runStart();
  if (refCount === 0) scheduleIdleStop();
  return { ...result, refCount };
}

/** Panel Mở Live — giữ VNC sống đến khi release. */
export async function acquireLiveVnc() {
  clearIdleTimer();
  refCount += 1;
  try {
    if (refCount === 1) {
      await holdLiveBoost();
    }
    const result = await runStart();
    return { ...result, refCount };
  } catch (err) {
    refCount = Math.max(0, refCount - 1);
    if (refCount === 0) stopProcesses();
    throw err;
  }
}

/** Panel Đóng Live / leave page. */
export async function releaseLiveVnc() {
  refCount = Math.max(0, refCount - 1);
  if (refCount > 0) {
    return { ok: true, stopped: false, refCount };
  }
  // Tắt ngay khi không còn ai acquire (user yêu cầu đóng = tắt)
  stopProcesses();
  return { ok: true, stopped: true, refCount: 0 };
}

export async function probeLiveVnc() {
  const websockify = await probePort(WS_PORT);
  const vnc = await probePort(VNC_PORT);
  return { websockify, vnc, running: websockify && vnc, refCount };
}

/** Boot: ép về idle (tránh kẹt 1.5 sau crash). */
export function initLiveVncIdleCpu() {
  resetCpuScaleIdle().catch((err) => {
    console.warn('[live-vnc] boot scale idle:', err?.message || err);
  });
}
