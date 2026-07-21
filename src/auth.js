import session from 'express-session';
import { findUserById, toPublicUser } from './userStore.js';

export function sessionMiddleware() {
  const secret = process.env.SESSION_SECRET || process.env.APP_SECRET || 'dev-change-me-session';
  const isProd = process.env.NODE_ENV === 'production';
  return session({
    name: 'fugt.sid',
    secret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: isProd && process.env.COOKIE_SECURE === 'true',
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
    return res.status(403).json({ error: 'Chỉ admin mới xem được báo cáo.' });
  }
  next();
}

export function optionalAuth(req, _res, next) {
  if (req.session?.userId) {
    req.user = findUserById(req.session.userId) || null;
  }
  next();
}

export function currentPublicUser(req) {
  if (!req.session?.userId) return null;
  const user = findUserById(req.session.userId);
  return toPublicUser(user);
}
