import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { getAppRoot } from './envStore.js';

const DATA_DIR = path.join(getAppRoot(), 'data');
const RUNS_FILE = path.join(DATA_DIR, 'runs.jsonl');

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
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
  ensureDataDir();
  const id = crypto.randomUUID?.() || `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const row = {
    id,
    status: 'running',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    error: null,
    ...meta,
  };
  fs.appendFileSync(RUNS_FILE, `${JSON.stringify(row)}\n`, 'utf-8');
  return id;
}

export function finishRun(id, { status = 'success', error = null, result = null, stepResults = null } = {}) {
  ensureDataDir();
  if (!fs.existsSync(RUNS_FILE)) return;
  const lines = fs.readFileSync(RUNS_FILE, 'utf-8').split(/\r?\n/).filter(Boolean);
  const finishedAt = new Date().toISOString();
  const updated = lines.map((line) => {
    try {
      const row = JSON.parse(line);
      if (row.id !== id) return line;
      const startMs = row.startedAt ? Date.parse(row.startedAt) : NaN;
      const endMs = Date.parse(finishedAt);
      const durationMs =
        Number.isFinite(startMs) && Number.isFinite(endMs) ? Math.max(0, endMs - startMs) : null;
      return JSON.stringify({
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
      });
    } catch {
      return line;
    }
  });
  fs.writeFileSync(RUNS_FILE, `${updated.join('\n')}\n`, 'utf-8');
}

function readAllRuns() {
  ensureDataDir();
  if (!fs.existsSync(RUNS_FILE)) return [];
  const lines = fs.readFileSync(RUNS_FILE, 'utf-8').split(/\r?\n/).filter(Boolean);
  const rows = [];
  for (const line of lines) {
    try {
      rows.push(JSON.parse(line));
    } catch {
      /* skip */
    }
  }
  return rows;
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

/** Gom lỗi gần đây theo nội dung: [{ error, count, lastAt, lastRunId, tool }] */
export function recentErrors({ limit = 1000, top = 10 } = {}) {
  const rows = listRuns({ limit }).filter((r) => r.status === 'error' && r.error);
  const map = new Map();
  for (const r of rows) {
    const key = String(r.error).trim().slice(0, 200);
    if (!key) continue;
    if (!map.has(key)) map.set(key, { error: key, count: 0, lastAt: null, lastRunId: null, tool: normalizeTool(r) });
    const e = map.get(key);
    e.count += 1;
    const t = r.startedAt ? Date.parse(r.startedAt) : NaN;
    if (Number.isFinite(t) && (!e.lastAt || t > Date.parse(e.lastAt))) {
      e.lastAt = r.startedAt;
      e.lastRunId = r.id;
      e.tool = normalizeTool(r);
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
  ensureDataDir();
  const before = readAllRuns().length;
  fs.writeFileSync(RUNS_FILE, '', 'utf-8');
  return { cleared: before };
}

/**
 * Xóa theo id (admin).
 * @param {string[]} ids
 */
export function deleteRunsByIds(ids) {
  ensureDataDir();
  const want = new Set((ids || []).map((id) => String(id || '').trim()).filter(Boolean));
  if (!want.size) return { deleted: 0 };
  const rows = readAllRuns();
  const kept = rows.filter((r) => !want.has(String(r.id || '')));
  const deleted = rows.length - kept.length;
  fs.writeFileSync(
    RUNS_FILE,
    kept.length ? `${kept.map((r) => JSON.stringify(r)).join('\n')}\n` : '',
    'utf-8'
  );
  return { deleted };
}

/**
 * Xóa theo status (vd error, cancelled) — dọn báo cáo.
 * @param {string[]} statuses
 */
export function deleteRunsByStatuses(statuses) {
  ensureDataDir();
  const set = new Set(
    (statuses || []).map((s) => String(s || '').trim().toLowerCase()).filter(Boolean)
  );
  if (!set.size) return { deleted: 0 };
  const rows = readAllRuns();
  const kept = rows.filter((r) => !set.has(String(r.status || '').toLowerCase()));
  const deleted = rows.length - kept.length;
  fs.writeFileSync(
    RUNS_FILE,
    kept.length ? `${kept.map((r) => JSON.stringify(r)).join('\n')}\n` : '',
    'utf-8'
  );
  return { deleted };
}


/**
 * Đóng các run bị kẹt ở 'running' (server restart/crash giữa chừng).
 * Đánh dấu 'interrupted' để dashboard không hiện đang chạy mãi.
 * Gọi 1 lần khi server khởi động.
 * @returns {{ closed: number }}
 */
export function closeInterruptedRuns() {
  ensureDataDir();
  if (!fs.existsSync(RUNS_FILE)) return { closed: 0 };
  const lines = fs.readFileSync(RUNS_FILE, 'utf-8').split(/\r?\n/).filter(Boolean);
  const finishedAt = new Date().toISOString();
  let closed = 0;
  const updated = lines.map((line) => {
    try {
      const row = JSON.parse(line);
      if (row.status !== 'running') return line;
      closed++;
      const startMs = row.startedAt ? Date.parse(row.startedAt) : NaN;
      const endMs = Date.parse(finishedAt);
      const durationMs =
        Number.isFinite(startMs) && Number.isFinite(endMs) ? Math.max(0, endMs - startMs) : null;
      // Bước nào start mà chưa done → đánh dấu interrupted
      const stepResults = Array.isArray(row.stepResults) ? row.stepResults : [];
      return JSON.stringify({
        ...row,
        status: 'interrupted',
        error: 'Server restart giữa chừng (interrupted).',
        finishedAt,
        durationMs,
        stepResults,
      });
    } catch {
      return line;
    }
  });
  if (closed > 0) {
    fs.writeFileSync(RUNS_FILE, `${updated.join('\n')}\n`, 'utf-8');
  }
  return { closed };
}
