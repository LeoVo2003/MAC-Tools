import crypto from 'crypto';
import { acquireCpuBoost, releaseCpuBoost } from './dockerCpuScale.js';

/**
 * Queue chạy song song có giới hạn (mặc định 4 Chrome cùng lúc).
 * @param {{ onLog?: Function, maxConcurrent?: number }} opts
 */
export function createJobQueue({ onLog, onChange, maxConcurrent = 4 } = {}) {
  const limit = Math.max(1, Number(maxConcurrent) || 4);
  /** @type {Array<object>} */
  const pending = [];
  /** @type {Map<string, object>} */
  const active = new Map();
  /** @type {Map<string, object>} */
  const recent = new Map();
  let pumping = false;

  function snapshot() {
    const running = [...active.values()].map((j) => ({
      id: j.id,
      status: 'running',
      user: j.meta?.username,
      userId: j.meta?.userId || null,
      startedAt: j.startedAt || null,
    }));
    return {
      maxConcurrent: limit,
      runningCount: active.size,
      activeJobId: running[0]?.id || null,
      pendingCount: pending.length,
      queue: [
        ...running,
        ...pending.map((j, i) => ({
          id: j.id,
          status: 'pending',
          position: i + 1,
          user: j.meta?.username,
          userId: j.meta?.userId || null,
          createdAt: j.createdAt || null,
        })),
      ],
    };
  }

  /** Mỗi user chỉ thấy job của mình (admin thấy hết). */
  function snapshotForUser(userId, { admin = false } = {}) {
    const full = snapshot();
    if (admin) return full;
    const uid = String(userId || '');
    const mine = full.queue.filter((j) => String(j.userId || '') === uid);
    const runningMine = mine.filter((j) => j.status === 'running');
    const pendingMine = mine
      .filter((j) => j.status === 'pending')
      .map((j, i) => ({ ...j, position: i + 1 }));
    return {
      ...full,
      runningCount: runningMine.length,
      pendingCount: pendingMine.length,
      activeJobId: runningMine[0]?.id || null,
      queue: [...runningMine, ...pendingMine],
      scoped: true,
    };
  }

  function remember(job) {
    recent.set(job.id, job);
    // giữ tối đa 50 job xong gần đây (SSE / status)
    if (recent.size > 50) {
      const first = recent.keys().next().value;
      recent.delete(first);
    }
  }

  function enqueue(item) {
    const id = crypto.randomUUID?.() || `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const job = {
      id,
      ...item,
      logs: [],
      result: null,
      error: null,
      status: 'pending',
      createdAt: new Date().toISOString(),
    };
    pending.push(job);
    const position = pending.length + active.size;
    onChange?.(snapshot());
    setImmediate(() => pump());
    return { jobId: id, position, queue: snapshot() };
  }

  function getJob(jobId) {
    return active.get(jobId) || pending.find((j) => j.id === jobId) || recent.get(jobId) || null;
  }

  async function startOne(job) {
    active.set(job.id, job);
    job.status = 'running';
    job.startedAt = new Date().toISOString();
    onChange?.(snapshot());

    const push = (line) => {
      job.logs.push(line);
      if (job.logs.length > 500) job.logs.shift();
      onLog?.(job.id, line);
    };

    await acquireCpuBoost('job').catch((err) => {
      console.warn('[queue] cpu boost:', err?.message || err);
    });
    try {
      push('=== Job bắt đầu ===');
      if (job.cancelled) throw new Error('Job đã bị hủy.');
      const result = await job.run(push, job);
      if (job.cancelled) throw new Error('Job đã bị hủy.');
      job.result = result;
      job.status = 'success';
      job.finishedAt = new Date().toISOString();
      job.onDone?.({ ok: true, result });
    } catch (err) {
      const message = err?.message || String(err);
      job.error = message;
      job.status = job.cancelled ? 'cancelled' : 'error';
      job.finishedAt = new Date().toISOString();
      push(job.cancelled ? `⏹ Đã hủy: ${message}` : `❌ Lỗi: ${message}`);
      job.onDone?.({ ok: false, error: message, cancelled: Boolean(job.cancelled) });
    } finally {
      // Headless (VPS): đóng Chrome để khỏi đầy RAM. Local: giữ để debug.
      if (process.env.HEADLESS === 'true' && job.browser) {
        await job.browser.close?.().catch(() => {});
        job.browser = null;
      }
      active.delete(job.id);
      remember(job);
      onChange?.(snapshot());
      await releaseCpuBoost('job').catch((err) => {
        console.warn('[queue] cpu release:', err?.message || err);
      });
      setImmediate(() => pump());
    }
  }

  function pump() {
    if (pumping) return;
    pumping = true;
    try {
      while (active.size < limit && pending.length) {
        const job = pending.shift();
        // fire-and-forget; startOne tự gọi pump khi xong
        void startOne(job);
      }
    } finally {
      pumping = false;
    }
  }

  function cancel(jobId, { byUser } = {}) {
    const id = String(jobId || '');
    const pIdx = pending.findIndex((j) => j.id === id);
    if (pIdx >= 0) {
      const [job] = pending.splice(pIdx, 1);
      job.status = 'cancelled';
      job.cancelled = true;
      job.error = byUser ? `Hủy bởi ${byUser}` : 'Đã hủy';
      job.finishedAt = new Date().toISOString();
      remember(job);
      onChange?.(snapshot());
      return { ok: true, kind: 'pending', jobId: id };
    }
    const job = active.get(id);
    if (job) {
      job.cancelled = true;
      job.error = byUser ? `Hủy bởi ${byUser}` : 'Đã hủy';
      // Không đóng Chrome khi hủy — giữ cửa sổ để xem đang đứng ở đâu.
      onChange?.(snapshot());
      return { ok: true, kind: 'running', jobId: id };
    }
    return { ok: false, error: 'Không tìm thấy job.' };
  }

  function listActiveJobs() {
    return [...active.values()];
  }

  /** Đóng Chrome còn giữ sau job xong (cùng user). Không đụng job đang running. */
  async function closeBrowsersForUser(userId) {
    const uid = String(userId || '');
    if (!uid) return 0;
    let closed = 0;
    for (const j of [...recent.values(), ...active.values()]) {
      if (String(j.meta?.userId || '') !== uid) continue;
      if (active.has(j.id) && j.status === 'running') continue;
      if (!j.browser) continue;
      try {
        await j.browser.close?.().catch(() => {});
        closed += 1;
      } catch {
        /* ignore */
      }
      j.browser = null;
    }
    return closed;
  }

  /** Lấy browser đang giữ của user (Resume) — ưu tiên job recent mới nhất. */
  function takeBrowserForUser(userId) {
    const uid = String(userId || '');
    if (!uid) return null;
    const candidates = [...recent.values()]
      .filter((j) => String(j.meta?.userId || '') === uid && j.browser)
      .reverse();
    for (const j of candidates) {
      const b = j.browser;
      j.browser = null;
      try {
        if (b?.isConnected?.() === false) continue;
      } catch {
        continue;
      }
      return b;
    }
    return null;
  }

  return {
    enqueue,
    getJob,
    snapshot,
    snapshotForUser,
    cancel,
    listActiveJobs,
    closeBrowsersForUser,
    takeBrowserForUser,
    get active() {
      return active.values().next().value || null;
    },
    get runningCount() {
      return active.size;
    },
  };
}
