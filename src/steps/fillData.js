import { launchBrowser } from '../browser.js';
import {
  normalizeWpmProjectUrl,
  sanitizeWpUsername,
  sanitizeCustomerPassword,
  sleepExact,
  GOTO,
} from '../utils.js';
import { loginToWPM, readProjectName, readProjectZipcode, openWebsiteInformationTab, resolveMainWeb } from './wpm.js';

const US_STATES = new Set(
  'AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC'
    .split(/\s+/)
);

/**
 * Từ đầu tên tiệm → username-admin (viết thường)
 * "Muse Nails Lounge" → "muse-admin"
 */
export function usernameFromShopName(shopName) {
  const first = String(shopName || '')
    .trim()
    .split(/\s+/)
    .find((w) => /[a-zA-Z0-9]/.test(w));
  if (!first) return '';
  const base = sanitizeWpUsername(first.replace(/[^a-zA-Z0-9._\-]/g, ''));
  if (!base) return '';
  return `${base}-admin`;
}

/** Password: username@STATE-zip — chỉ State in hoa. vd muse-admin@TX-75001 */
export function buildCustomerPassword(username, state, zip) {
  const user = String(username || '')
    .trim()
    .toLowerCase();
  const st = String(state || '')
    .trim()
    .toUpperCase();
  const z = String(zip || '')
    .trim()
    .replace(/\D/g, '')
    .slice(0, 5);
  if (!user || !st || !z) return '';
  return sanitizeCustomerPassword(`${user}@${st}-${z}`);
}

