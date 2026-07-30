/**
 * Scale CPU container qua Docker API (docker.sock).
 * - Adaptive off: idle ↔ DOCKER_CPU_LIVE (như cũ).
 * - Adaptive on (1 vCPU host): idle / safe(LIVE) / max(DOCKER_CPU_MAX) theo host pressure.
 */
import fs from 'fs';
import http from 'http';
import {
  adaptiveEnabled,
  sampleHostPressure,
} from './hostPressure.js';

const SOCKET = process.env.DOCKER_SOCK || '/var/run/docker.sock';
const IDLE = Number(process.env.DOCKER_CPU_IDLE) || 0.3;
/** Safe boost (adaptive on + busy) hoặc boost duy nhất khi adaptive off */
const LIVE = Number(process.env.DOCKER_CPU_LIVE) || 2.5;
/** Max khi adaptive on + host rảnh — mặc định 1.0 (host 1 vCPU) */
const MAX = Number(process.env.DOCKER_CPU_MAX) || 1.0;
const POLL_MS = Math.max(5000, Number(process.env.ADAPTIVE_POLL_MS) || 15000);

/** @type {Map<string, number>} */
const holders = new Map();
/** @type {'idle'|'safe'|'max'|null} */
let lastMode = null;
let warnedOff = false;
/** @type {'idle'|'busy'|'unknown'} */
let lastPressure = 'unknown';
/** @type {ReturnType<typeof setInterval>|null} */
let pollTimer = null;
/** @type {object|null} */
let lastSample = null;

function scaleEnabled() {
  const v = (process.env.DOCKER_CPU_SCALE || 'true').toLowerCase();
  return v !== '0' && v !== 'false' && v !== 'off';
}

function holderTotal() {
  let n = 0;
  for (const c of holders.values()) n += c;
  return n;
}

function resolveContainerId() {
  const fromEnv = (process.env.DOCKER_CONTAINER_ID || '').trim();
  if (fromEnv) return fromEnv;

  try {
    const cgroup = fs.readFileSync('/proc/self/cgroup', 'utf8');
    let m = cgroup.match(/\/docker\/([a-f0-9]{64})\b/);
    if (m) return m[1];
    m = cgroup.match(/docker-([a-f0-9]{64})\.scope/);
    if (m) return m[1];
    m = cgroup.match(/\/([a-f0-9]{64})\b/);
    if (m && /docker|containerd|libpod/i.test(cgroup)) return m[1];
  } catch {
    /* ignore */
  }

  const host = (process.env.HOSTNAME || '').trim();
  if (/^[a-f0-9]{12,64}$/i.test(host)) return host;
  return host || null;
}

function dockerRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : JSON.stringify(body);
    const req = http.request(
      {
        socketPath: SOCKET,
        path,
        method,
        headers: payload
          ? {
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(payload),
            }
          : { 'Content-Length': 0 },
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
    req.setTimeout(8000, () => {
      req.destroy(new Error('Docker API timeout'));
    });
    if (payload) req.write(payload);
    req.end();
  });
}

async function setNanoCpus(cpus) {
  if (!scaleEnabled()) {
    if (!warnedOff) {
      console.log('[cpu-scale] disabled (DOCKER_CPU_SCALE=false)');
      warnedOff = true;
    }
    return { ok: false, skipped: true, reason: 'disabled' };
  }

  if (!fs.existsSync(SOCKET)) {
    if (!warnedOff) {
      console.warn(
        '[cpu-scale] không có docker.sock — giữ cpus compose. Mount /var/run/docker.sock để scale.'
      );
      warnedOff = true;
    }
    return { ok: false, skipped: true, reason: 'no-socket' };
  }

  const id = resolveContainerId();
  if (!id) {
    console.warn('[cpu-scale] không resolve được container id');
    return { ok: false, skipped: true, reason: 'no-id' };
  }

  const nano = Math.max(1, Math.round(Number(cpus) * 1e9));
  const res = await dockerRequest('POST', `/containers/${encodeURIComponent(id)}/update`, {
    NanoCpus: nano,
  });

  if (res.status >= 200 && res.status < 300) {
    console.log(`[cpu-scale] NanoCpus → ${cpus} (${nano}) id=${id.slice(0, 12)}`);
    return { ok: true, cpus, nano, id };
  }

  let detail = res.body;
  try {
    detail = JSON.parse(res.body)?.message || res.body;
  } catch {
    /* keep */
  }
  console.warn(`[cpu-scale] update failed HTTP ${res.status}: ${detail}`);
  return { ok: false, status: res.status, detail };
}

