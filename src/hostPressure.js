/**
 * Host pressure cho Adaptive Capacity (Phase 1).
 * Không có /proc (Windows) → unknown → caller coi như busy (an toàn).
 */
import fs from 'fs';
import os from 'os';
import http from 'http';

const SOCKET = process.env.DOCKER_SOCK || '/var/run/docker.sock';

function envNum(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) ? n : fallback;
}

function envFlag(name, defaultTrue = true) {
  const v = String(process.env[name] ?? (defaultTrue ? 'true' : 'false')).toLowerCase();
  return v !== '0' && v !== 'false' && v !== 'off';
}

export function adaptiveEnabled() {
  return envFlag('ADAPTIVE_CAPACITY', true);
}

export function pressureThresholds() {
  return {
    loadBusy: envNum('ADAPTIVE_LOAD_BUSY', 0.7),
    loadIdle: envNum('ADAPTIVE_LOAD_IDLE', 0.35),
    peerCpuBusy: envNum('ADAPTIVE_PEER_CPU_BUSY', 50),
    peerName: String(process.env.ADAPTIVE_PEER_CONTAINER || '').trim(),
  };
}

/** @returns {{ load1: number|null, load5: number|null, load15: number|null, cpus: number, source: 'proc'|'os'|'none' }} */
export function readLoadavg() {
  const cpus = Math.max(1, os.cpus()?.length || 1);
  try {
    if (fs.existsSync('/proc/loadavg')) {
      const raw = fs.readFileSync('/proc/loadavg', 'utf8').trim().split(/\s+/);
      const load1 = Number(raw[0]);
      const load5 = Number(raw[1]);
      const load15 = Number(raw[2]);
      if (Number.isFinite(load1)) {
        return {
          load1,
          load5: Number.isFinite(load5) ? load5 : null,
          load15: Number.isFinite(load15) ? load15 : null,
          cpus,
          source: 'proc',
        };
      }
    }
  } catch {
    /* fall through */
  }

  try {
    const loads = os.loadavg?.() || [];
    if (loads.length && Number.isFinite(loads[0]) && loads[0] > 0) {
      // Windows thường trả [0,0,0] — coi như không đo được
      const allZero = loads.every((x) => !x);
      if (!allZero) {
        return {
          load1: loads[0],
          load5: loads[1] ?? null,
          load15: loads[2] ?? null,
          cpus,
          source: 'os',
        };
      }
    }
  } catch {
    /* ignore */
  }

  return { load1: null, load5: null, load15: null, cpus, source: 'none' };
}

function dockerRequest(method, reqPath) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        socketPath: SOCKET,
        path: reqPath,
        method,
        headers: { 'Content-Length': 0 },
      },
      (res) => {
        let buf = '';
        res.on('data', (c) => {
          buf += c;
        });
        res.on('end', () => {
          resolve({ status: res.statusCode || 0, body: buf });
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(5000, () => {
      req.destroy(new Error('Docker API timeout'));
    });
    req.end();
  });
}

/**
 * % CPU của peer container (0–100+). Lỗi / không cấu hình → null.
 * @returns {Promise<number|null>}
 */
export async function readPeerCpuOptional() {
  const { peerName } = pressureThresholds();
  if (!peerName) return null;
  if (!fs.existsSync(SOCKET)) return null;

  try {
    const res = await dockerRequest(
      'GET',
      `/containers/${encodeURIComponent(peerName)}/stats?stream=false`
    );
    if (res.status < 200 || res.status >= 300) return null;
    const stats = JSON.parse(res.body);
    const cpuDelta =
      (stats.cpu_stats?.cpu_usage?.total_usage || 0) -
      (stats.precpu_stats?.cpu_usage?.total_usage || 0);
    const systemDelta =
      (stats.cpu_stats?.system_cpu_usage || 0) - (stats.precpu_stats?.system_cpu_usage || 0);
    const online =
      stats.cpu_stats?.online_cpus ||
      stats.cpu_stats?.cpu_usage?.percpu_usage?.length ||
      1;
    if (systemDelta <= 0 || cpuDelta < 0) return null;
    const pct = (cpuDelta / systemDelta) * online * 100;
    return Number.isFinite(pct) ? Math.round(pct * 10) / 10 : null;
  } catch {
    return null;
  }
}

/**
 * Pure classify với hysteresis.
 * @param {{ load1: number|null, peerCpu: number|null, previous?: 'idle'|'busy'|'unknown' }} input
 * @returns {'idle'|'busy'|'unknown'}
 */
export function classifyPressure({ load1, peerCpu, previous = 'unknown' } = {}) {
  const { loadBusy, loadIdle, peerCpuBusy } = pressureThresholds();

  if (peerCpu != null && peerCpu >= peerCpuBusy) return 'busy';

  if (load1 == null || !Number.isFinite(load1)) return 'unknown';

  if (load1 >= loadBusy) return 'busy';
  if (load1 <= loadIdle) return 'idle';

  // Vùng giữa: giữ previous nếu đã biết; mặc định busy (an toàn)
  if (previous === 'idle' || previous === 'busy') return previous;
  return 'busy';
}

/**
 * Đọc load + peer, classify.
 * unknown → treatAsBusy cho quyết định CPU (không lên max).
 */
export async function sampleHostPressure(previous = 'unknown') {
  const load = readLoadavg();
  const peerCpu = await readPeerCpuOptional();
  const pressure = classifyPressure({
    load1: load.load1,
    peerCpu,
    previous,
  });
  return {
    pressure,
    treatAsBusy: pressure !== 'idle',
    load1: load.load1,
    load5: load.load5,
    load15: load.load15,
    cpus: load.cpus,
    loadSource: load.source,
    peerCpu,
    peerName: pressureThresholds().peerName || null,
    thresholds: pressureThresholds(),
  };
}
