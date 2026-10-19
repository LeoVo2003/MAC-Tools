/**
 * Tracking runs — SQLite (B6), thay runs.jsonl.
 * Giữ nguyên mọi function export và shape row cho code gọi.
 */
import crypto from 'crypto';
import { db } from './db.js';

const stmtInsertRun = db.prepare(`
  INSERT INTO runs (id, user_id, status, started_at, finished_at, meta)
  VALUES (@id, @user_id, @status, @started_at, @finished_at, @meta)
`);
const stmtGetRun = db.prepare('SELECT * FROM runs WHERE id = ? LIMIT 1');
const stmtUpdateRun = db.prepare('UPDATE runs SET status = ?, finished_at = ?, meta = ? WHERE id = ?');
const stmtCountRuns = db.prepare('SELECT COUNT(*) AS c FROM runs');
const stmtRunningIds = db.prepare(`SELECT id FROM runs WHERE status = 'running'`);
const stmtClearRuns = db.prepare('DELETE FROM runs');

/** Map row DB → shape cũ (camelCase + meta spread). */
function toRow(r) {
  if (!r) return null;
  let meta = {};
  try { meta = JSON.parse(r.meta || '{}'); } catch { /* giữ rỗng */ }
  return {
    id: r.id,
    status: r.status,
    startedAt: r.started_at || null,
    finishedAt: r.finished_at || null,
    ...meta,
  };
}

function readAllRuns() {
  return db.prepare('SELECT * FROM runs ORDER BY started_at ASC').all().map(toRow);
}

