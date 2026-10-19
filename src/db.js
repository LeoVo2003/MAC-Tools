/**
 * SQLite (better-sqlite3) — thay thế lưu trữ file phẳng (B6).
 *
 * - users.json  → bảng `users`
 * - runs.jsonl  → bảng `runs`
 * - data/sessions/ (FileStore) GIỮ NGUYÊN, không đụng.
 *
 * DB: data/app.db, WAL mode. Migration 1 lần từ file cũ (nếu có) lúc mở DB.
 *
 * Fallback: nếu better-sqlite3 không cài được (vd Windows thiếu VS Build Tools),
 * tự dùng JSON file như cũ — server vẫn chạy bình thường.
 */
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { getAppRoot } from './envStore.js';

const require = createRequire(import.meta.url);
let Database = null;
try {
  Database = require('better-sqlite3');
} catch {
  console.warn('[db] better-sqlite3 không khả dụng — dùng JSON fallback (chậm hơn, vẫn an toàn).');
}

const DATA_DIR = path.join(getAppRoot(), 'data');
const DB_FILE = path.join(DATA_DIR, 'app.db');
const USERS_JSON = path.join(DATA_DIR, 'users.json');
const RUNS_JSONL = path.join(DATA_DIR, 'runs.jsonl');

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

ensureDataDir();

// JSON fallback helpers
function readJsonFile(f, def) {
  try {
    if (!fs.existsSync(f)) return def;
    return JSON.parse(fs.readFileSync(f, 'utf-8'));
  } catch { return def; }
}
function writeJsonFile(f, data) {
  const tmp = f + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, f);
}

let db = null;
let useJsonFallback = false;
if (Database) {
  db = new Database(DB_FILE);
  // WAL: đọc/ghi đồng thời, crash-safe hơn journal mặc định
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
} else {
  useJsonFallback = true;
}

/**
 * JSON fallback shim — implements db.prepare() interface using JSON files.
 * Dùng khi better-sqlite3 không cài được (Windows thiếu VS Build Tools).
 */
class JsonDbShim {
  constructor() {
    this.usersFile = USERS_JSON;
    this.runsFile = path.join(DATA_DIR, 'runs.json'); // dùng .json thay vì .jsonl cho đơn giản
    this._users = null;
    this._runs = null;
  }

  _loadUsers() {
    if (this._users === null) {
      const data = readJsonFile(this.usersFile, { users: [] });
      this._users = Array.isArray(data) ? data : (data.users || []);
    }
    return this._users;
  }

  _saveUsers() {
    writeJsonFile(this.usersFile, { users: this._users });
  }

  _loadRuns() {
    if (this._runs === null) {
      // Hỗ trợ cả .jsonl cũ và .json mới
      if (fs.existsSync(this.runsFile)) {
        this._runs = readJsonFile(this.runsFile, []);
      } else {
        const jsonl = path.join(DATA_DIR, 'runs.jsonl');
        if (fs.existsSync(jsonl)) {
          const lines = fs.readFileSync(jsonl, 'utf-8').split(/\r?\n/).filter(Boolean);
          this._runs = [];
          for (const line of lines) {
            try { this._runs.push(JSON.parse(line)); } catch {}
          }
        } else {
          this._runs = [];
        }
      }
      if (!Array.isArray(this._runs)) this._runs = [];
    }
    return this._runs;
  }

  _saveRuns() {
    writeJsonFile(this.runsFile, this._runs);
  }

  // Map row DB (snake_case) sang object user (camelCase) — giống toUser() trong userStore
  _dbUserToObj(r) {
    if (!r) return null;
    return {
      id: r.id,
      username: r.email, email: r.email,
      passwordHash: r.password_hash,
      wpmPasswordEnc: r.wpm_password_enc,
      role: r.is_admin ? 'admin' : 'user',
      wpmUsername: r.wpm_username,
      createdAt: r.created_at, updatedAt: r.updated_at,
    };
  }

  _objToDbUser(u) {
    return {
      id: String(u.id || ''),
      email: String(u.email || u.username || ''),
      password_hash: u.passwordHash || u.password_hash || '',
      wpm_password_enc: u.wpmPasswordEnc || u.wpm_password_enc || '',
      is_admin: (u.role === 'admin' || u.is_admin) ? 1 : 0,
      wpm_username: u.wpmUsername || u.wpm_username || '',
      created_at: u.createdAt || u.created_at || new Date().toISOString(),
      updated_at: u.updatedAt || u.updated_at || new Date().toISOString(),
    };
  }

