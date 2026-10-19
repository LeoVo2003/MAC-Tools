import session from 'express-session';
import FileStoreFactory from 'session-file-store';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { findUserById, toPublicUser } from './userStore.js';

/** (B1) FileStore thay MemoryStore — session sống sót sau restart/deploy */
const FileStore = FileStoreFactory(session);
const SESSIONS_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'data',
  'sessions'
);
try {
  fs.mkdirSync(SESSIONS_PATH, { recursive: true });
} catch {
  /* bỏ qua — FileStore tự tạo nếu chưa có */
}

// Singleton store — dùng chung cho middleware và WebSocket upgrade verify (S6)
const sessionStore = new FileStore({
  path: SESSIONS_PATH,
  ttl: 86400,
  reapInterval: 3600,
  logFn: () => {},
});

/** (S6) Verify session ID từ cookie cho WebSocket upgrade — check thật trong store */
export function verifySessionId(sid) {
  return new Promise((resolve) => {
    if (!sid) return resolve(null);
    sessionStore.get(sid, (err, sess) => {
      if (err || !sess || !sess.userId) return resolve(null);
      const user = findUserById(sess.userId);
      resolve(user ? { userId: sess.userId, user } : null);
    });
  });
}

/** Parse + unsign cookie fugt.sid → session ID thật */
export function getSessionIdFromCookie(cookieHeader) {
  if (!cookieHeader) return null;
  const match = cookieHeader.match(/(?:^|;\s*)fugt\.sid=([^;]+)/);
  if (!match) return null;
  const signed = decodeURIComponent(match[1]);
  // express-session dùng cookie-signature: sid = value.signature
  // unsign bằng cách thử với secret
  const secret = getSessionSecret();
  // Đơn giản: FileStore lưu file theo sid đã unsign. Thử unsign.
  try {
    const idx = signed.lastIndexOf('.');
    if (idx === -1) return signed; // không có signature
    const val = signed.slice(0, idx);
    const sig = signed.slice(idx + 1);
    const expected = crypto
      .createHmac('sha256', secret)
      .update(val)
      .digest('base64')
      .replace(/=+$/, '');
    if (sig === expected) return val;
    return null;
  } catch {
    return null;
  }
}

/** (6.2) Chặn secret mặc định ở production */
function getSessionSecret() {
  const secret = process.env.SESSION_SECRET || process.env.APP_SECRET || 'dev-change-me-session';
  if (process.env.NODE_ENV === 'production') {
    if (!process.env.SESSION_SECRET && !process.env.APP_SECRET) {
      console.error('FATAL: SESSION_SECRET/APP_SECRET chưa set ở production. Từ chối khởi động.');
      process.exit(1);
    }
    if (/change-me/i.test(secret) || secret.length < 32) {
      console.error('FATAL: SESSION_SECRET quá yếu (chứa "change-me" hoặc < 32 ký tự). Từ chối khởi động.');
      process.exit(1);
    }
  }
  return secret;
}

export function sessionMiddleware() {
  const secret = getSessionSecret();
  // COOKIE_SECURE=true → luôn Secure (chỉ HTTPS)
  // COOKIE_SECURE=false → luôn không Secure (HTTP)
  // không set / auto → theo X-Forwarded-Proto (trust proxy) — tránh mất login khi nginx chỉ HTTP
  const raw = String(process.env.COOKIE_SECURE || 'auto').toLowerCase();
  const secure =
    raw === 'true' || raw === '1' ? true : raw === 'false' || raw === '0' ? false : 'auto';

  return session({
    name: 'fugt.sid',
    secret,
    resave: false,
    saveUninitialized: false,
    // (B1) FileStore singleton: session bền vững qua restart/deploy, TTL 24h
    store: sessionStore,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure,
      maxAge: 7 * 24 * 60 * 60 * 1000,
    },
  });
}

export function requireAuth(req, res, next) {
  if (!req.session?.userId) {
    return res.status(401).json({ error: 'Chưa đăng nhập.' });
  }
  const user = findUserById(req.session.userId);
  if (!user) {
    req.session.destroy(() => {});
    return res.status(401).json({ error: 'Session hết hạn. Đăng nhập lại.' });
  }
  req.user = user;
  next();
}

export function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Chỉ admin.' });
  }
  next();
}

export function currentPublicUser(req) {
  if (!req.session?.userId) return null;
  const user = findUserById(req.session.userId);
  return toPublicUser(user);
}
