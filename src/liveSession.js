/**
 * Live view: snapshot theo từng dòng Log (hiện ảnh log trước) hoặc CDP screencast.
 * Input HTTP vẫn hỗ trợ (phase sau / screencast).
 */

/** @type {Map<string, {
 *   browser: import('puppeteer').Browser,
 *   page: import('puppeteer').Page|null,
 *   client?: any,
 *   onFrame?: (payload: object) => void,
 *   stop?: () => Promise<void>,
 *   mode?: string,
 *   pendingImage?: string|null,
 *   captureChain?: Promise<void>,
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

function snapshotQuality() {
  const n = Number(process.env.LIVE_SNAPSHOT_QUALITY);
  return Number.isFinite(n) && n >= 20 && n <= 90 ? Math.round(n) : 50;
}

/**
 * Đăng ký session snapshot — không poll theo giây.
 * Mỗi lần log → pushSnapshotOnLog: hiện ảnh log trước, chụp ảnh mới để lần sau.
 */
export async function startSnapshotLive(sessionId, browser, page, onFrame) {
  await stopLiveSession(sessionId);

  const entry = {
    browser,
    page,
    onFrame,
    mode: 'snapshot',
    pendingImage: null,
    captureChain: Promise.resolve(),
    stop: null,
  };
  sessions.set(sessionId, entry);

  // Chụp sẵn 1 frame nền (chưa đẩy UI) — log đầu tiên sẽ hiện frame này
  try {
    if (page && !page.isClosed?.()) {
      const buf = await page.screenshot({
        type: 'jpeg',
        quality: snapshotQuality(),
        encoding: 'base64',
        captureBeyondViewport: false,
      });
      entry.pendingImage =
        typeof buf === 'string' ? buf : Buffer.from(buf).toString('base64');
    }
  } catch {
    /* ignore */
  }

  entry.stop = async () => {
    entry.pendingImage = null;
  };

  return entry;
}

/**
 * Gọi sau mỗi dòng log: đẩy ảnh pending (log trước) lên Live, rồi chụp mới.
 * Không block caller — xếp hàng tuần tự để không loạn thứ tự ảnh.
 */
export function scheduleSnapshotOnLog(sessionId) {
  const cur = sessions.get(sessionId);
  if (!cur || cur.mode !== 'snapshot' || !cur.onFrame) return;
  cur.captureChain = (cur.captureChain || Promise.resolve())
    .then(() => pushSnapshotOnLog(sessionId))
    .catch(() => {});
}

export async function pushSnapshotOnLog(sessionId) {
  const cur = sessions.get(sessionId);
  if (!cur || cur.mode !== 'snapshot' || !cur.onFrame) return;

  // 1) Hiện ảnh của log trước (nếu có)
  if (cur.pendingImage) {
    try {
      cur.onFrame({
        sessionId,
        image: cur.pendingImage,
        meta: {
          mode: 'snapshot',
          lag: 'prev-log',
          quality: snapshotQuality(),
          timestamp: Date.now(),
        },
      });
    } catch {
      /* ignore */
    }
  }

  // 2) Chụp ảnh mới → pending cho log kế
  const page = cur.page;
  if (!page || page.isClosed?.()) {
    cur.pendingImage = null;
    return;
  }
  try {
    const buf = await page.screenshot({
      type: 'jpeg',
      quality: snapshotQuality(),
      encoding: 'base64',
      captureBeyondViewport: false,
    });
    cur.pendingImage =
      typeof buf === 'string' ? buf : Buffer.from(buf).toString('base64');
  } catch {
    /* page navigating — giữ pending cũ */
  }
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
