/**
 * Chrome giữ mở cho Live (CHROME_LIVE) — theo dõi theo user để clear trước Fill/Run mới.
 * Resume: tái sử dụng browser (không clear).
 */
/** @type {Map<string, Set<import('puppeteer').Browser>>} */
const byUser = new Map();

function key(userId) {
  return String(userId || '').trim() || '_anon';
}

export function registerLiveBrowser(userId, browser) {
  if (!browser) return;
  const k = key(userId);
  let set = byUser.get(k);
  if (!set) {
    set = new Set();
    byUser.set(k, set);
  }
  set.add(browser);
}

export function unregisterLiveBrowser(userId, browser) {
  const set = byUser.get(key(userId));
  if (!set || !browser) return;
  set.delete(browser);
  if (!set.size) byUser.delete(key(userId));
}

/** Lấy 1 browser đang giữ (bỏ khỏi registry) — dùng cho Resume. */
export function takeLiveBrowser(userId) {
  const k = key(userId);
  const set = byUser.get(k);
  if (!set || !set.size) return null;
  const browser = set.values().next().value;
  set.delete(browser);
  if (!set.size) byUser.delete(k);
  try {
    if (browser?.isConnected?.() === false) return null;
  } catch {
    return null;
  }
  return browser || null;
}

/**
 * Đóng mọi Chrome Live đang giữ của user (sau Fill/Run xong).
 * Không đụng job đang running — caller skip khi Resume.
 */
export async function clearLiveBrowsersForUser(userId) {
  const k = key(userId);
  const set = byUser.get(k);
  byUser.delete(k);
  let closed = 0;
  if (set) {
    for (const browser of set) {
      try {
        if (browser.isConnected?.() === false) continue;
        await browser.close();
        closed += 1;
      } catch {
        /* ignore */
      }
    }
  }
  return { closed };
}
