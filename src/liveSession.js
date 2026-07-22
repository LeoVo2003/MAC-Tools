/**
 * Live view qua CDP screencast (SSE) + input HTTP — không cần WebSocket/noVNC.
 */
/** @type {Map<string, { browser: import('puppeteer').Browser, page: import('puppeteer').Page|null, client: any, stop?: () => Promise<void> }>} */
const sessions = new Map();

let lastFrameAt = 0;
const MIN_FRAME_MS = 250; // ~4 fps

/**
 * @param {string} sessionId
 * @param {import('puppeteer').Browser} browser
 * @param {import('puppeteer').Page} page
 * @param {(payload: object) => void} onFrame
 */
export async function startLiveSession(sessionId, browser, page, onFrame) {
  await stopLiveSession(sessionId);

  const client = await page.createCDPSession();
  const entry = { browser, page, client, stop: null };
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

/** Đổi tab đang stream (vd WPM → WP). */
export async function setLivePage(sessionId, page, onFrame) {
  const cur = sessions.get(sessionId);
  if (!cur?.browser) return;
  if (cur.stop) await cur.stop().catch(() => {});
  await startLiveSession(sessionId, cur.browser, page, onFrame);
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
