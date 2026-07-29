import { launchBrowser, shouldRunHeaded } from '../browser.js';
import {
  normalizeWpmProjectUrl,
  sanitizeWpUsername,
  sanitizeCustomerPassword,
  sleepExact,
  GOTO,
} from '../utils.js';
import {
  loginToWPM,
  readProjectName,
  readProjectZipcode,
  readProjectEmail,
  openWebsiteInformationTab,
  resolveTargetWeb,
} from './wpm.js';
import { startLiveSession, stopLiveSession, isFrameLiveMode, getLiveMode } from '../liveSession.js';
import { registerLiveBrowser, unregisterLiveBrowser } from '../liveBrowser.js';
import { isLiveVncActive } from '../liveVnc.js';

const US_STATES = new Set(
  'AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC'
    .split(/\s+/)
);

/**
 * Tên tiệm → slug chữ thường, bỏ khoảng trắng/ký tự lạ.
 * "Luna Beauty Nails" → lunabeautynails
 * "lunabeautynails-admin" → lunabeautynails
 */
export function shopNameSlug(shopName) {
  let s = String(shopName || '')
    .trim()
    .toLowerCase()
    .replace(/-admin$/i, '');
  return sanitizeWpUsername(s.replace(/[^a-z0-9]/g, ''));
}

/**
 * Username: Tên tiệm-admin
 * vd lunabeautynails-admin
 */
export function usernameFromShopName(shopName) {
  const base = shopNameSlug(shopName);
  if (!base) return '';
  return `${base}-admin`;
}

