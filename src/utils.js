import fs from 'fs';
import path from 'path';
import os from 'os';
import { getAppRoot } from './envStore.js';

export const ROOT = getAppRoot();
export const ERRORS_DIR = path.join(ROOT, 'errors');

/** Ưu tiên Downloads của Windows; override bằng DOWNLOAD_DIR trong .env */
export const DOWNLOADS_DIR = process.env.DOWNLOAD_DIR
  ? path.resolve(process.env.DOWNLOAD_DIR)
  : path.join(os.homedir(), 'Downloads', 'F User Guide Tool');

export function ensureDirs() {
  for (const dir of [DOWNLOADS_DIR, ERRORS_DIR]) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }
}

/** turbo | fast (mặc định) | normal | slow — chỉnh bằng SPEED trong .env */
function speedFactor() {
  const s = (process.env.SPEED || 'fast').toLowerCase();
  if (s === 'slow') return 1;
  if (s === 'normal') return 0.55;
  if (s === 'turbo') return 0.12;
  return 0.22; // fast — nhanh hơn trước (0.28)
}

export function sleep(ms) {
  const floor = (process.env.SPEED || '').toLowerCase() === 'turbo' ? 12 : 25;
  const scaled = Math.max(floor, Math.round(ms * speedFactor()));
  return new Promise((r) => setTimeout(r, scaled));
}

/**
 * Chờ UI thật — vẫn scale nhẹ theo SPEED (trước đây cố định → cảm giác chậm).
 * turbo ~35%, fast ~50%, normal ~70%, slow 100%.
 */
export function sleepExact(ms) {
  const s = (process.env.SPEED || 'fast').toLowerCase();
  let f = 0.5;
  if (s === 'turbo') f = 0.32;
  else if (s === 'normal') f = 0.7;
  else if (s === 'slow') f = 1;
  const floor = s === 'turbo' ? 40 : 80;
  const scaled = Math.max(floor, Math.round(ms * f));
  return new Promise((r) => setTimeout(r, scaled));
}

/** goto nhanh: không đợi networkidle */
export const GOTO = { waitUntil: 'domcontentloaded', timeout: 45000 };

/**
 * Chuẩn hoá WPM Project URL: sau /projects/{id} phải có /edit.
 * vd. .../projects/627  hoặc .../projects/627/  → .../projects/627/edit
 */
export function normalizeWpmProjectUrl(raw) {
  const s = String(raw || '').trim();
  if (!s) return s;
  try {
    const u = new URL(s);
    const m = u.pathname.match(/^\/projects\/(\d+)(?:\/(.*))?$/i);
    if (m) {
      const id = m[1];
      const rest = String(m[2] || '').replace(/^\/+|\/+$/g, '');
      if (!rest || !/^edit(\/|$)/i.test(rest)) {
        u.pathname = `/projects/${id}/edit`;
      } else {
        u.pathname = `/projects/${id}/edit`;
      }
      return u.toString();
    }
  } catch {
    /* fallback bên dưới */
  }
  // Không parse được URL đầy đủ
  if (/\/projects\/\d+/i.test(s) && !/\/projects\/\d+\/edit/i.test(s)) {
    return s.replace(/(\/projects\/\d+)\/?/i, '$1/edit');
  }
  return s;
}

