import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { getAppRoot } from './envStore.js';

const DATA_DIR = path.join(getAppRoot(), 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function appSecret() {
  return process.env.APP_SECRET || process.env.SESSION_SECRET || 'dev-change-me-app-secret';
}

/** Mã hóa nhẹ WPM password at-rest (AES-256-GCM + APP_SECRET). */
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
  if (!s.startsWith('v1:')) return s; // legacy plain (migrate on save)
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
  } catch {
    return { users: [] };
  }
}

function writeAll(data) {
  ensureDataDir();
  fs.writeFileSync(USERS_FILE, JSON.stringify(data, null, 2), 'utf-8');
}

export function listUsersPublic() {
  return readAll().users.map((u) => ({
    id: u.id,
    username: u.username,
    hasWpm: Boolean(u.wpmUsername && u.wpmPasswordEnc),
    createdAt: u.createdAt,
  }));
}

export function findUserByUsername(username) {
  const want = String(username || '').trim().toLowerCase();
  return readAll().users.find((u) => u.username.toLowerCase() === want) || null;
}

export function findUserById(id) {
  return readAll().users.find((u) => u.id === id) || null;
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
    wpmUsername: '',
    wpmPasswordEnc: '',
    createdAt: new Date().toISOString(),
  };
  data.users.push(user);
  writeAll(data);
  return user;
}

export async function verifyUser(username, password) {
  const user = findUserByUsername(username);
  if (!user) return null;
  const ok = await bcrypt.compare(String(password || ''), user.passwordHash);
  return ok ? user : null;
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

export function getUserWpmCredentials(userId) {
  const user = findUserById(userId);
  if (!user) return { username: '', password: '', configured: false };
  const username = user.wpmUsername || '';
  const password = user.wpmPasswordEnc ? decryptSecret(user.wpmPasswordEnc) : '';
  const configured = Boolean(username && password && !username.includes('your_wpm'));
  return { username, password, configured };
}

/** Seed admin từ ADMIN_USER / ADMIN_PASS nếu chưa có user nào. */
export async function ensureAdminSeed() {
  const data = readAll();
  if (data.users.length > 0) return null;
  const adminUser = String(process.env.ADMIN_USER || 'admin').trim();
  const adminPass = String(process.env.ADMIN_PASS || 'admin123');
  const user = await createUser({
    username: adminUser,
    password: adminPass,
    role: 'admin',
  });
  console.log(`Seed admin user: "${adminUser}" (đổi ADMIN_PASS trên production).`);
  return user;
}

/** Tạo user nếu chưa có (không ghi đè password khi đã tồn tại). */
export async function ensureUserIfMissing({ username, password, role = 'user' }) {
  const name = String(username || '').trim();
  if (!name) return null;
  if (findUserByUsername(name)) return null;
  const user = await createUser({ username: name, password, role });
  console.log(`Seed user: "${name}" (role=${role})`);
  return user;
}

/** Seed admin + acc team `web` nếu chưa có. */
export async function ensureKnownUsers() {
  await ensureUserIfMissing({
    username: process.env.ADMIN_USER || 'admin',
    password: process.env.ADMIN_PASS || 'admin123',
    role: 'admin',
  });
  await ensureUserIfMissing({
    username: process.env.WEB_USER || 'web',
    password: process.env.WEB_PASS || 'web@123',
    role: 'user',
  });
}

/** Public view (không lộ hash / secret). */
export function toPublicUser(user) {
  if (!user) return null;
  const wpm = getUserWpmCredentials(user.id);
  return {
    id: user.id,
    username: user.username,
    role: user.role || 'user',
    wpmConfigured: wpm.configured,
    wpmUsername: wpm.configured ? wpm.username : '',
  };
}
