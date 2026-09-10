/**
 * Live view: snapshot hiện tại theo từng dòng Log hoặc CDP screencast.
 * Input HTTP vẫn hỗ trợ (phase sau / screencast).
 */

/** @type {Map<string, {
 *   browser: import('puppeteer').Browser,
 *   page: import('puppeteer').Page|null,
 *   client?: any,
 *   onFrame?: (payload: object) => void,
 *   stop?: () => Promise<void>,
 *   mode?: string,
 *   captureChain?: Promise<void>,
 * }>} */
const sessions = new Map();

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
 * Mỗi lần log → chụp và đẩy ảnh hiện tại ngay khi chụp xong.
 */
export async function startSnapshotLive(sessionId, browser, page, onFrame) {
  await stopLiveSession(sessionId);

  const entry = {
    browser,
    page,
    onFrame,
    mode: 'snapshot',
    captureChain: Promise.resolve(),
    stop: null,
  };
  sessions.set(sessionId, entry);

  // Hiện frame đầu tiên ngay; dùng chung chain để giữ đúng thứ tự với log.
  entry.captureChain = pushSnapshotOnLog(sessionId);
  await entry.captureChain;

  return entry;
}

/**
 * Gọi sau mỗi dòng log: chụp và đẩy ảnh hiện tại lên Live.
 * Không block caller — xếp hàng tuần tự để không loạn thứ tự ảnh.
 */
export function scheduleSnapshotOnLog(sessionId) {
  const cur = sessions.get(sessionId);
  if (!cur || cur.mode !== 'snapshot' || !cur.onFrame) return;
  cur.captureChain = (cur.captureChain || Promise.resolve())
    .then(() => {
      if (sessions.get(sessionId) === cur) return pushSnapshotOnLog(sessionId);
    })
    .catch(() => {});
}

export async function pushSnapshotOnLog(sessionId) {
  const cur = sessions.get(sessionId);
  if (!cur || cur.mode !== 'snapshot' || !cur.onFrame) return;

  const page = cur.page;
  if (!page || page.isClosed?.()) return;
  try {
    const buf = await page.screenshot({
      type: 'jpeg',
      quality: snapshotQuality(),
      encoding: 'base64',
      captureBeyondViewport: false,
    });
    // Session có thể đã đóng/đổi tab trong lúc screenshot đang chạy.
    if (sessions.get(sessionId) !== cur) return;
    cur.onFrame({
      sessionId,
      image: typeof buf === 'string' ? buf : Buffer.from(buf).toString('base64'),
      meta: {
        mode: 'snapshot',
        quality: snapshotQuality(),
        timestamp: Date.now(),
      },
    });
  } catch {
    /* Page đang chuyển trang — đợi lần chụp sau, không phát lại ảnh cũ. */
  }
}

/**
 * CDP screencast — phát mỗi frame Chrome gửi, theo độ phân giải của viewport.
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
    if (sessions.get(sessionId) !== entry) return;
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

  entry.stop = async () => {
    try {
      client.off('Page.screencastFrame', onScreencastFrame);
      await client.send('Page.stopScreencast').catch(() => {});
    } catch {
      /* ignore */
    }
    await client.detach?.().catch(() => {});
  };

  try {
    await client.send('Page.startScreencast', {
      format: 'jpeg',
      quality: 45,
      everyNthFrame: 1,
    });
  } catch (err) {
    if (sessions.get(sessionId) === entry) sessions.delete(sessionId);
    await entry.stop();
    throw err;
  }

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
  await startLiveSession(sessionId, cur.browser, page, frameCb);
}

export async function stopLiveSession(sessionId) {
  const cur = sessions.get(sessionId);
  if (!cur) return;
  sessions.delete(sessionId);
  if (cur.stop) await cur.stop().catch(() => {});
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
