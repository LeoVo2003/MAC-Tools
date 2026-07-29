/**
 * Live view: snapshot (JPEG định kỳ) hoặc CDP screencast — không cần noVNC/x11vnc.
 * Input HTTP vẫn hỗ trợ (phase sau / screencast).
 */

/** @type {Map<string, {
 *   browser: import('puppeteer').Browser,
 *   page: import('puppeteer').Page|null,
 *   client?: any,
 *   onFrame?: (payload: object) => void,
 *   stop?: () => Promise<void>,
 *   mode?: string,
 * }>} */
const sessions = new Map();

let lastFrameAt = 0;
const MIN_FRAME_MS = 250; // CDP screencast throttle

export function getLiveMode() {
  const m = (process.env.CHROME_LIVE_MODE || 'snapshot').toLowerCase();
  if (m === 'novnc' || m === 'screencast' || m === 'snapshot') return m;
  return 'snapshot';
}

export function isFrameLiveMode() {
  const m = getLiveMode();
  return m === 'snapshot' || m === 'screencast';
}

function snapshotIntervalMs() {
  const n = Number(process.env.LIVE_SNAPSHOT_MS);
  return Number.isFinite(n) && n >= 400 ? Math.round(n) : 1500;
}

function snapshotQuality() {
  const n = Number(process.env.LIVE_SNAPSHOT_QUALITY);
  return Number.isFinite(n) && n >= 20 && n <= 90 ? Math.round(n) : 50;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Snapshot loop: page.screenshot JPEG mỗi LIVE_SNAPSHOT_MS.
 * @param {string} sessionId
 * @param {import('puppeteer').Browser} browser
 * @param {import('puppeteer').Page} page
 * @param {(payload: object) => void} onFrame
 */
export async function startSnapshotLive(sessionId, browser, page, onFrame) {
  await stopLiveSession(sessionId);

  const intervalMs = snapshotIntervalMs();
  const quality = snapshotQuality();
  let stopped = false;
  let timer = null;
  let inFlight = false;

  const entry = {
    browser,
    page,
    onFrame,
    mode: 'snapshot',
    stop: null,
  };
  sessions.set(sessionId, entry);

  const tick = async () => {
    if (stopped || inFlight) return;
    const cur = sessions.get(sessionId);
    if (!cur || cur.page !== page) return;
    if (!page || page.isClosed?.()) return;

    inFlight = true;
    try {
      const buf = await page.screenshot({
        type: 'jpeg',
        quality,
        encoding: 'base64',
        captureBeyondViewport: false,
      });
      if (stopped) return;
      const image = typeof buf === 'string' ? buf : Buffer.from(buf).toString('base64');
      onFrame({
        sessionId,
        image,
        meta: {
          mode: 'snapshot',
          intervalMs,
          quality,
          timestamp: Date.now(),
        },
      });
    } catch {
      /* page navigating / closed — bỏ frame */
    } finally {
      inFlight = false;
    }
  };

  // Frame đầu ngay lập tức
  await tick();

  const loop = async () => {
    while (!stopped && sessions.get(sessionId)?.page === page) {
      await sleep(intervalMs);
      if (stopped) break;
      await tick();
    }
  };

  loop().catch(() => {});

  entry.stop = async () => {
    stopped = true;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };

  return entry;
}

/**
 * CDP screencast (~4fps) — mode=screencast.
 */
export async function startScreencastLive(sessionId, browser, page, onFrame) {
  await stopLiveSession(sessionId);

  const client = await page.createCDPSession();
  const entry = { browser, page, client, onFrame, mode: 'screencast', stop: null };
  sessions.set(sessionId, entry);

  const onScreencastFrame = async (evt) => {
    try {
      await client.send('Page.screencastFrameAck', { sessionId: evt.sessionId });
    } catch {
      /* ignore */
    }
    const now = Date.now();
    if (now - lastFrameAt < MIN_FRAME_MS) return;
    lastFrameAt = now;
    onFrame({
      sessionId,
      image: evt.data,
      meta: {
        mode: 'screencast',
        deviceWidth: evt.metadata?.deviceWidth,
        deviceHeight: evt.metadata?.deviceHeight,
        offsetTop: evt.metadata?.offsetTop,
        scrollOffsetX: evt.metadata?.scrollOffsetX,
        scrollOffsetY: evt.metadata?.scrollOffsetY,
        timestamp: evt.metadata?.timestamp,
      },
    });
  };

  client.on('Page.screencastFrame', onScreencastFrame);

  await client.send('Page.startScreencast', {
    format: 'jpeg',
    quality: 45,
    maxWidth: 1280,
    maxHeight: 800,
    everyNthFrame: 2,
  });

  entry.stop = async () => {
    try {
      client.off('Page.screencastFrame', onScreencastFrame);
      await client.send('Page.stopScreencast').catch(() => {});
    } catch {
      /* ignore */
    }
  };

  return entry;
}

/**
 * Start live theo CHROME_LIVE_MODE (snapshot | screencast).
 * novnc không dùng hàm này.
 */
export async function startLiveSession(sessionId, browser, page, onFrame) {
  const mode = getLiveMode();
  if (mode === 'snapshot') {
    return startSnapshotLive(sessionId, browser, page, onFrame);
  }
  if (mode === 'screencast') {
    return startScreencastLive(sessionId, browser, page, onFrame);
  }
  // novnc: không stream qua socket
  return null;
}

/** Đổi tab đang stream (vd WPM → WP). */
export async function setLivePage(sessionId, page, onFrame) {
  const cur = sessions.get(sessionId);
  if (!cur?.browser) return;
  const frameCb = onFrame || cur.onFrame;
  if (!frameCb) return;
  if (cur.stop) await cur.stop().catch(() => {});
  await startLiveSession(sessionId, cur.browser, page, frameCb);
}

export async function stopLiveSession(sessionId) {
  const cur = sessions.get(sessionId);
  if (!cur) return;
  if (cur.stop) await cur.stop().catch(() => {});
  sessions.delete(sessionId);
}

export function getLiveSession(sessionId) {
  return sessions.get(sessionId) || null;
}

export function listLiveSessions() {
  return [...sessions.keys()];
}

/**
 * @param {string} sessionId
 * @param {{ type: string, x?: number, y?: number, button?: string, key?: string, text?: string, modifiers?: number }} ev
 */
export async function dispatchLiveInput(sessionId, ev) {
  const cur = sessions.get(sessionId);
  if (!cur?.page || cur.page.isClosed?.()) {
    throw new Error('Không có session Live / page đã đóng.');
  }
  const page = cur.page;
  const type = String(ev.type || '');

  if (type === 'click') {
    const x = Number(ev.x);
    const y = Number(ev.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('Thiếu toạ độ click.');
    await page.mouse.click(x, y, { button: ev.button === 'right' ? 'right' : 'left', delay: 20 });
    return;
  }
  if (type === 'dblclick') {
    await page.mouse.click(Number(ev.x), Number(ev.y), { clickCount: 2, delay: 20 });
    return;
  }
  if (type === 'move') {
    await page.mouse.move(Number(ev.x), Number(ev.y));
    return;
  }
  if (type === 'down') {
    await page.mouse.down({ button: ev.button === 'right' ? 'right' : 'left' });
    return;
  }
  if (type === 'up') {
    await page.mouse.up({ button: ev.button === 'right' ? 'right' : 'left' });
    return;
  }
  if (type === 'wheel') {
    await page.mouse.wheel({ deltaX: Number(ev.deltaX) || 0, deltaY: Number(ev.deltaY) || 0 });
    return;
  }
  if (type === 'keydown') {
    await page.keyboard.down(String(ev.key || ''));
    return;
  }
  if (type === 'keyup') {
    await page.keyboard.up(String(ev.key || ''));
    return;
  }
  if (type === 'type') {
    await page.keyboard.type(String(ev.text || ''), { delay: 15 });
    return;
  }
  if (type === 'press') {
    await page.keyboard.press(String(ev.key || 'Enter'));
    return;
  }
  throw new Error(`Loại input không hỗ trợ: ${type}`);
}
