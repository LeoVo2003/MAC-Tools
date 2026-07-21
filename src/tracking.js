import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { getAppRoot } from './envStore.js';

const DATA_DIR = path.join(getAppRoot(), 'data');
const RUNS_FILE = path.join(DATA_DIR, 'runs.jsonl');

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

/**
 * Ghi 1 dòng JSONL mỗi lần chạy job (nền tảng báo cáo v2).
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

export function finishRun(id, { status = 'success', error = null, result = null } = {}) {
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

export function listRuns({ limit = 100 } = {}) {
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
  return rows.slice(-limit).reverse();
}

export function runsStats() {
  const rows = listRuns({ limit: 10000 });
  const total = rows.length;
  const success = rows.filter((r) => r.status === 'success').length;
  const error = rows.filter((r) => r.status === 'error').length;
  const running = rows.filter((r) => r.status === 'running').length;
  return { total, success, error, running };
}
