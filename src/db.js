/**
 * SQLite (better-sqlite3) — thay thế lưu trữ file phẳng (B6).
 *
 * - users.json  → bảng `users`
 * - runs.jsonl  → bảng `runs`
 * - data/sessions/ (FileStore) GIỮ NGUYÊN, không đụng.
 *
 * DB: data/app.db, WAL mode. Migration 1 lần từ file cũ (nếu có) lúc mở DB.
 */
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { getAppRoot } from './envStore.js';

const DATA_DIR = path.join(getAppRoot(), 'data');
const DB_FILE = path.join(DATA_DIR, 'app.db');

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

ensureDataDir();
const db = new Database(DB_FILE);
// WAL: đọc/ghi đồng thời, crash-safe hơn journal mặc định
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE,
    password_hash TEXT,
    wpm_password_enc TEXT,
    is_admin INTEGER NOT NULL DEFAULT 0,
    wpm_username TEXT,
    created_at TEXT,
    updated_at TEXT
  );
  CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY,
    user_id TEXT,
    status TEXT NOT NULL DEFAULT 'running',
    started_at TEXT,
    finished_at TEXT,
    meta TEXT NOT NULL DEFAULT '{}'
  );
  CREATE INDEX IF NOT EXISTS idx_runs_started ON runs(started_at DESC);
  CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);
  CREATE INDEX IF NOT EXISTS idx_runs_user ON runs(user_id);
`);

function tableCount(name) {
  const row = db.prepare(`SELECT COUNT(*) AS c FROM ${name}`).get();
  return row ? row.c : 0;
}

function renameMigrated(filePath) {
  const bak = `${filePath}.migrated-${Date.now()}.bak`;
  fs.renameSync(filePath, bak);
  return bak;
}

/**
 * Migration 1 lần từ file phẳng cũ → SQLite (B6).
 * Chỉ chạy khi bảng đích còn trống (tránh import trùng nếu file cũ còn sót).
 */
function migrateLegacyFiles() {
  // --- users.json ---
  const usersFile = path.join(DATA_DIR, 'users.json');
  if (fs.existsSync(usersFile) && tableCount('users') === 0) {
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(usersFile, 'utf-8'));
    } catch (e) {
      // (6.3 cũ) File hỏng → backup + FAIL LOUD, không im lặng bỏ qua
      const bak = `${usersFile}.corrupt-${Date.now()}.bak`;
      try { fs.copyFileSync(usersFile, bak); } catch {}
      throw new Error(`users.json hỏng (đã backup tại ${bak}): ${e.message}`);
    }
    const users = Array.isArray(parsed) ? parsed : parsed.users || [];
    const insert = db.prepare(`
      INSERT OR IGNORE INTO users (id, email, password_hash, wpm_password_enc, is_admin, wpm_username, created_at, updated_at)
      VALUES (@id, @email, @password_hash, @wpm_password_enc, @is_admin, @wpm_username, @created_at, @updated_at)
    `);
    const migrate = db.transaction((list) => {
      for (const u of list) {
        insert.run({
          id: String(u.id || ''),
          email: String(u.username || u.email || '').trim(),
          password_hash: u.passwordHash || '',
          wpm_password_enc: u.wpmPasswordEnc || '',
          is_admin: u.role === 'admin' ? 1 : 0,
          wpm_username: u.wpmUsername || u.username || '',
          created_at: u.createdAt || null,
          updated_at: u.updatedAt || null,
        });
      }
    });
    migrate(users.filter((u) => u && (u.username || u.email) && u.id));
    const bak = renameMigrated(usersFile);
    console.log(`[db] Đã migrate ${users.length} user từ users.json → SQLite (${bak}).`);
  }

  // --- runs.jsonl ---
  const runsFile = path.join(DATA_DIR, 'runs.jsonl');
  if (fs.existsSync(runsFile) && tableCount('runs') === 0) {
    const lines = fs.readFileSync(runsFile, 'utf-8').split(/\r?\n/).filter(Boolean);
    const insert = db.prepare(`
      INSERT OR IGNORE INTO runs (id, user_id, status, started_at, finished_at, meta)
      VALUES (@id, @user_id, @status, @started_at, @finished_at, @meta)
    `);
    const migrate = db.transaction((list) => {
      for (const row of list) {
        const { id, userId, status, startedAt, finishedAt, ...rest } = row;
        if (!id) continue;
        insert.run({
          id: String(id),
          user_id: userId ? String(userId) : null,
          status: String(status || 'running'),
          started_at: startedAt || null,
          finished_at: finishedAt || null,
          meta: JSON.stringify(rest),
        });
      }
    });
    const rows = [];
    for (const line of lines) {
      try { rows.push(JSON.parse(line)); } catch { /* skip dòng hỏng */ }
    }
    if (rows.length) migrate(rows);
    const bak = renameMigrated(runsFile);
    console.log(`[db] Đã migrate ${rows.length} runs từ runs.jsonl → SQLite (${bak}).`);
  }
}

migrateLegacyFiles();

/**
 * Xóa runs cũ hơn `days` ngày (B6 retention, mặc định 90).
 * @returns {{ deleted: number }}
 */
export function pruneRuns(days = 90) {
  const n = Math.max(1, Number(days) || 90);
  const cutoff = new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
  const info = db.prepare(`DELETE FROM runs WHERE started_at IS NOT NULL AND started_at < ?`).run(cutoff);
  return { deleted: info.changes };
}

export { db };
export default db;