  prepare(sql) {
    const s = sql.replace(/\s+/g, ' ').trim();
    
    // --- USERS ---
    if (/SELECT \* FROM users WHERE lower\(email\)/i.test(s)) {
      return {
        get: (email) => {
          const users = this._loadUsers();
          const found = users.find(u => String(u.email || u.username || '').toLowerCase() === String(email).toLowerCase());
          return found ? this._objToDbUser(found) : undefined;
        },
      };
    }
    if (/SELECT \* FROM users WHERE id/i.test(s)) {
      return {
        get: (id) => {
          const users = this._loadUsers();
          const found = users.find(u => String(u.id) === String(id));
          return found ? this._objToDbUser(found) : undefined;
        },
      };
    }
    if (/SELECT .* FROM users ORDER BY/i.test(s)) {
      return {
        all: () => this._loadUsers().map(u => this._objToDbUser(u)),
      };
    }
    if (/INSERT INTO users/i.test(s)) {
      return {
        run: (params) => {
          const users = this._loadUsers();
          const obj = params.id ? params : null; // named params (@id, ...)
          const row = obj || {};
          // Chuyển params thành user object
          const user = {
            id: row.id, email: row.email, passwordHash: row.password_hash,
            wpmPasswordEnc: row.wpm_password_enc, role: row.is_admin ? 'admin' : 'user',
            wpmUsername: row.wpm_username, createdAt: row.created_at, updatedAt: row.updated_at,
          };
          const idx = users.findIndex(u => String(u.id) === String(user.id));
          if (idx >= 0) users[idx] = { ...users[idx], ...user };
          else users.push(user);
          this._saveUsers();
          return { changes: 1 };
        },
      };
    }
    if (/UPDATE users SET/i.test(s)) {
      return {
        run: (...args) => {
          const users = this._loadUsers();
          // Parse SET clause để biết update field nào — đơn giản: merge theo id cuối cùng
          const id = args[args.length - 1];
          const idx = users.findIndex(u => String(u.id) === String(id));
          if (idx < 0) return { changes: 0 };
          // Dựa vào SQL để map args
          if (/wpm_username/i.test(s)) {
            users[idx].wpmUsername = args[0];
            users[idx].wpmPasswordEnc = args[1];
          } else if (/password_hash/i.test(s)) {
            users[idx].passwordHash = args[0];
          } else if (/is_admin/i.test(s)) {
            users[idx].role = args[0] ? 'admin' : 'user';
          }
          users[idx].updatedAt = args[args.length - 2] || new Date().toISOString();
          this._saveUsers();
          return { changes: 1 };
        },
      };
    }

    // --- RUNS ---
    if (/SELECT \* FROM runs WHERE id/i.test(s)) {
      return {
        get: (id) => {
          const runs = this._loadRuns();
          return runs.find(r => String(r.id) === String(id));
        },
      };
    }
    if (/INSERT INTO runs/i.test(s)) {
      return {
        run: (params) => {
          const runs = this._loadRuns();
          const meta = params.meta ? JSON.parse(params.meta) : {};
          const run = { id: params.id, userId: params.user_id, status: params.status,
            startedAt: params.started_at, finishedAt: params.finished_at, ...meta };
          const idx = runs.findIndex(r => String(r.id) === String(run.id));
          if (idx >= 0) runs[idx] = run; else runs.push(run);
          this._saveRuns();
          return { changes: 1 };
        },
      };
    }
    if (/UPDATE runs SET/i.test(s)) {
      return {
        run: (...args) => {
          const runs = this._loadRuns();
          const id = args[args.length - 1];
          const idx = runs.findIndex(r => String(r.id) === String(id));
          if (idx < 0) return { changes: 0 };
          const meta = args[2] ? JSON.parse(args[2]) : {};
          runs[idx] = { ...runs[idx], status: args[0], finishedAt: args[1], ...meta };
          this._saveRuns();
          return { changes: 1 };
        },
      };
    }
    if (/SELECT COUNT\(\*\) AS c FROM runs/i.test(s)) {
      return { get: () => ({ c: this._loadRuns().length }) };
    }
    if (/SELECT COUNT\(\*\) AS c FROM users/i.test(s)) {
      return { get: () => ({ c: this._loadUsers().length }) };
    }
    if (/SELECT id FROM runs WHERE status/i.test(s)) {
      return { all: () => this._loadRuns().filter(r => r.status === 'running').map(r => ({ id: r.id })) };
    }
    if (/SELECT \* FROM runs ORDER BY/i.test(s)) {
      return {
        all: () => [...this._loadRuns()].sort((a, b) => String(a.startedAt || '').localeCompare(String(b.startedAt || '')))
          .map(r => ({ id: r.id, user_id: r.userId, status: r.status, started_at: r.startedAt,
            finished_at: r.finishedAt, meta: JSON.stringify(r) })),
      };
    }
    if (/DELETE FROM runs WHERE id IN/i.test(s)) {
      return {
        run: (...ids) => {
          const runs = this._loadRuns();
          const before = runs.length;
          this._runs = runs.filter(r => !ids.map(String).includes(String(r.id)));
          this._saveRuns();
          return { changes: before - this._runs.length };
        },
      };
    }
    if (/DELETE FROM runs WHERE lower\(status\)/i.test(s)) {
      return {
        run: (...statuses) => {
          const runs = this._loadRuns();
          const before = runs.length;
          const lower = statuses.map(s => String(s).toLowerCase());
          this._runs = runs.filter(r => !lower.includes(String(r.status || '').toLowerCase()));
          this._saveRuns();
          return { changes: before - this._runs.length };
        },
      };
    }
    if (/DELETE FROM runs$/i.test(s.trim())) {
      return {
        run: () => {
          const before = this._loadRuns().length;
          this._runs = [];
          this._saveRuns();
          return { changes: before };
        },
      };
    }

    throw new Error('[db-shim] Query chưa hỗ trợ: ' + s.slice(0, 80));
  }

  exec() { /* no-op cho CREATE TABLE */ }
  transaction(fn) { return fn; } // JSON ghi đã atomic qua tmp+rename
}

if (!db) {
  db = new JsonDbShim();
  console.log('[db] Dùng JSON fallback (better-sqlite3 không khả dụng).');
} else {
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
}

function tableCount(name) {
  if (!db) return 0;
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
 * Bỏ qua nếu dùng JSON fallback (không có SQLite).
 */
function migrateLegacyFiles() {
  if (!db) return;
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
  if (!db) return { deleted: 0 };
  const n = Math.max(1, Number(days) || 90);
  const cutoff = new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
  const info = db.prepare(`DELETE FROM runs WHERE started_at IS NOT NULL AND started_at < ?`).run(cutoff);
  return { deleted: info.changes };
}

export { db, useJsonFallback };
export default db;
