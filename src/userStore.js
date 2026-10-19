import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { getAppRoot } from './envStore.js';

const DATA_DIR = path.join(getAppRoot(), 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');

/**
 * (S4) Không hardcode admin trong code nữa — admin chỉ lấy từ ADMIN_EMAILS (env).
 * Giữ hằng rỗng để tương thích logic merge trong adminEmails().
 */
const DEFAULT_ADMIN_EMAILS = [];

// (S4) Cảnh báo rõ ràng nếu production mà không cấu hình admin nào
if (process.env.NODE_ENV === 'production' && !String(process.env.ADMIN_EMAILS || '').trim()) {
  console.warn('[userStore] CẢNH BÁO: ADMIN_EMAILS rỗng ở production — không có tài khoản nào được công nhận là admin.');
}

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

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
 * Mã hóa AES-256-GCM: IV ngẫu nhiên 12 byte + auth tag cho từng bản ghi, prefix `v1:`.
 *
 * LIMITATION đã biết (S1): chưa hỗ trợ xoay khóa (key rotation).
 * Đổi APP_SECRET sẽ làm toàn bộ wpmPasswordEnc đã lưu KHÔNG giải mã được nữa
 * (decryptSecret ném lỗi do sai key/tag) — phải yêu cầu mọi user login lại.
 * TODO: thêm keyVersion vào từng bản ghi + giữ khóa cũ để giải mã dần khi xoay khóa.
 */
export function encryptSecret(plain) {
  const key = crypto.createHash('sha256').update(appSecret()).digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${enc.toString('base64')}`;
}

export function decryptSecret(blob) {
  if (!blob) return '';
  const s = String(blob);
  if (!s.startsWith('v1:')) return s;
  const [, ivB64, tagB64, dataB64] = s.split(':');
  const key = crypto.createHash('sha256').update(appSecret()).digest();
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

function readAll() {
  ensureDataDir();
  if (!fs.existsSync(USERS_FILE)) return { users: [] };
  try {
    return JSON.parse(fs.readFileSync(USERS_FILE, 'utf-8'));
  } catch (e) {
    // (6.3) File hỏng → FAIL LOUD, không im lặng trả rỗng (tránh mất user + chiếm admin)
    const bak = USERS_FILE + '.corrupt-' + Date.now() + '.bak';
    try { fs.copyFileSync(USERS_FILE, bak); } catch {}
    throw new Error(`users.json hỏng (đã backup tại ${bak}): ${e.message}`);
  }
}

function writeAll(data) {
  ensureDataDir();
  // (6.3) Ghi atomic: tmp → rename (tránh file cụt khi crash)
  const tmp = USERS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
  fs.renameSync(tmp, USERS_FILE);
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
  const want = String(username || '').trim().toLowerCase();
  return readAll().users.find((u) => u.username.toLowerCase() === want) || null;
}

export function findUserById(id) {
  return readAll().users.find((u) => u.id === id) || null;
}

/** Danh sách tài khoản cho admin — không trả password. */
export function listUsersPublic() {
  return readAll().users.map((u) => ({
    id: u.id,
    username: u.username,
    role: u.role || 'user',
    createdAt: u.createdAt || '',
    updatedAt: u.updatedAt || '',
    passwordStored: Boolean(u.wpmPasswordEnc),
  }));
}

/**
 * Xóa password đã lưu. Lần login sau nhận pass mới (đúng pass WPM) và lưu lại.
 */
export function resetUserPassword(userId) {
  const data = readAll();
  const user = data.users.find((u) => u.id === userId);
  if (!user) throw new Error('Không tìm thấy tài khoản.');
  user.wpmPasswordEnc = '';
  user.passwordHash = '';
  user.updatedAt = new Date().toISOString();
  writeAll(data);
  return user;
}

export async function createUser({ username, password, role = 'user' }) {
  const name = String(username || '').trim();
  const pass = String(password || '');
  if (!name || !pass) throw new Error('Thiếu username/password.');
  if (findUserByUsername(name)) throw new Error('Username đã tồn tại.');
  const data = readAll();
  const user = {
    id: crypto.randomUUID?.() || `u_${Date.now()}`,
    username: name,
    passwordHash: await bcrypt.hash(pass, 10),
    role,
    wpmUsername: name,
    wpmPasswordEnc: encryptSecret(pass),
    createdAt: new Date().toISOString(),
  };
  data.users.push(user);
  writeAll(data);
  return user;
}

export function setUserWpmCredentials(userId, wpmUsername, wpmPassword) {
  const data = readAll();
  const user = data.users.find((u) => u.id === userId);
  if (!user) throw new Error('User không tồn tại.');
  user.wpmUsername = String(wpmUsername || '').trim();
  user.wpmPasswordEnc = encryptSecret(String(wpmPassword || ''));
  user.updatedAt = new Date().toISOString();
  writeAll(data);
  return user;
}

async function updateLoginPassword(userId, password) {
  const data = readAll();
  const user = data.users.find((u) => u.id === userId);
  if (!user) throw new Error('User không tồn tại.');
  user.passwordHash = await bcrypt.hash(String(password), 10);
  user.updatedAt = new Date().toISOString();
  writeAll(data);
  return user;
}

export function setUserRole(userId, role) {
  const data = readAll();
  const user = data.users.find((u) => u.id === userId);
  if (!user) throw new Error('User không tồn tại.');
  user.role = role;
  user.updatedAt = new Date().toISOString();
  writeAll(data);
  return user;
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
  if (!user) {
    user = await createUser({
      username: name,
      password: pass,
      role: wantAdmin ? 'admin' : 'user',
    });
    return findUserById(user.id);
  }

  // User cũ seed (admin/web) chưa gắn WPM → cho gắn pass mới lần này
  const legacyNoWpm = !user.wpmPasswordEnc;
  if (legacyNoWpm) {
    await updateLoginPassword(user.id, pass);
    setUserWpmCredentials(user.id, name, pass);
    if (wantAdmin) setUserRole(user.id, 'admin');
    else if (user.role === 'admin' && !wantAdmin && name.toLowerCase() !== 'admin') {
      setUserRole(user.id, 'user');
    }
    return findUserById(user.id);
  }

  const ok = await bcrypt.compare(pass, user.passwordHash);
  if (!ok) return null;

  await updateLoginPassword(user.id, pass);
  setUserWpmCredentials(user.id, name, pass);
  if (wantAdmin && user.role !== 'admin') {
    setUserRole(user.id, 'admin');
  }
  return findUserById(user.id);
}

/** Không seed admin/web nữa — user tự tạo khi login WPM. */
export async function ensureKnownUsers() {
  ensureDataDir();
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
