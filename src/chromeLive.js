/**
 * Live Chrome (noVNC) — static + WebSocket khi CHROME_LIVE=true.
 * Path: /chrome-live/  (cần đăng nhập)
 */
import fs from 'fs';
import net from 'net';
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

function probePort(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host }, () => {
      sock.end();
      resolve(true);
    });
    sock.on('error', () => resolve(false));
    sock.setTimeout(800, () => {
      sock.destroy();
      resolve(false);
    });
  });
}

/** noVNC path query — KHÔNG encode slash (%2F làm hỏng kết nối). */
export function buildVncIframeSrc() {
  return (
    '/chrome-live/vnc.html?autoconnect=1&reconnect=1&resize=scale&path=chrome-live/websockify'
  );
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

  app.get('/api/chrome-live', requireAuth, async (_req, res) => {
    const websockifyOk = await probePort(6080);
    const vncOk = await probePort(5900);
    const mode = (process.env.CHROME_LIVE_MODE || 'novnc').toLowerCase();
    if (mode === 'screencast') {
      return res.json({
        enabled: true,
        mode: 'screencast',
        iframeSrc: null,
        hint: 'Live = stream ảnh Chrome (SSE). Bấm Fill/Run rồi click/gõ trên ảnh.',
        backend: { websockify: websockifyOk, vnc: vncOk, screencast: true },
      });
    }
    res.json({
      enabled: true,
      mode: 'novnc',
      iframeSrc: buildVncIframeSrc(),
      hint:
        'Live = noVNC (remote desktop). Mở Live để xem + click/gõ. Fill/Run để Chrome hiện trên màn hình.',
      backend: { websockify: websockifyOk, vnc: vncOk, screencast: false },
    });
  });

  app.get(['/chrome-live', '/chrome-live/'], requireAuthPage, (_req, res) => {
    res.redirect(302, buildVncIframeSrc());
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
    try {
      const raw = req.url || '';
      if (!raw.includes('chrome-live')) return;

      const pathname = raw.split('?')[0] || '';
      if (!pathname.startsWith('/chrome-live')) return;

      const cookie = req.headers.cookie || '';
      if (!cookie.includes('fugt.sid')) {
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }

      // websockify listen root /
      if (pathname.includes('websockify')) {
        const q = raw.includes('?') ? raw.slice(raw.indexOf('?')) : '';
        req.url = `/${q}`;
      } else {
        req.url = raw.replace(/^\/chrome-live/, '') || '/';
      }

      console.log(`[chrome-live] WS upgrade → ${req.url}`);
      liveProxy.ws(req, socket, head);
    } catch (err) {
      console.warn('[chrome-live] upgrade error:', err?.message || err);
      try {
        socket.destroy();
      } catch {
        /* ignore */
      }
    }
  });

  console.log('[chrome-live] WebSocket proxy: /chrome-live/websockify → :6080');
}
