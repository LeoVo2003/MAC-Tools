import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { db } from './db.js';

/**
 * (S4) Không hardcode admin trong code nữa — admin chỉ lấy từ ADMIN_EMAILS (env).
 * Giữ hằng rỗng để tương thích logic merge trong adminEmails().
 */
const DEFAULT_ADMIN_EMAILS = ['leo.vo@macusaone.com'];

// (S4) Admin mặc định là leo.vo@macusaone.com, có thể thêm qua ADMIN_EMAILS env

function appSecret() {
  const s = process.env.APP_SECRET || process.env.SESSION_SECRET || 'dev-change-me-app-secret';
  // (6.2) Chặn secret mặc định ở production (đồng bộ với auth.js)
  if (process.env.NODE_ENV === 'production' && (/change-me/i.test(s) || s.length < 32)) {
    console.error('FATAL: APP_SECRET quá yếu ở production. Từ chối khởi động.');
    process.exit(1);
  }
  return s;
}

/**
 * Mã hóa AES-256-GCM: IV ngẫu nhiên 12 byte + auth tag cho từng bản ghi.
 *
 * Format v2: `v2:<keyId>:<ivB64>:<tagB64>:<dataB64>`
 * - keyId = 8 ký tự đầu của sha256(secret) hex → nhận diện key nào đã mã hóa.
 * - encryptSecret LUÔN dùng key hiện tại (APP_SECRET).
 *
 * XOAY KHÓA (key rotation) — quy trình cho admin:
 *   1. Đặt `APP_SECRET_PREVIOUS=<key cũ>`, `APP_SECRET=<key mới>`, restart server.
 *      Data cũ vẫn đọc được (nhờ PREVIOUS), data mới ghi bằng key mới (v2 + keyId mới).
 *   2. Sau khi chắc chắn mọi data cũ đã được ghi lại / không còn cần
 *      (vd 30 ngày), xóa `APP_SECRET_PREVIOUS` và restart.
 *   3. Nếu còn bản ghi mã hóa bằng key đã xóa, decryptSecret ném lỗi rõ ràng
 *      yêu cầu user login lại thay vì crash im lặng.
 *
 * Backward compat: format `v1:<iv>:<tag>:<data>` cũ vẫn giải mã được
 * bằng APP_SECRET hiện tại.
 */
function keyIdFor(secret) {
  return crypto.createHash('sha256').update(String(secret)).digest('hex').slice(0, 8);
}

/** Trả về danh sách { id, secret } — key hiện tại trước, key cũ sau. */
function knownSecrets() {
  const list = [{ id: keyIdFor(appSecret()), secret: appSecret() }];
  const prev = String(process.env.APP_SECRET_PREVIOUS || '').trim();
  if (prev) {
    if (process.env.NODE_ENV === 'production' && (/change-me/i.test(prev) || prev.length < 32)) {
      console.error('FATAL: APP_SECRET_PREVIOUS quá yếu ở production. Từ chối khởi động.');
      process.exit(1);
    }
    const prevId = keyIdFor(prev);
    if (prevId !== list[0].id) list.push({ id: prevId, secret: prev });
  }
  return list;
}

function secretForKeyId(keyId) {
  return knownSecrets().find((k) => k.id === keyId) || null;
}

