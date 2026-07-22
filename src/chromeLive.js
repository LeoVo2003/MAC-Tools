/**
 * Live Chrome (noVNC) — static + WebSocket khi CHROME_LIVE=true.
 * Path: /chrome-live/  (cần đăng nhập)
 */
import fs from 'fs';
import path from 'path';
import express from 'express';
import httpProxy from 'http-proxy';
import { requireAuth } from './auth.js';

const NOVNC_CANDIDATES = [
  process.env.NOVNC_PATH,
  '/usr/share/novnc',
].filter(Boolean);

let liveProxy = null;

export function chromeLiveEnabled() {
  return process.env.CHROME_LIVE === 'true';
}

function resolveNovncRoot() {
  for (const p of NOVNC_CANDIDATES) {
    try {
      if (p && fs.existsSync(path.join(p, 'vnc.html'))) return p;
    } catch {
      /* skip */
    }
  }
  return null;
}

function requireAuthPage(req, res, next) {
  if (!req.session?.userId) {
    return res
      .status(401)
      .type('html')
      .send(
        '<!doctype html><meta charset="utf-8"><title>Login</title>' +
          '<p>Chưa đăng nhập tool. <a href="/">Về trang chủ</a>.</p>'
      );
  }
  requireAuth(req, res, next);
}

/** HTTP routes — gọi trong createApp() trước express.static. */
export function mountChromeLiveRoutes(app) {
  if (!chromeLiveEnabled()) return { enabled: false };

  const novncRoot = resolveNovncRoot();
  if (!novncRoot) {
    console.warn('[chrome-live] Không tìm thấy noVNC (/usr/share/novnc).');
  } else {
    console.log(`[chrome-live] noVNC: ${novncRoot}`);
  }

  const wsTarget = process.env.CHROME_LIVE_WS || 'http://127.0.0.1:6080';
  liveProxy = httpProxy.createProxyServer({
    target: wsTarget,
    ws: true,
    changeOrigin: true,
  });
  liveProxy.on('error', (err, _req, res) => {
    console.warn('[chrome-live] proxy:', err?.message || err);
    if (res && !res.headersSent && typeof res.writeHead === 'function') {
      try {
        res.writeHead(502);
        res.end('Chrome live proxy error');
      } catch {
        /* ignore */
      }
    }
  });

  app.get('/api/chrome-live', requireAuth, (_req, res) => {
    res.json({
      enabled: true,
      iframeSrc:
        '/chrome-live/vnc.html?autoconnect=true&resize=scale&reconnect=true&path=' +
        encodeURIComponent('chrome-live/websockify'),
    });
  });

  const vncRedirect =
    '/chrome-live/vnc.html?autoconnect=true&resize=scale&reconnect=true&path=' +
    encodeURIComponent('chrome-live/websockify');

  app.get(['/chrome-live', '/chrome-live/'], requireAuthPage, (_req, res) => {
    res.redirect(302, vncRedirect);
  });

  if (novncRoot) {
    app.use('/chrome-live', requireAuthPage, express.static(novncRoot, { index: false }));
  }

  return { enabled: true, novncRoot, wsTarget };
}

/** WebSocket upgrade — gọi sau app.listen(server). */
export function attachChromeLiveWs(server) {
  if (!chromeLiveEnabled() || !liveProxy) return;

  server.on('upgrade', (req, socket, head) => {
    const url = req.url || '';
    if (!url.startsWith('/chrome-live')) return;

    const cookie = req.headers.cookie || '';
    if (!cookie.includes('fugt.sid')) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    if (url.includes('/websockify')) {
      req.url = '/';
    } else {
      req.url = url.replace(/^\/chrome-live/, '') || '/';
    }
    liveProxy.ws(req, socket, head);
  });

  console.log('[chrome-live] WebSocket proxy gắn vào /chrome-live/websockify');
}
