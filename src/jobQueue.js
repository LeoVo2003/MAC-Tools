import crypto from 'crypto';

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
          createdAt: j.createdAt || null,
        })),
      ],
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

  return {
    enqueue,
    getJob,
    snapshot,
    cancel,
    listActiveJobs,
    get active() {
      return active.values().next().value || null;
    },
    get runningCount() {
      return active.size;
    },
  };
}