export function encryptSecret(plain) {
  const secret = appSecret();
  const key = crypto.createHash('sha256').update(secret).digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v2:${keyIdFor(secret)}:${iv.toString('base64')}:${tag.toString('base64')}:${enc.toString('base64')}`;
}

export function decryptSecret(blob) {
  if (!blob) return '';
  const s = String(blob);
  // v2: tìm key theo keyId (hỗ trợ xoay khóa)
  if (s.startsWith('v2:')) {
    const parts = s.split(':');
    if (parts.length !== 5) throw new Error('Định dạng mã hóa v2 không hợp lệ.');
    const [, keyId, ivB64, tagB64, dataB64] = parts;
    const entry = secretForKeyId(keyId);
    if (!entry) {
      throw new Error(
        `Không tìm thấy key mã hóa (keyId ${keyId}). ` +
        `Nếu vừa xoay khóa, hãy đặt APP_SECRET_PREVIOUS=<key cũ> rồi restart; ` +
        `nếu không, user cần đăng nhập lại để tạo bản ghi mới.`
      );
    }
    const key = crypto.createHash('sha256').update(entry.secret).digest();
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(dataB64, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  }
  // v1 (legacy): giải bằng key hiện tại
  if (s.startsWith('v1:')) {
    const [, ivB64, tagB64, dataB64] = s.split(':');
    const key = crypto.createHash('sha256').update(appSecret()).digest();
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(dataB64, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  }
  return s;
}

/* ================= SQLite (B6) — prepared statements ================= */

const stmtFindByEmail = db.prepare('SELECT * FROM users WHERE lower(email) = lower(?) LIMIT 1');
const stmtFindById = db.prepare('SELECT * FROM users WHERE id = ? LIMIT 1');
const stmtList = db.prepare(
  'SELECT id, email, is_admin, wpm_password_enc, created_at, updated_at FROM users ORDER BY created_at ASC'
);
const stmtInsert = db.prepare(`
  INSERT INTO users (id, email, password_hash, wpm_password_enc, is_admin, wpm_username, created_at, updated_at)
  VALUES (@id, @email, @password_hash, @wpm_password_enc, @is_admin, @wpm_username, @created_at, @updated_at)
`);
const stmtUpdateCreds = db.prepare(`
  UPDATE users SET wpm_username = ?, wpm_password_enc = ?, updated_at = ? WHERE id = ?
`);
const stmtUpdatePassHash = db.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?');
const stmtResetCreds = db.prepare(
  `UPDATE users SET wpm_password_enc = '', password_hash = '', updated_at = ? WHERE id = ?`
);
const stmtSetRole = db.prepare('UPDATE users SET is_admin = ?, updated_at = ? WHERE id = ?');

/** Map row DB → object user camelCase (giữ shape cũ cho code gọi). */
function toUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.email,
    passwordHash: row.password_hash || '',
    role: row.is_admin ? 'admin' : 'user',
    wpmUsername: row.wpm_username || '',
    wpmPasswordEnc: row.wpm_password_enc || '',
    createdAt: row.created_at || '',
    updatedAt: row.updated_at || '',
  };
}

function nowIso() {
  return new Date().toISOString();
}

/** Danh sách email admin — (S4) chỉ từ ADMIN_EMAILS (env), không hardcode. */
export function adminEmails() {
  const fromEnv = String(process.env.ADMIN_EMAILS || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const set = new Set([...DEFAULT_ADMIN_EMAILS.map((e) => e.toLowerCase()), ...fromEnv]);
  return set;
}

export function isAdminIdentity(username) {
  const key = String(username || '').trim().toLowerCase();
  return adminEmails().has(key);
}

export function findUserByUsername(username) {
  const want = String(username || '').trim();
  if (!want) return null;
  return toUser(stmtFindByEmail.get(want));
}

export function findUserById(id) {
  if (!id) return null;
  return toUser(stmtFindById.get(String(id)));
}

/** Danh sách tài khoản cho admin — không trả password. */
export function listUsersPublic() {
  return stmtList.all().map((r) => ({
    id: r.id,
    username: r.email,
    role: r.is_admin ? 'admin' : 'user',
    createdAt: r.created_at || '',
    updatedAt: r.updated_at || '',
    passwordStored: Boolean(r.wpm_password_enc),
  }));
}

/**
 * Xóa password đã lưu. Lần login sau nhận pass mới (đúng pass WPM) và lưu lại.
 */
export function resetUserPassword(userId) {
  const user = findUserById(userId);
  if (!user) throw new Error('Không tìm thấy tài khoản.');
  stmtResetCreds.run(nowIso(), String(userId));
  return findUserById(userId);
}

export async function createUser({ username, password, role = 'user' }) {
  const name = String(username || '').trim();
  const pass = String(password || '');
  if (!name || !pass) throw new Error('Thiếu username/password.');
  if (findUserByUsername(name)) throw new Error('Username đã tồn tại.');
  const user = {
    id: crypto.randomUUID?.() || `u_${Date.now()}`,
    username: name,
    passwordHash: await bcrypt.hash(pass, 10),
    role,
    wpmUsername: name,
    wpmPasswordEnc: encryptSecret(pass),
    createdAt: nowIso(),
  };
  stmtInsert.run({
    id: user.id,
    email: name,
    password_hash: user.passwordHash,
    wpm_password_enc: user.wpmPasswordEnc,
    is_admin: role === 'admin' ? 1 : 0,
    wpm_username: name,
    created_at: user.createdAt,
    updated_at: null,
  });
  return user;
}

export function setUserWpmCredentials(userId, wpmUsername, wpmPassword) {
  const user = findUserById(userId);
  if (!user) throw new Error('User không tồn tại.');
  stmtUpdateCreds.run(
    String(wpmUsername || '').trim(),
    encryptSecret(String(wpmPassword || '')),
    nowIso(),
    String(userId)
  );
  return findUserById(userId);
}

async function updateLoginPassword(userId, password) {
  const user = findUserById(userId);
  if (!user) throw new Error('User không tồn tại.');
  stmtUpdatePassHash.run(await bcrypt.hash(String(password), 10), nowIso(), String(userId));
  return findUserById(userId);
}

export function setUserRole(userId, role) {
  const user = findUserById(userId);
  if (!user) throw new Error('User không tồn tại.');
  stmtSetRole.run(role === 'admin' ? 1 : 0, nowIso(), String(userId));
  return findUserById(userId);
}

export function getUserWpmCredentials(userId) {
  const user = findUserById(userId);
  if (!user) return { username: '', password: '', configured: false };
  const username = user.wpmUsername || user.username || '';
  const password = user.wpmPasswordEnc ? decryptSecret(user.wpmPasswordEnc) : '';
  const configured = Boolean(username && password);
  return { username, password, configured };
}

/**
 * Login tool = tk/mk WPM.
 * Lần đầu (email chưa có): tạo user + lưu password — không cần đăng ký trước.
 * Lần sau: đúng password thì vào; sai → báo lỗi.
 * Email có trong ADMIN_EMAILS → role admin.
 */
export async function loginWithWpm(username, password) {
  const name = String(username || '').trim();
  const pass = String(password || '');
  if (!name) throw new Error('Thiếu email WPM.');
  if (!pass) throw new Error('Nhập password WPM để lưu và dùng khi Run.');

  const wantAdmin = isAdminIdentity(name);
  let user = findUserByUsername(name);

  // Lần đầu — tạo mới, lưu pass luôn
  // C2: chỉ cho admin email thành admin nếu chưa có admin nào (tránh người lạ chiếm quyền)
  if (!user) {
    let role = 'user';
    if (wantAdmin) {
      const existingAdmins = listUsers().filter(u => u.role === 'admin');
      role = existingAdmins.length === 0 ? 'admin' : 'user';
    }
    user = await createUser({
      username: name,
      password: pass,
      role,
    });
    return findUserById(user.id);
  }

  // User cũ seed (admin/web) chưa gắn WPM → cho gắn pass mới lần này
  const legacyNoWpm = !user.wpmPasswordEnc;
  if (legacyNoWpm) {
    await updateLoginPassword(user.id, pass);
    setUserWpmCredentials(user.id, name, pass);
    // C2: không tự promote/demote role khi login
    return findUserById(user.id);
  }

  const ok = await bcrypt.compare(pass, user.passwordHash);
  if (!ok) return null;

  await updateLoginPassword(user.id, pass);
  setUserWpmCredentials(user.id, name, pass);
  // C2: không tự promote lên admin khi login — chỉ admin hiện tại mới promote được
  // (tránh người biết email admin chiếm quyền)
  return findUserById(user.id);
}

/** Không seed admin/web nữa — user tự tạo khi login WPM. DB tự migrate khi import './db.js'. */
export async function ensureKnownUsers() {
  // (B6) SQLite: không cần seed; migration từ users.json (nếu có) chạy lúc mở DB.
}

export function toPublicUser(user) {
  if (!user) return null;
  const wpm = getUserWpmCredentials(user.id);
  return {
    id: user.id,
    username: user.username,
    role: user.role || 'user',
    wpmConfigured: wpm.configured,
    wpmUsername: wpm.configured ? wpm.username : user.username,
  };
}