/** Bỏ dấu nháy ' (tia's → tias) — WP username/pass hay lỗi vì ký tự này. */
export function stripApostrophes(raw) {
  return String(raw ?? '').replace(/[''`´′’‘]/g, '');
}

/**
 * Username WP-safe: bỏ nháy + ký tự lạ, luôn viết thường.
 */
export function sanitizeWpUsername(raw) {
  let s = stripApostrophes(raw).trim().toLowerCase();
  s = s.replace(/\s+/g, '-');
  s = s.replace(/[^a-z0-9._\-@]/g, '');
  s = s.replace(/-+/g, '-').replace(/^\-+|\-+$/g, '');
  return s;
}

/** Password khách: bỏ nháy ' (còn lại giữ nguyên). */
export function sanitizeCustomerPassword(raw) {
  return stripApostrophes(raw);
}

/**
 * Chỉ đóng WP admin notice thật sự (Elementor/Rank Math dismiss).
 * Không ẩn Updraft panels, không spam click "Close".
 */
export async function dismissBlockingAlerts(page, log = () => {}) {
  const closed = await page.evaluate(() => {
    let n = 0;
    const safeClick = (el) => {
      try {
        el.click();
        n += 1;
      } catch {
        /* ignore */
      }
    };

    // Chỉ nút dismiss chuẩn của notice
    document
      .querySelectorAll(
        '.notice.is-dismissible > .notice-dismiss, .e-notice__dismiss, .rank-math-notice > .notice-dismiss, .aioseo-notice .notice-dismiss'
      )
      .forEach(safeClick);

    // Elementor / Rank Math CTA dismiss — chỉ trong khối notice
    const noticeRoots = document.querySelectorAll(
      '.e-notice, .rank-math-notice, .notice.is-dismissible, .aioseo-notice'
    );
    for (const root of noticeRoots) {
      const btn = Array.from(root.querySelectorAll('a, button')).find((el) => {
        const t = (el.innerText || el.textContent || '').trim().toLowerCase();
        return (
          t === 'no thanks' ||
          t === 'no, maybe later' ||
          t === 'i already did' ||
          t === 'dismiss this notice'
        );
      });
      if (btn) safeClick(btn);
    }

    return n;
  });

  if (closed > 0) {
    log(`Đã đóng ${closed} notice (WP/Elementor/Rank Math).`);
    await sleep(80);
  }
  return closed;
}

export function originOf(url) {
  return new URL(url).origin;
}

export async function screenshotError(page, label = 'error') {
  ensureDirs();
  const name = `${label}-${Date.now()}.png`;
  const file = path.join(ERRORS_DIR, name);
  try {
    if (page && !page.isClosed()) {
      await page.screenshot({ path: file, fullPage: true });
      return { file, name, url: `/api/errors/${encodeURIComponent(name)}` };
    }
  } catch {
    /* ignore */
  }
  return null;
}

/**
 * evaluate an toàn khi trang đang navigate (tránh "Execution context was destroyed").
 */
export async function evaluateSafe(page, fn, ...args) {
  let lastErr;
  for (let i = 0; i < 4; i += 1) {
    try {
      return await page.evaluate(fn, ...args);
    } catch (err) {
      lastErr = err;
      const msg = err?.message || String(err);
      if (!/Execution context was destroyed|Cannot find context|navigat/i.test(msg)) {
        throw err;
      }
      await page
        .waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 12000 })
        .catch(() => {});
      await sleep(150);
    }
  }
  throw lastErr || new Error('Execution context was destroyed.');
}

/** Click first matching selector that exists and is visible. */
export async function clickFirst(page, selectors, { timeout = 15000 } = {}) {
  const list = Array.isArray(selectors) ? selectors : [selectors];
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    for (const sel of list) {
      try {
        const el = await page.$(sel);
        if (!el) continue;
        const box = await el.boundingBox();
        if (!box) continue;
        await el.click();
        return sel;
      } catch {
        /* try next */
      }
    }
    await sleep(80);
  }
  throw new Error(`Không tìm thấy / click được: ${list.join(' | ')}`);
}

/** Fill first matching input. */
export async function fillFirst(page, selectors, value, { timeout = 15000 } = {}) {
  const list = Array.isArray(selectors) ? selectors : [selectors];
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    for (const sel of list) {
      try {
        const el = await page.$(sel);
        if (!el) continue;
        await el.click({ clickCount: 3 });
        await el.type(String(value), { delay: 5 });
        return sel;
      } catch {
        /* try next */
      }
    }
    await sleep(80);
  }
  throw new Error(`Không tìm thấy input: ${list.join(' | ')}`);
}

export async function waitForAnyText(page, texts, { timeout = 60000 } = {}) {
  const list = Array.isArray(texts) ? texts : [texts];
  await page.waitForFunction(
    (needles) => {
      const body = document.body?.innerText || '';
      return needles.some((t) => body.includes(t));
    },
    { timeout },
    list
  );
}

export async function clickByText(page, text, { exact = false, timeout = 15000 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const clicked = await page.evaluate(
      (needle, exactMatch) => {
        const candidates = Array.from(
          document.querySelectorAll(
            'a, button, input[type="submit"], input[type="button"], [role="button"], .button, .button-primary, .cx-vui-button, button.cx-vui-button--style-accent'
          )
        );
        for (const el of candidates) {
          const t = (el.innerText || el.value || el.textContent || '').trim();
          const ok = exactMatch ? t === needle : t.includes(needle);
          if (!ok) continue;
          const style = window.getComputedStyle(el);
          if (style.display === 'none' || style.visibility === 'hidden') continue;
          el.click();
          return true;
        }
        return false;
      },
      text,
      exact
    );
    if (clicked) return;
    await sleep(80);
  }
  throw new Error(`Không click được phần tử chứa text: "${text}"`);
}
