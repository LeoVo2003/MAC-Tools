/**
 * Scale CPU container qua Docker API (docker.sock).
 * Idle 0.3 khi không có holder; Fill/Run/Live → DOCKER_CPU_LIVE (1.5).
 */
import fs from 'fs';
import http from 'http';

const SOCKET = process.env.DOCKER_SOCK || '/var/run/docker.sock';
const IDLE = Number(process.env.DOCKER_CPU_IDLE) || 0.3;
/** Boost khi Chrome đang làm việc (Fill/Run) hoặc Live mở */
const BOOST = Number(process.env.DOCKER_CPU_LIVE) || 2.5;

/** @type {Map<string, number>} */
const holders = new Map();
let lastMode = null;
let warnedOff = false;

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

async function applyHolders() {
  const total = holderTotal();
  const want = total > 0 ? 'boost' : 'idle';
  const cpus = total > 0 ? BOOST : IDLE;
  if (lastMode === want) {
    return { ok: true, already: true, mode: want, cpus, holders: total };
  }
  const result = await setNanoCpus(cpus);
  if (result.ok) lastMode = want;
  return { ...result, mode: want, cpus, holders: total };
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

/** @deprecated dùng acquireCpuBoost — giữ alias cho Live */
export async function scaleCpuLive() {
  return acquireCpuBoost('live');
}

/** Chỉ idle nếu không còn holder nào (tránh hạ CPU khi Fill đang chạy). */
export async function scaleCpuIdle() {
  if (holderTotal() > 0) {
    return { ok: true, skipped: true, reason: 'holders-active', holders: holderTotal() };
  }
  return applyHolders();
}

/** Boot: xóa holder + ép idle. */
export async function resetCpuScaleIdle() {
  holders.clear();
  lastMode = null;
  return setNanoCpus(IDLE).then((r) => {
    if (r.ok) lastMode = 'idle';
    return { ...r, mode: 'idle', cpus: IDLE, holders: 0 };
  });
}

export function cpuScaleConfig() {
  return {
    enabled: scaleEnabled(),
    idle: IDLE,
    live: BOOST,
    boost: BOOST,
    socket: SOCKET,
    lastMode,
    holders: Object.fromEntries(holders),
    holderTotal: holderTotal(),
  };
}