/** @deprecated Rule hiện tại dùng tên tiệm, không dùng domain. */
export function usernameFromWebsiteUrl(websiteUrl) {
  let host = '';
  const raw = String(websiteUrl || '').trim();
  if (!raw) return '';
  try {
    const withProto = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    host = new URL(withProto).hostname;
  } catch {
    host = raw.replace(/^https?:\/\//i, '').split(/[/?#]/)[0] || '';
  }
  host = host.toLowerCase().replace(/^www\./, '');
  if (host.endsWith('.com')) host = host.slice(0, -4);
  const base = sanitizeWpUsername(host.replace(/[^a-zA-Z0-9._\-]/g, ''));
  if (!base) return '';
  if (/-admin$/i.test(base)) return base.toLowerCase();
  return `${base}-admin`;
}

/**
 * Password: Tên tiệm@Zipcode (không kèm -admin, không State).
 * vd lunabeautynails@12345
 * @param {string} shopNameOrSlug — tên tiệm / slug / username-admin
 * @param {string} zip
 */
export function buildCustomerPassword(shopNameOrSlug, zip) {
  const slug = shopNameSlug(shopNameOrSlug);
  const z = String(zip || '')
    .trim()
    .replace(/\D/g, '')
    .slice(0, 5);
  if (!slug || !z) return '';
  return sanitizeCustomerPassword(`${slug}@${z}`);
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
 * @param {object} opts
 * @param {string} opts.wpmProjectUrl
 * @param {string} [opts.taskUrl]
 * @param {{ username: string, password: string }} opts.wpmCredentials
 * @param {'main'|'website'} [opts.webTargetMode]
 * @param {string} [opts.websiteUrl] Prefer URL khi mode=website (admin đã điền subdomain)
 * @param {string} [opts.liveSessionId]
 * @param {(payload: object) => void} [opts.onScreencast]
 * @param {string} [opts.liveUserId] — đăng ký Chrome Live theo user
 * @returns {Promise<object>}
 */
export async function fillCustomerDataFromUrls(
  {
    wpmProjectUrl,
    taskUrl,
    wpmCredentials,
    webTargetMode: rawMode,
    websiteUrl: preferWebsite,
    liveSessionId,
    onScreencast,
    liveUserId,
  },
  onLog = () => {}
) {
  const log = (msg) =>
    onLog(
      `[${new Date().toLocaleTimeString('vi-VN', {
        timeZone: 'Asia/Ho_Chi_Minh',
        hour12: false,
      })}] ${msg}`
    );
  const projectUrl = normalizeWpmProjectUrl(String(wpmProjectUrl || '').trim());
  if (!projectUrl) throw new Error('Thiếu WPM Project URL.');
  if (!wpmCredentials?.username || !wpmCredentials?.password) {
    throw new Error('Thiếu credentials WPM (login tool bằng email/password WPM).');
  }

  const webTargetMode = rawMode === 'website' ? 'website' : 'main';
  const preferUrl = normalizeHttpUrl(preferWebsite);

  const { browser, page } = await launchBrowser();
  const warnings = [];
  const sid = liveSessionId || '';
  const headed = shouldRunHeaded();

  try {
    if (sid && onScreencast && process.env.CHROME_LIVE === 'true' && isFrameLiveMode()) {
      await startLiveSession(sid, browser, page, onScreencast).catch((e) =>
        log(`⚠ Live ${getLiveMode()}: ${e?.message || e}`)
      );
      const ms = Number(process.env.LIVE_SNAPSHOT_MS) || 1500;
      log(
        getLiveMode() === 'snapshot'
          ? `→ Live snapshot (~${ms}ms/ảnh) — Mở Live trên UI để xem.`
          : '→ Live screencast bật — mở panel Live trên UI.'
      );
    } else if (process.env.CHROME_LIVE === 'true' && !headed && getLiveMode() === 'novnc') {
      log('→ Chạy headless (Live tắt) — nhanh hơn. Mở Live trước Fill/Run nếu cần xem.');
    }

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
    let wpmEmail = '';
    const excludeEmails = [wpmCredentials.username].filter(Boolean);
    for (let i = 0; i < 12; i += 1) {
      shopName = await readProjectName(page);
      wpmZip = await readProjectZipcode(page);
      wpmEmail = await readProjectEmail(page, { excludeEmails });
      if (shopName) break;
      await sleepExact(350);
    }

    if (!shopName) {
      throw new Error('Không đọc được Name (tên tiệm) trên WPM Project.');
    }
    log(`Tên tiệm: ${shopName}`);
    if (wpmEmail) log(`Email (Project Information): ${wpmEmail}`);
    else log('⚠ Chưa đọc được Email Project Information (hoặc trùng email user đăng nhập — đã bỏ).');

    log(
      webTargetMode === 'website'
        ? 'Chọn web khớp Website URL trên Website Information...'
        : 'Chọn Main Web trên Website Information...'
    );
    const tabOk = await openWebsiteInformationTab(page, cleanUrl, log);
    if (!tabOk) {
      throw new Error('Không mở được tab Website Information.');
    }
    const targetWeb = await resolveTargetWeb(
      page,
      { mode: webTargetMode, preferUrl },
      log
    );
    let websiteUrl = normalizeHttpUrl(targetWeb?.url || '');

    if (!websiteUrl && webTargetMode === 'main' && taskUrl) {
      log('Chưa có Main Web URL — thử Task URL...');
      await page.goto(String(taskUrl).trim(), GOTO).catch(() => {});
      await sleepExact(800);
      const fromTask = await readProjectWebsiteUrl(page);
      websiteUrl = normalizeHttpUrl(fromTask);
    }
    if (!websiteUrl) {
      throw new Error(
        webTargetMode === 'website'
          ? 'Không đọc được Website URL khớp trên WPM (nhập subdomain vào ô Website rồi Fill lại).'
          : 'Không đọc được Main Web URL trên WPM (tick Main Web trên Website Information).'
      );
    }
    if (webTargetMode === 'website' && !targetWeb?.isMainWeb) {
      log(`⚠ Fill đang dùng NON-Main Web: ${websiteUrl}`);
      warnings.push(`Target web không phải Main Web: ${websiteUrl}`);
    } else {
      log(`Website (${webTargetMode === 'website' ? 'target' : 'Main Web'}): ${websiteUrl}`);
    }

    const shopSlug = shopNameSlug(shopName);
    const username = usernameFromShopName(shopName);
    if (!username) throw new Error('Không tạo được username từ tên tiệm.');
    log(`Username từ tên tiệm: ${username}`);

    const site = await scrapeSiteFooterContact(page, websiteUrl, log);
    warnings.push(...(site.warnings || []));

    // Zip: ưu tiên footer, fallback WPM Project
    let state = site.state;
    let zip = site.zip || (wpmZip || '').replace(/\D/g, '').slice(0, 5);
    if (!site.zip && zip) {
      log(`Zip fallback từ WPM Project: ${zip}`);
      warnings.push('Zip lấy từ WPM Project (footer không có / không parse được).');
    }

    // Email: ưu tiên footer (không lấy email user tool), fallback Project Information
    const excludeSet = new Set(
      excludeEmails.map((e) => String(e).trim().toLowerCase()).filter(Boolean)
    );
    let email = String(site.email || '').trim();
    if (email && excludeSet.has(email.toLowerCase())) {
      log(`⚠ Footer trả email trùng user đăng nhập (${email}) — bỏ, dùng Project Information.`);
      email = '';
    }
    let emailSource = email ? 'footer' : '';
    if (!email && wpmEmail) {
      email = String(wpmEmail).trim();
      emailSource = 'project';
      log(`Email fallback từ Project Information: ${email}`);
      warnings.push('Email lấy từ WPM Project Information (footer không có).');
    } else if (!email) {
      // Thử mở lại tab Project Information (đã rời sang Website Information / site)
      try {
        log('Footer không có email — mở lại Project Information…');
        await page.goto(cleanUrl, GOTO);
        await sleepExact(600);
        await page.evaluate(() => {
          const tab = Array.from(
            document.querySelectorAll('a.nav-link, button.nav-link, a[role="tab"], a, button')
          ).find((el) =>
            /^project information$/i.test((el.textContent || '').replace(/\s+/g, ' ').trim())
          );
          tab?.click();
        });
        await sleepExact(500);
        wpmEmail = await readProjectEmail(page, { excludeEmails });
        if (wpmEmail) {
          email = String(wpmEmail).trim();
          emailSource = 'project';
          log(`Email từ Project Information: ${email}`);
          warnings.push('Email lấy từ WPM Project Information (footer không có).');
        }
      } catch (e) {
        log(`⚠ Đọc email Project Information thất bại: ${e?.message || e}`);
      }
    }

    const password = buildCustomerPassword(shopSlug || shopName, zip);
    if (!password) {
      warnings.push('Chưa tạo được password (thiếu Zip).');
    } else {
      log(`Password: ${password}`);
    }

    log(`Username: ${username}`);
    if (email) {
      log(`Email: ${email} (${emailSource === 'project' ? 'Project Information' : 'footer'})`);
    } else {
      log('⚠ Không lấy được email (footer + Project Information) — điền tay trên form trước khi Run.');
    }

    const urlHint =
      webTargetMode === 'website'
        ? targetWeb?.isMainWeb
          ? 'Khớp Website (đúng Main Web)'
          : 'Khớp Website (subdomain / non-Main)'
        : websiteUrl
          ? 'Main Web'
          : 'Thiếu Main Web URL';

    const emailHint = email
      ? emailSource === 'project'
        ? 'WPM Project Information'
        : 'Footer website'
      : 'Không thấy email footer / Project Information — điền tay';

    const fields = {
      websiteUrl: { ok: Boolean(websiteUrl), value: websiteUrl, hint: urlHint },
      username: {
        ok: Boolean(username),
        value: username,
        hint: username ? 'Tên tiệm-admin' : 'Thiếu tên tiệm',
      },
      password: {
        ok: Boolean(password),
        value: password,
        hint: password ? `${shopSlug}@${zip}` : 'Thiếu Zip — sửa tay password',
      },
      email: {
        ok: Boolean(email),
        value: email || '',
        hint: emailHint,
      },
      state: { ok: Boolean(state), value: state || '', hint: state ? 'Footer' : 'Thiếu State' },
      zip: { ok: Boolean(zip), value: zip || '', hint: zip ? (site.zip ? 'Footer' : 'WPM fallback') : 'Thiếu Zip' },
    };

    const needManual = ['websiteUrl', 'username', 'password', 'email'].filter((k) => !fields[k].ok);

    if (needManual.length) {
      log(`⚠ Cần sửa tay trên form: ${needManual.join(', ')}`);
    } else {
      log('✓ Đủ field — kiểm tra nhanh rồi Run.');
    }

    return {
      ok: needManual.length === 0,
      shopName,
      websiteUrl,
      username,
      password,
      email: email || '',
      state: state || '',
      zip: zip || '',
      warnings,
      fields,
      needManual,
      webTargetMode,
      isMainWeb: Boolean(targetWeb?.isMainWeb),
      taskUrl: String(taskUrl || '').trim() || undefined,
      wpmProjectUrl: projectUrl,
    };
  } finally {
    if (sid) await stopLiveSession(sid).catch(() => {});
    // Chỉ giữ Chrome khi đang headed + Live (xem được trên Xvfb)
    if (process.env.CHROME_LIVE === 'true' && headed && isLiveVncActive()) {
      registerLiveBrowser(liveUserId, browser);
      log('→ Live Chrome: giữ mở sau Fill — tương tác trên panel Live.');
    } else {
      unregisterLiveBrowser(liveUserId, browser);
      await browser.close().catch(() => {});
    }
  }
}
