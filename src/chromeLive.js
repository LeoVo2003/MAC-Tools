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

function allowEmbed(res) {
  try {
    res.removeHeader('X-Frame-Options');
  } catch {
    /* ignore */
  }
  // Cho phép nhúng iframe same-origin (panel Live trong tool)
  res.setHeader('Content-Security-Policy', "frame-ancestors 'self'");
}

function requireAuthPage(req, res, next) {
  if (!req.session?.userId) {
    allowEmbed(res);
    return res
      .status(401)
      .type('html')
      .send(
        '<!doctype html><meta charset="utf-8"><title>Login</title>' +
          '<p>Chưa đăng nhập tool. <a href="/" target="_parent">Về trang chủ</a>.</p>'
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

/**
 * path=websockify (tương đối) — cùng cách tab /chrome-live đang chạy ngon.
 * KHÔNG dùng path tuyệt đối / encode %2F (dễ lệch URL WebSocket trong iframe).
 */
export function buildVncIframeSrc() {
  const q = [
    'autoconnect=true',
    'reconnect=true',
    'reconnect_delay=2000',
    'resize=scale',
    'path=websockify',
  ].join('&');
  return `/chrome-live/vnc.html?${q}`;
}

/** Embed nhẹ — RFB nối thẳng WS, tránh UI noVNC kẹt 「连接中」 trong iframe. */
function embedHtml() {
  return `<!DOCTYPE html>
<html lang="vi">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Live Chrome</title>
<style>
  html,body{margin:0;width:100%;height:100%;background:#0b0f14;overflow:hidden;font-family:system-ui,sans-serif}
  #screen{position:fixed;inset:0;display:flex;align-items:center;justify-content:center}
  #screen canvas{outline:none}
  #msg{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;
       color:#c8d0d8;font-size:14px;z-index:2;pointer-events:none;text-align:center;padding:1rem}
</style>
</head>
<body>
<div id="msg">Đang kết nối Live…</div>
<div id="screen"></div>
<script type="module">
const msg = document.getElementById('msg');
const screen = document.getElementById('screen');
const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
const wsUrl = proto + '//' + location.host + '/chrome-live/websockify';

function show(t){ msg.style.display='flex'; msg.textContent=t; }
function hide(){ msg.style.display='none'; }

async function tryRfb(){
  const candidates = ['/chrome-live/core/rfb.js','/chrome-live/app/core/rfb.js'];
  let RFB=null;
  for (const p of candidates){
    try { RFB = (await import(p)).default; break; } catch { /* next */ }
  }
  if (!RFB) throw new Error('no rfb');
  show('Đang kết nối VNC…');
  const rfb = new RFB(screen, wsUrl);
  // Scale full khung iframe — không clip (tránh màn hình nhỏ giữa panel)
  rfb.scaleViewport = true;
  rfb.clipViewport = false;
  rfb.resizeSession = false;
  rfb.background = '#0b0f14';
  const fit = () => { try { rfb.scaleViewport = true; } catch { /* ignore */ } };
  window.addEventListener('resize', fit);
  rfb.addEventListener('connect', () => { hide(); fit(); });
  rfb.addEventListener('disconnect', (ev) => {
    show(ev.detail?.clean ? 'Đã ngắt — thử lại…' : 'Mất kết nối — thử lại…');
    setTimeout(() => location.reload(), 2000);
  });
  rfb.addEventListener('credentialsrequired', () => {
    try { rfb.sendCredentials({ password: '' }); } catch { /* ignore */ }
  });
}

tryRfb().catch(() => {
  location.replace('/chrome-live/vnc.html?autoconnect=true&reconnect=true&reconnect_delay=2000&resize=scale&path=websockify');
});
</script>
</body>
</html>`;
}

function sameOriginUpgrade(req) {
  const host = req.headers.host || '';
  const origin = req.headers.origin || '';
  if (!host || !origin) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
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
    xfwd: true,
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

  app.use('/chrome-live', (req, res, next) => {
    allowEmbed(res);
    next();
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
      iframeSrc: '/chrome-live/embed',
      hint: websockifyOk && vncOk
        ? 'Live chiếm ~72% màn hình. Fill/Run rồi click/gõ trên Live.'
        : `Live backend chưa sẵn sàng (websockify=${websockifyOk}, vnc=${vncOk}). Restart container.`,
      backend: { websockify: websockifyOk, vnc: vncOk, screencast: false },
    });
  });

  app.get('/chrome-live/embed', requireAuthPage, (_req, res) => {
    allowEmbed(res);
    res.type('html').send(embedHtml());
  });

  app.get(['/chrome-live', '/chrome-live/'], requireAuthPage, (_req, res) => {
    allowEmbed(res);
    res.redirect(302, buildVncIframeSrc());
  });

  if (novncRoot) {
    app.use(
      '/chrome-live',
      requireAuthPage,
      express.static(novncRoot, {
        index: false,
        setHeaders(res) {
          allowEmbed(res);
        },
      })
    );
  }

  return { enabled: true, novncRoot, wsTarget };
}

/** WebSocket upgrade — gọi sau app.listen(server). */
export function attachChromeLiveWs(server) {
  if (!chromeLiveEnabled() || !liveProxy) return;

  server.on('upgrade', (req, socket, head) => {
    try {
      const raw = req.url || '';
      const pathname = (raw.split('?')[0] || '').replace(/\/+$/, '') || '/';
      if (!pathname.startsWith('/chrome-live')) return;

      const cookie = req.headers.cookie || '';
      const ok = cookie.includes('fugt.sid') || sameOriginUpgrade(req);
      if (!ok) {
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }

      if (pathname.includes('websockify')) {
        const q = raw.includes('?') ? raw.slice(raw.indexOf('?')) : '';
        req.url = `/${q}`;
      } else {
        req.url = raw.replace(/^\/chrome-live/, '') || '/';
      }

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
