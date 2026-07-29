/**
 * HTTP session lấy cookie từ trang Puppeteer (sau Quick Login).
 * Dùng cho bước WP có form/nonce rõ — không thay login browser.
 */

import { originOf } from '../utils.js';

/** USE_HTTP_STEPS=0|false|off → tắt. Mặc định bật (2.1). */
export function isHttpStepsEnabled() {
  const v = String(process.env.USE_HTTP_STEPS ?? '1').trim().toLowerCase();
  return !['0', 'false', 'off', 'no'].includes(v);
}

/**
 * @param {import('puppeteer').Page} page
 * @param {string} [urlHint] URL thuộc origin cần cookie (mặc định page.url())
 */
export async function cookieHeaderFromPage(page, urlHint) {
  const tip = urlHint || page.url();
  const origin = originOf(tip);
  if (!origin) throw new Error('Không xác định được origin WP để lấy cookie.');

  let cookies = [];
  try {
    cookies = await page.cookies(origin);
  } catch {
    cookies = await page.cookies();
  }
  if (!cookies?.length) {
    throw new Error('Không có cookie WP sau Quick Login — không thể gọi HTTP.');
  }
  return {
    origin,
    cookieHeader: cookies.map((c) => `${c.name}=${c.value}`).join('; '),
  };
}

/**
 * @param {string} url
 * @param {{ cookieHeader: string, method?: string, body?: string|URLSearchParams, headers?: Record<string,string>, redirect?: RequestRedirect }} opts
 */
export async function wpFetch(url, opts) {
  const method = (opts.method || 'GET').toUpperCase();
  const headers = {
    Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    Cookie: opts.cookieHeader,
    ...(opts.headers || {}),
  };

  let body = opts.body;
  if (body instanceof URLSearchParams) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    body = body.toString();
  }

  const res = await fetch(url, {
    method,
    headers,
    body: method === 'GET' || method === 'HEAD' ? undefined : body,
    redirect: opts.redirect || 'follow',
  });

  const text = await res.text();
  return {
    ok: res.ok,
    status: res.status,
    url: res.url,
    text,
    headers: res.headers,
  };
}

export function stripHtmlText(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