/**
 * @returns {Promise<{ mode: 'idle'|'safe'|'max', cpus: number, pressure: string, sample: object|null }>}
 */
async function resolveTarget() {
  const total = holderTotal();
  if (total <= 0) {
    return { mode: 'idle', cpus: IDLE, pressure: lastPressure, sample: lastSample };
  }

  if (!adaptiveEnabled()) {
    return { mode: 'safe', cpus: LIVE, pressure: 'n/a', sample: null };
  }

  const sample = await sampleHostPressure(lastPressure);
  lastSample = sample;
  lastPressure = sample.pressure;

  if (sample.treatAsBusy) {
    return { mode: 'safe', cpus: LIVE, pressure: sample.pressure, sample };
  }
  return { mode: 'max', cpus: MAX, pressure: sample.pressure, sample };
}

async function applyHolders() {
  const target = await resolveTarget();
  const { mode, cpus, pressure, sample } = target;
  const total = holderTotal();

  if (lastMode === mode) {
    ensurePoll();
    return {
      ok: true,
      already: true,
      mode,
      cpus,
      holders: total,
      pressure,
      load1: sample?.load1 ?? null,
    };
  }

  const result = await setNanoCpus(cpus);
  if (result.ok) {
    lastMode = mode;
    const load1 = sample?.load1;
    console.log(
      `[cpu-scale] mode=${mode} cpus=${cpus} pressure=${pressure}` +
        (load1 != null ? ` load1=${load1}` : '') +
        (sample?.peerCpu != null ? ` peerCpu=${sample.peerCpu}%` : '')
    );
  }
  ensurePoll();
  return {
    ...result,
    mode,
    cpus,
    holders: total,
    pressure,
    load1: sample?.load1 ?? null,
  };
}

function ensurePoll() {
  const need = adaptiveEnabled() && holderTotal() > 0;
  if (need && !pollTimer) {
    pollTimer = setInterval(() => {
      applyHolders().catch((err) => {
        console.warn('[cpu-scale] adaptive poll:', err?.message || err);
      });
    }, POLL_MS);
    if (typeof pollTimer.unref === 'function') pollTimer.unref();
  }
  if (!need && pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

/** Giữ boost (Fill / Run / Live). Nhiều holder → chỉ hạ idle khi hết tất cả. */
export async function acquireCpuBoost(reason = 'work') {
  const key = String(reason || 'work');
  holders.set(key, (holders.get(key) || 0) + 1);
  return applyHolders();
}

export async function releaseCpuBoost(reason = 'work') {
  const key = String(reason || 'work');
  const next = (holders.get(key) || 0) - 1;
  if (next <= 0) holders.delete(key);
  else holders.set(key, next);
  return applyHolders();
}

/** Boot: xóa holder + ép idle. */
export async function resetCpuScaleIdle() {
  holders.clear();
  lastMode = null;
  lastPressure = 'unknown';
  lastSample = null;
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  return setNanoCpus(IDLE).then((r) => {
    if (r.ok) lastMode = 'idle';
    return { ...r, mode: 'idle', cpus: IDLE, holders: 0 };
  });
}

export function cpuScaleConfig() {
  return {
    enabled: scaleEnabled(),
    adaptiveEnabled: adaptiveEnabled(),
    idle: IDLE,
    live: LIVE,
    boost: LIVE,
    max: MAX,
    socket: SOCKET,
    lastMode,
    pressure: lastPressure,
    load1: lastSample?.load1 ?? null,
    peerCpu: lastSample?.peerCpu ?? null,
    peerName: lastSample?.peerName ?? null,
    cpuTarget: lastMode === 'max' ? MAX : lastMode === 'safe' ? LIVE : IDLE,
    holders: Object.fromEntries(holders),
    holderTotal: holderTotal(),
    pollMs: POLL_MS,
  };
}