function newId() {
  return crypto.randomUUID?.() || `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function durationOf(row) {
  if (row.durationMs != null && Number.isFinite(Number(row.durationMs))) return Number(row.durationMs);
  if (!row.startedAt || !row.finishedAt) return null;
  const a = Date.parse(row.startedAt);
  const b = Date.parse(row.finishedAt);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, b - a);
}

/**
 * @returns {string} runId
 */
export function startRun(meta = {}) {
  const id = newId();
  const { userId, ...rest } = meta || {};
  stmtInsertRun.run({
    id,
    user_id: userId ? String(userId) : null,
    status: 'running',
    started_at: new Date().toISOString(),
    finished_at: null,
    // Giữ userId trong meta để tương thích shape row cũ
    meta: JSON.stringify({ error: null, userId: userId ? String(userId) : null, ...rest }),
  });
  return id;
}

export function finishRun(id, { status = 'success', error = null, result = null, stepResults = null } = {}) {
  const r = stmtGetRun.get(String(id));
  if (!r) return;
  const row = toRow(r);
  const finishedAt = new Date().toISOString();
  const startMs = row.startedAt ? Date.parse(row.startedAt) : NaN;
  const endMs = Date.parse(finishedAt);
  const durationMs =
    Number.isFinite(startMs) && Number.isFinite(endMs) ? Math.max(0, endMs - startMs) : null;
  const merged = {
    ...row,
    status,
    error: error || null,
    finishedAt,
    durationMs,
    stepResults: Array.isArray(stepResults) ? stepResults : row.stepResults || null,
    resultSummary: result
      ? {
          project: result.project || '',
          loginUrl: result.loginUrl || '',
          username: result.username || '',
          accountExists: Boolean(result.accountExists),
        }
      : row.resultSummary || null,
  };
  const { id: _id, status: _s, startedAt, finishedAt: _f, ...meta } = merged;
  stmtUpdateRun.run(status, finishedAt, JSON.stringify(meta), String(id));
}

/** Chuẩn hóa tool: dòng cũ không có tool → f-package. */
export function normalizeTool(row) {
  const t = String(row?.tool || '').trim().toLowerCase();
  return t || 'f-package';
}

/**
 * @param {{ limit?: number, user?: string, from?: string, to?: string, status?: string, tool?: string }} [opts]
 */
export function listRuns({ limit = 100, user = '', from = '', to = '', status = '', tool = '' } = {}) {
  let rows = readAllRuns();
  const userQ = String(user || '').trim().toLowerCase();
  const statusQ = String(status || '').trim().toLowerCase();
  const toolQ = String(tool || '').trim().toLowerCase();
  const fromMs = from ? Date.parse(from) : NaN;
  const toMs = to ? Date.parse(to) : NaN;

  rows = rows.filter((r) => {
    if (userQ) {
      const u = String(r.toolUser || r.username || '').toLowerCase();
      if (!u.includes(userQ)) return false;
    }
    if (statusQ && String(r.status || '').toLowerCase() !== statusQ) return false;
    if (toolQ && normalizeTool(r) !== toolQ) return false;
    const t = r.startedAt ? Date.parse(r.startedAt) : NaN;
    if (Number.isFinite(fromMs) && Number.isFinite(t) && t < fromMs) return false;
    if (Number.isFinite(toMs) && Number.isFinite(t) && t > toMs + 24 * 60 * 60 * 1000 - 1) return false;
    return true;
  });

  return rows
    .map((r) => ({ ...r, tool: normalizeTool(r), durationMs: durationOf(r) }))
    .slice(-Math.min(2000, Math.max(1, Number(limit) || 100)))
    .reverse();
}

/** Thống kê gom theo tool: { tool, total, success, error, running, avgDurationMs, lastRunAt } */
export function statsByTool(rowsInput) {
  const rows = rowsInput || listRuns({ limit: 10000 });
  const map = new Map();
  for (const r of rows) {
    const t = normalizeTool(r);
    if (!map.has(t)) map.set(t, []);
    map.get(t).push(r);
  }
  return [...map.entries()].map(([tool, list]) => {
    const s = runsStats(list);
    const lastRunAt = list.reduce((max, r) => {
      const t = r.startedAt ? Date.parse(r.startedAt) : NaN;
      return Number.isFinite(t) && (!max || t > max) ? t : max;
    }, 0);
    return { tool, ...s, lastRunAt: lastRunAt ? new Date(lastRunAt).toISOString() : null };
  }).sort((a, b) => b.total - a.total);
}

/** Chuẩn hóa message để gom: thay URL và số bằng placeholder */
function normalizeErrorKey(msg) {
  return String(msg || '')
    .replace(/https?:\/\/[^\s]+/g, '<url>')
    .replace(/\b\d+(\.\d+)?\b/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

/** Gom lỗi gần đây theo nội dung: [{ error, count, lastAt, lastRunId, tool }] */
export function recentErrors({ limit = 1000, top = 10 } = {}) {
  const rows = listRuns({ limit }).filter((r) => r.status === 'error' && r.error);
  const map = new Map();
  for (const r of rows) {
    const key = normalizeErrorKey(r.error);
    if (!key) continue;
    if (!map.has(key)) map.set(key, { error: r.error, errorKey: key, count: 0, lastAt: null, lastRunId: null, tool: normalizeTool(r) });
    const e = map.get(key);
    e.count += 1;
    const t = r.startedAt ? Date.parse(r.startedAt) : NaN;
    if (Number.isFinite(t) && (!e.lastAt || t > Date.parse(e.lastAt))) {
      e.lastAt = r.startedAt;
      e.lastRunId = r.id;
      e.tool = normalizeTool(r);
      e.error = r.error; // giữ message gốc mới nhất để hiển thị
    }
  }
  return [...map.values()].sort((a, b) => b.count - a.count).slice(0, top);
}

export function runsStats(rowsInput) {
  const rows = rowsInput || listRuns({ limit: 10000 });
  const total = rows.length;
  const success = rows.filter((r) => r.status === 'success').length;
  const error = rows.filter((r) => r.status === 'error').length;
  const running = rows.filter((r) => r.status === 'running').length;
  const durations = rows.map(durationOf).filter((ms) => ms != null && ms > 0);
  const avgDurationMs =
    durations.length > 0 ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : null;
  return { total, success, error, running, avgDurationMs, sampleDurations: durations.length };
}

export function runsToCsv(rows) {
  const esc = (v) => {
    const s = String(v ?? '');
    if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  const header = [
    'startedAt',
    'finishedAt',
    'durationMs',
    'tool',
    'toolUser',
    'websiteUrl',
    'status',
    'username',
    'error',
  ];
  const lines = [header.join(',')];
  for (const r of rows) {
    lines.push(
      [
        r.startedAt,
        r.finishedAt,
        durationOf(r) ?? '',
        normalizeTool(r),
        r.toolUser || r.username || '',
        r.websiteUrl || '',
        r.status || '',
        r.resultSummary?.username || r.username || '',
        r.error || '',
      ]
        .map(esc)
        .join(',')
    );
  }
  return `${lines.join('\n')}\n`;
}

/** Xóa toàn bộ lịch sử báo cáo (admin). */
export function clearRuns() {
  const before = stmtCountRuns.get().c;
  stmtClearRuns.run();
  return { cleared: before };
}

/**
 * Xóa theo id (admin).
 * @param {string[]} ids
 */
export function deleteRunsByIds(ids) {
  const want = (ids || []).map((id) => String(id || '').trim()).filter(Boolean);
  if (!want.length) return { deleted: 0 };
  const placeholders = want.map(() => '?').join(',');
  const info = db.prepare(`DELETE FROM runs WHERE id IN (${placeholders})`).run(...want);
  return { deleted: info.changes };
}

/**
 * Xóa theo status (vd error, cancelled) — dọn báo cáo.
 * @param {string[]} statuses
 */
export function deleteRunsByStatuses(statuses) {
  const set = (statuses || []).map((s) => String(s || '').trim().toLowerCase()).filter(Boolean);
  if (!set.length) return { deleted: 0 };
  const placeholders = set.map(() => '?').join(',');
  const info = db.prepare(`DELETE FROM runs WHERE lower(status) IN (${placeholders})`).run(...set);
  return { deleted: info.changes };
}


/**
 * Đóng các run bị kẹt ở 'running' (server restart/crash giữa chừng).
 * Đánh dấu 'interrupted' để dashboard không hiện đang chạy mãi.
 * Gọi 1 lần khi server khởi động.
 * @returns {{ closed: number }}
 */
export function closeInterruptedRuns() {
  const running = stmtRunningIds.all();
  if (!running.length) return { closed: 0 };
  const finishedAt = new Date().toISOString();
  const closeOne = db.transaction((rows) => {
    let closed = 0;
    for (const { id } of rows) {
      const r = stmtGetRun.get(id);
      if (!r) continue;
      const row = toRow(r);
      const startMs = row.startedAt ? Date.parse(row.startedAt) : NaN;
      const endMs = Date.parse(finishedAt);
      const durationMs =
        Number.isFinite(startMs) && Number.isFinite(endMs) ? Math.max(0, endMs - startMs) : null;
      const { id: _id, status: _s, startedAt, finishedAt: _f, ...meta } = {
        ...row,
        error: 'Server restart giữa chừng (interrupted).',
        durationMs,
        stepResults: Array.isArray(row.stepResults) ? row.stepResults : [],
      };
      stmtUpdateRun.run('interrupted', finishedAt, JSON.stringify(meta), id);
      closed++;
    }
    return closed;
  });
  return { closed: closeOne(running) };
}

/**
 * Lấy runs trong khoảng ngày KHÔNG giới hạn 2000 dòng (cho thống kê).
 * @param {{ from?: string, to?: string }} [opts]
 */
export function listRunsUnlimited({ from = '', to = '' } = {}) {
  let rows = readAllRuns();
  const fromMs = from ? Date.parse(from) : NaN;
  const toMs = to ? Date.parse(to) : NaN;
  rows = rows.filter((r) => {
    const t = r.startedAt ? Date.parse(r.startedAt) : NaN;
    if (Number.isFinite(fromMs) && Number.isFinite(t) && t < fromMs) return false;
    if (Number.isFinite(toMs) && Number.isFinite(t) && t > toMs + 24 * 60 * 60 * 1000 - 1) return false;
    return true;
  });
  return rows.map((r) => ({ ...r, tool: normalizeTool(r), durationMs: durationOf(r) }));
}