/** @deprecated Dùng Main Web trên Website Information — giữ tạm fallback. */
export async function readProjectWebsiteUrl(page) {
  return page.evaluate(() => {
    const prefer = [
      'input#website',
      'input[name="website"]',
      'input#domain',
      'input[name="domain"]',
      'input#url',
      'input[name="url"]',
      'input#live_url',
      'input[name="live_url"]',
    ];
    for (const sel of prefer) {
      const el = document.querySelector(sel);
      const v = (el?.value || el?.getAttribute('value') || '').trim();
      if (/^https?:\/\//i.test(v) || /^[\w.-]+\.[a-z]{2,}/i.test(v)) return v;
    }
    return '';
  });
}

/** Chỉ giữ origin: https://domain.com — bỏ path (/mac-login…), query, hash. */
function normalizeHttpUrl(raw) {
  let s = String(raw || '').trim();
  if (!s) return '';
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  try {
    const u = new URL(s);
    // Bỏ path kiểu /mac-login, /wp-admin, trailing slash
    return u.origin;
  } catch {
    return '';
  }
}

/**
 * Scrape footer website: email + State + Zip từ address.
 */
export async function scrapeSiteFooterContact(page, websiteUrl, log) {
  const url = normalizeHttpUrl(websiteUrl);
  if (!url) return { email: '', state: '', zip: '', warnings: ['Website URL không hợp lệ.'] };

  log(`Mở website khách: ${url}`);
  await page.goto(url, { ...GOTO, waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
  await sleepExact(1200);

  const data = await page.evaluate((statesList) => {
    const states = new Set(statesList);
    const footerNodes = [
      ...document.querySelectorAll(
        'footer, .footer, #footer, [class*="footer"], [id*="footer"], .site-info, .copyright'
      ),
    ];
    const scope =
      footerNodes.length > 0
        ? footerNodes.map((n) => n.innerText || '').join('\n')
        : (document.body?.innerText || '').slice(-4500);

    const mailto = document.querySelector(
      'footer a[href^="mailto:"], .footer a[href^="mailto:"], [class*="footer"] a[href^="mailto:"], a[href^="mailto:"]'
    );
    let email = '';
    if (mailto) {
      email = decodeURIComponent((mailto.getAttribute('href') || '').replace(/^mailto:/i, ''))
        .split('?')[0]
        .trim();
    }
    if (!email) {
      const m = scope.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
      if (m) email = m[0];
    }
    // Bỏ email giả / tracking
    if (/example\.com|sentry\.|wixpress|cloudflare|schema/i.test(email)) email = '';

    let state = '';
    let zip = '';
    // TX 75001 | TX-75001 | TX, 75001
    const re = /\b([A-Z]{2})\s*[,.\-]?\s*(\d{5})(?:-\d{4})?\b/g;
    let hit;
    while ((hit = re.exec(scope)) !== null) {
      if (states.has(hit[1])) {
        state = hit[1];
        zip = hit[2];
        break;
      }
    }
    // Fallback: zip gần cuối footer + state 2 chữ trước đó
    if (!zip) {
      const zm = scope.match(/\b(\d{5})(?:-\d{4})?\b/g);
      if (zm?.length) zip = zm[zm.length - 1].slice(0, 5);
    }

    return { email, state, zip, snippet: scope.slice(0, 240) };
  }, [...US_STATES]);

  const warnings = [];
  if (!data.email) warnings.push('Không lấy được email từ footer website.');
  if (!data.state || !data.zip) warnings.push('Không lấy được State/Zip từ address footer.');

  return {
    email: data.email || '',
    state: data.state || '',
    zip: data.zip || '',
    warnings,
  };
}

/**
 * Login WPM → đọc project → scrape website footer → build username/password/email.
 * @returns {Promise<object>}
 */
export async function fillCustomerDataFromUrls(
  { wpmProjectUrl, taskUrl, wpmCredentials },
  onLog = () => {}
) {
  const log = (msg) => onLog(`[${new Date().toLocaleTimeString('vi-VN')}] ${msg}`);
  const projectUrl = normalizeWpmProjectUrl(String(wpmProjectUrl || '').trim());
  if (!projectUrl) throw new Error('Thiếu WPM Project URL.');
  if (!wpmCredentials?.username || !wpmCredentials?.password) {
    throw new Error('Thiếu credentials WPM (login tool bằng email/password WPM).');
  }

  const { browser, page } = await launchBrowser({ headless: true });
  const warnings = [];

  try {
    log('▶ Fill data: login WPM...');
    await loginToWPM(page, wpmCredentials, log);

    const cleanUrl = (() => {
      try {
        const u = new URL(projectUrl);
        u.search = '';
        u.hash = '';
        return u.toString();
      } catch {
        return projectUrl.split('?')[0];
      }
    })();

    log(`Mở project: ${cleanUrl}`);
    await page.goto(cleanUrl, GOTO);
    await sleepExact(800);
    await page.evaluate(() => {
      const tab = Array.from(
        document.querySelectorAll('a.nav-link, button.nav-link, a[role="tab"], a, button')
      ).find((el) =>
        /^project information$/i.test((el.textContent || '').replace(/\s+/g, ' ').trim())
      );
      tab?.click();
    });
    await sleepExact(500);
    await page
      .waitForSelector('input#name[name="name"], #btnSplit', { timeout: 15000 })
      .catch(() => {});

    let shopName = '';
    let wpmZip = '';
    for (let i = 0; i < 12; i += 1) {
      shopName = await readProjectName(page);
      wpmZip = await readProjectZipcode(page);
      if (shopName) break;
      await sleepExact(350);
    }

    if (!shopName) {
      throw new Error('Không đọc được Name (tên tiệm) trên WPM Project.');
    }
    log(`Tên tiệm: ${shopName}`);

    log('Chọn Main Web trên Website Information...');
    const tabOk = await openWebsiteInformationTab(page, cleanUrl, log);
    if (!tabOk) {
      throw new Error('Không mở được tab Website Information.');
    }
    const mainWeb = await resolveMainWeb(page, log);
    let websiteUrl = normalizeHttpUrl(mainWeb?.url || '');

    if (!websiteUrl && taskUrl) {
      log('Chưa có Main Web URL — thử Task URL...');
      await page.goto(String(taskUrl).trim(), GOTO).catch(() => {});
      await sleepExact(800);
      const fromTask = await readProjectWebsiteUrl(page);
      websiteUrl = normalizeHttpUrl(fromTask);
    }
    if (!websiteUrl) {
      throw new Error('Không đọc được Main Web URL trên WPM (tick Main Web trên Website Information).');
    }
    log(`Website (Main Web): ${websiteUrl}`);

    const username = usernameFromShopName(shopName);
    if (!username) throw new Error('Không tạo được username từ tên tiệm.');

    const site = await scrapeSiteFooterContact(page, websiteUrl, log);
    warnings.push(...(site.warnings || []));

    // Zip fallback từ WPM nếu footer thiếu zip
    let state = site.state;
    let zip = site.zip || (wpmZip || '').replace(/\D/g, '').slice(0, 5);
    if (!site.zip && zip) {
      log(`Zip fallback từ WPM Project: ${zip}`);
      warnings.push('Zip lấy từ WPM Project (footer không có / không parse được).');
    }
    if (!state && zip) {
      warnings.push('Có Zip nhưng thiếu State (cần State từ address footer để tạo password).');
    }

    const password = buildCustomerPassword(username, state, zip);
    if (!password) {
      warnings.push('Chưa tạo được password (thiếu State hoặc Zip).');
    } else {
      log(`Password: ${password}`);
    }

    log(`Username: ${username}`);
    if (site.email) log(`Email: ${site.email}`);
    else log('⚠ Không lấy được email từ footer.');

    return {
      ok: true,
      shopName,
      websiteUrl,
      username,
      password,
      email: site.email || '',
      state: state || '',
      zip: zip || '',
      warnings,
      taskUrl: String(taskUrl || '').trim() || undefined,
      wpmProjectUrl: projectUrl,
    };
  } finally {
    await browser.close().catch(() => {});
  }
}
