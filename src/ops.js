import fs from 'fs';
import path from 'path';
import { DOWNLOADS_DIR } from './utils.js';
import { findChromePath } from './browser.js';
import { listBackupFolders } from './backupsApi.js';

function safeResolveUnder(root, ...parts) {
  const rootAbs = path.resolve(root);
  const target = path.resolve(rootAbs, ...parts);
  const rel = path.relative(rootAbs, target);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error('Đường dẫn không hợp lệ.');
  }
  return target;
}

function rmDirRecursive(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

/**
 * Xóa folder backup cũ hơn maxAgeDays (mặc định 7).
 * @returns {{ deleted: string[], kept: number, maxAgeDays: number }}
 */
export function purgeOldBackups(maxAgeDays = 7) {
  const days = Math.max(1, Number(maxAgeDays) || 7);
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const deleted = [];
  if (!fs.existsSync(DOWNLOADS_DIR)) {
    return { deleted, kept: 0, maxAgeDays: days };
  }
  for (const d of fs.readdirSync(DOWNLOADS_DIR, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const dir = path.join(DOWNLOADS_DIR, d.name);
    let mtime = 0;
    try {
      mtime = fs.statSync(dir).mtimeMs;
    } catch {
      continue;
    }
    if (mtime < cutoff) {
      try {
        rmDirRecursive(safeResolveUnder(DOWNLOADS_DIR, d.name));
        deleted.push(d.name);
      } catch (err) {
        console.warn(`[retention] Không xóa được ${d.name}:`, err?.message || err);
      }
    }
  }
  const kept = listBackupFolders().length;
  return { deleted, kept, maxAgeDays: days };
}

function diskUsage(dir) {
  try {
    if (!fs.existsSync(dir)) {
      return { path: dir, exists: false };
    }
    // Ước lượng dung lượng downloads (đệ quy nhẹ)
    let bytes = 0;
    const walk = (p) => {
      let st;
      try {
        st = fs.statSync(p);
      } catch {
        return;
      }
      if (st.isFile()) {
        bytes += st.size;
        return;
      }
      if (st.isDirectory()) {
        for (const name of fs.readdirSync(p)) walk(path.join(p, name));
      }
    };
    walk(dir);
    return {
      path: dir,
      exists: true,
      bytes,
      mb: Math.round((bytes / (1024 * 1024)) * 10) / 10,
    };
  } catch (err) {
    return { path: dir, error: err?.message || String(err) };
  }
}

/**
 * @param {{ queueSnapshot: object, staleMinutes?: number, diskWarnMb?: number }} opts
 */
export function buildHealthReport({ queueSnapshot, staleMinutes = 45, diskWarnMb = 8000 } = {}) {
  const alerts = [];
  let chrome = { ok: false, path: '' };
  try {
    chrome = { ok: true, path: findChromePath() };
  } catch (err) {
    chrome = { ok: false, path: '', error: err?.message || String(err) };
    alerts.push({ level: 'error', code: 'chrome_missing', message: chrome.error });
  }

  const disk = diskUsage(DOWNLOADS_DIR);
  if (disk.mb != null && disk.mb >= diskWarnMb) {
    alerts.push({
      level: 'warn',
      code: 'disk_downloads',
      message: `Thư mục downloads ~${disk.mb} MB (ngưỡng ${diskWarnMb} MB).`,
    });
  }

  const staleMs = Math.max(5, Number(staleMinutes) || 45) * 60 * 1000;
  const now = Date.now();
  const staleJobs = (queueSnapshot?.queue || [])
    .filter((j) => j.status === 'running')
    .map((j) => {
      // startedAt không có trong snapshot — bổ sung từ queue nếu có
      return j;
    });

  return {
    chrome,
    disk,
    queue: queueSnapshot || null,
    alerts,
    staleMinutes,
    diskWarnMb,
    checkedAt: new Date().toISOString(),
    _staleMs: staleMs,
    _now: now,
    _staleJobsPlaceholder: staleJobs,
  };
}

/** Bổ sung stale jobs từ map active (server truyền vào). */
export function detectStaleJobs(activeJobs, staleMinutes = 45) {
  const staleMs = Math.max(5, Number(staleMinutes) || 45) * 60 * 1000;
  const now = Date.now();
  const stale = [];
  for (const job of activeJobs || []) {
    const start = job.startedAt ? Date.parse(job.startedAt) : NaN;
    if (!Number.isFinite(start)) continue;
    if (now - start >= staleMs) {
      stale.push({
        id: job.id,
        user: job.meta?.username,
        startedAt: job.startedAt,
        ageMinutes: Math.round((now - start) / 60000),
      });
    }
  }
  return stale;
}
