import session from 'express-session';
import { findUserById, toPublicUser } from './userStore.js';

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
