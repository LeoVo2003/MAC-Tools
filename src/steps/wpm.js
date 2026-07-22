import {
  fillFirst,
  clickFirst,
  clickByText,
  sleep,
  sleepExact,
  GOTO,
} from '../utils.js';

/** Điền input theo kiểu React/Vue (clear + type thật). */
async function fillNative(page, handle, value) {
  await handle.focus();
  await page.evaluate((el) => {
    el.select?.();
    el.value = '';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, handle);
  await handle.type(String(value), { delay: 15 });
  await page.evaluate((el) => {
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.blur();
  }, handle);
}

const WPM_BASE = 'https://wpm.macusaone.com';

export async function loginToWPM(page, { username, password }, log) {
  log('Mở trang login WPM...');
  await page.goto(`${WPM_BASE}/login`, GOTO);

  await fillFirst(page, [
    'input[name="username"]',
    'input[name="email"]',
    'input[type="email"]',
    'input#username',
    'input#email',
    'input[name="log"]',
  ], username);

  await fillFirst(page, [
    'input[name="password"]',
    'input[type="password"]',
    'input#password',
  ], password);

  try {
    await clickFirst(page, [
      'button[type="submit"]',
      'input[type="submit"]',
      'button.btn-primary',
      'button.login',
    ], { timeout: 4000 });
  } catch {
    await clickByText(page, 'Login', { timeout: 4000 }).catch(() =>
      clickByText(page, 'Đăng nhập', { timeout: 4000 })
    );
  }

  await page.waitForNavigation(GOTO).catch(() => {});
  await sleep(400);

  const url = page.url();
  if (url.includes('/login')) {
    throw new Error('Login WPM thất bại — vẫn ở trang /login. Kiểm tra WPM_USERNAME / WPM_PASSWORD.');
  }
  log('Đã login WPM.');
}

/**
 * Đọc Name project — đúng ô cạnh nút Split (#btnSplit):
 *   <input id="name" name="name" data-label="Name" placeholder="Enter project name" ...>
 * Không lấy Assign to (Leo 🦁).
 */
export async function readProjectName(page) {
  return page.evaluate(() => {
    // Cách chắc nhất: input cùng .input-group với #btnSplit
    const bySplit = document
      .querySelector('#btnSplit')
      ?.closest('.input-group, .form-group')
      ?.querySelector('input#name, input[name="name"]');

    const byExact =
      document.querySelector(
        'input#name[name="name"][data-label="Name"], input#name[name="name"][placeholder*="project" i]'
      ) || document.querySelector('input#name[name="name"].button-input');

    const byLabel = (() => {
      const lab = document.querySelector('label[for="name"]');
      if (!lab) return null;
      const labText = (lab.textContent || '').replace(/\s+/g, ' ').trim();
      if (!/^name\b/i.test(labText) || /assign/i.test(labText)) return null;
      return lab.closest('.form-group')?.querySelector('input#name[name="name"], input#name');
    })();

    const el = bySplit || byExact || byLabel;
    if (!el) return '';

    // Chặn nhầm Assign to
    const near = (el.closest('.form-group')?.innerText || '').slice(0, 80);
    if (/assign\s*to/i.test(near)) return '';

    return (el.value || el.getAttribute('value') || '').trim();
  });
}

/** Đọc Zip Code trên Project Information (`#zipcode`). */
export async function readProjectZipcode(page) {
  return page.evaluate(() => {
    const el =
      document.querySelector('input#zipcode[name="zipcode"]') ||
      document.querySelector('input#zipcode') ||
      document.querySelector('input[name="zipcode"]');
    if (!el) return '';
    return (el.value || el.getAttribute('value') || '').trim();
  });
}

/** Mở tab Website Information trên trang project. */
export async function openWebsiteInformationTab(page, projectUrl, log = () => {}) {
  const u = new URL(projectUrl);
  u.searchParams.set('tab', 'tab-web-info');
  const candidates = [
    u.toString(),
    `${String(projectUrl).replace(/\/$/, '')}?tab=tab-web-info`,
    projectUrl,
  ];

  for (const url of candidates) {
    await page.goto(url, GOTO);
    await sleep(400);
    await page.evaluate(() => {
      const tab =
        document.querySelector(
          'a[href="#tab-web-info"], a[href*="tab-web-info"], [data-bs-target="#tab-web-info"], [data-toggle="tab"][href="#tab-web-info"]'
        ) ||
        Array.from(document.querySelectorAll('a, button')).find((el) =>
          /website information|web info/i.test((el.textContent || '').trim())
        );
      tab?.click();
    });
    await sleep(300);
    const ok = await page.evaluate(() => {
      const pane = document.querySelector('#tab-web-info');
      return (
        !!document.querySelector('#web-info, #websContainer, .web-item, [id^="web_"]') ||
        (pane && pane.classList.contains('active')) ||
        /website information|web:/i.test(document.body?.innerText || '')
      );
    });
    if (ok) {
      log?.('Đã mở tab Website Information.');
      return true;
    }
  }
  return false;
}

function toOriginUrl(raw) {
  let s = String(raw || '').trim();
  if (!s) return '';
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  try {
    return new URL(s).origin;
  } catch {
    return '';
  }
}

/**
 * Đọc danh sách web card — KHÔNG click/mở bất kỳ card nào.
 * URL từ header "Web: https://…"; checkbox Main Web/Live đọc trong DOM (kể cả đang collapse).
 */
async function listWebsiteCards(page) {
  return page.evaluate(() => {
    const toOrigin = (raw) => {
      let s = String(raw || '').trim();
      if (!s) return '';
      if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
      try {
        return new URL(s).origin;
      } catch {
        return '';
      }
    };
    const isStaging = (url) => /macmar\.us|\.macusaone\.|staging|preview/i.test(url || '');

    const cards = Array.from(
      document.querySelectorAll(
        '#websContainer [id^="web_"], #websContainer .web-item, #tab-web-info [id^="web_"]'
      )
    );

    return cards
      .map((card, index) => {
        const header = card.querySelector('.card-header') || card;
        const headerText = (header.innerText || header.textContent || '').replace(/\s+/g, ' ');

        let url = '';
        const m = headerText.match(/Web:\s*(https?:\/\/[^\s]+)/i);
        if (m) url = m[1].replace(/[),.;]+$/, '');

        // Input URL có thể nằm trong body collapsed — vẫn query được trong DOM
        if (!url) {
          const named = card.querySelector(
            'input[name*="web_url" i], input[id*="web_url" i], input[id*="webUrl" i], input[name*="webUrl" i]'
          );
          if (named?.value) url = named.value;
        }
        if (!url) {
          const domainInp = card.querySelector(
            'input[name*="domain" i], input[id*="domain" i]'
          );
          if (domainInp?.value) url = domainInp.value.trim();
        }

        let mainChecked = false;
        let liveChecked = false;
        for (const cb of card.querySelectorAll('input[type="checkbox"]')) {
          const lab =
            cb.closest('label') ||
            (cb.id ? document.querySelector(`label[for="${CSS.escape(cb.id)}"]`) : null) ||
            cb.parentElement;
          const t = (lab?.textContent || '').replace(/\s+/g, ' ').trim();
          if (/main\s*web/i.test(t)) mainChecked = Boolean(cb.checked);
          if (/web\s*live/i.test(t)) liveChecked = Boolean(cb.checked);
        }

        const origin = toOrigin(url);
        return {
          index,
          id: card.id || `web_${index}`,
          url: origin,
          staging: isStaging(origin),
          mainChecked,
          liveChecked,
        };
      })
      .filter((x) => x.url);
  });
}

/**
 * Chọn web target trên Website Information.
 * - mode `main` (mặc định): tick Main Web → Web live → non-staging → web đầu.
 * - mode `website`: khớp origin `preferUrl`; không khớp → lỗi (không fallback Main Web).
 * @param {import('puppeteer').Page} page
 * @param {{ mode?: 'main'|'website', preferUrl?: string }} [opts]
 * @returns {Promise<{ id: string, index: number, url: string, reason: string, isMainWeb: boolean, staging: boolean } | null>}
 */
export async function resolveTargetWeb(page, opts = {}, log = () => {}) {
  const mode = opts.mode === 'website' ? 'website' : 'main';
  const preferUrl = toOriginUrl(opts.preferUrl);
  const withUrl = await listWebsiteCards(page);

  if (!withUrl.length) {
    log('⚠ Không tìm thấy web nào trên Website Information.');
    return null;
  }

  log(`Có ${withUrl.length} web trên WPM: ${withUrl.map((w) => w.url).join(' | ')}`);

  let chosen = null;
  let reason = '';

  if (mode === 'website') {
    if (preferUrl) {
      chosen = withUrl.find((x) => x.url === preferUrl) || null;
      if (!chosen) {
        const list = withUrl.map((x) => x.url).join(', ');
        throw new Error(
          `Không tìm thấy web khớp Website URL (${preferUrl}). Các web trên WPM: ${list}. Không fallback Main Web.`
        );
      }
      reason = 'khớp ô Website';
    } else {
      const staging = withUrl.filter((x) => x.staging);
      if (staging.length === 1) {
        chosen = staging[0];
        reason = 'staging duy nhất (chưa có ô Website)';
      } else if (staging.length > 1) {
        throw new Error(
          `Có ${staging.length} web staging — nhập Website URL (subdomain test) rồi chọn Target = Khớp ô Website.`
        );
      } else {
        throw new Error(
          'Mode Website cần ô Website URL (subdomain). Không có web staging để tự chọn — không fallback Main Web.'
        );
      }
    }
  } else {
    chosen =
      withUrl.find((x) => x.mainChecked) ||
      withUrl.find((x) => x.liveChecked && !x.staging) ||
      withUrl.find((x) => !x.staging) ||
      withUrl[0] ||
      null;
    if (!chosen) return null;
    reason = 'first web (fallback)';
    if (chosen.mainChecked) reason = 'Main Web ✓';
    else if (chosen.liveChecked && !chosen.staging) reason = 'Web live (fallback)';
    else if (!chosen.staging) reason = 'non-staging URL (fallback)';
  }

  const isMainWeb = Boolean(chosen.mainChecked);
  const pick = { ...chosen, reason, isMainWeb };
  const label = mode === 'website' ? 'Target web' : 'Main Web';
  log(
    `${label}: ${pick.url} (${pick.reason}, id=${pick.id}${isMainWeb ? ', Main Web ✓' : ', không phải Main Web'})`
  );
  return pick;
}

/**
 * Alias: luôn chọn Main Web (rule cũ).
 */
export async function resolveMainWeb(page, log = () => {}) {
  return resolveTargetWeb(page, { mode: 'main' }, log);
}

/** true nếu card đang mở (body/collapse visible). */
async function isWebCardExpanded(page, webId) {
  return page.evaluate((id) => {
    const card =
      document.getElementById(id) ||
      document.querySelector(`#websContainer [id="${id}"]`);
    if (!card) return false;
    const toggle = card.querySelector(
      '.card-header [aria-expanded], .card-header [data-toggle="collapse"], .card-header [data-bs-toggle="collapse"]'
    );
    if (toggle?.getAttribute('aria-expanded') === 'true') return true;
    if (toggle?.getAttribute('aria-expanded') === 'false') return false;
    const body =
      card.querySelector('.collapse.show, .card-body:not(.collapse)') ||
      card.querySelector('.collapse, .card-body');
    if (body) {
      const st = window.getComputedStyle(body);
      const r = body.getBoundingClientRect();
      if (st.display === 'none' || r.height < 24) return false;
      return true;
    }
    // Có Endpoint / Web Type visible → đang mở
    const t = card.innerText || '';
    return /endpoint\s*\d+|web type|add account/i.test(t) && t.length > 120;
  }, webId);
}

/** Mở hoặc đóng đúng 1 web card (không đụng card khác). */
async function setWebCardExpanded(page, webId, wantOpen) {
  const open = await isWebCardExpanded(page, webId);
  if (open === wantOpen) return;
  await page.evaluate((id) => {
    const card =
      document.getElementById(id) ||
      document.querySelector(`#websContainer [id="${id}"]`);
    if (!card) return;
    const header =
      card.querySelector(
        '.card-header [data-toggle="collapse"], .card-header [data-bs-toggle="collapse"], .card-header [aria-expanded]'
      ) ||
      card.querySelector('.card-header') ||
      card;
    header.click();
  }, webId);
  await sleepExact(450);
}

/**
 * Chỉ mở ĐÚNG 1 web card target — card khác nếu đang mở thì đóng, còn lại không đụng.
 */
export async function focusOnlyWebCard(page, webId, log = () => {}) {
  const ids = await page.evaluate(() =>
    Array.from(
      document.querySelectorAll(
        '#websContainer [id^="web_"], #websContainer .web-item[id], #tab-web-info [id^="web_"]'
      )
    )
      .map((el) => el.id)
      .filter(Boolean)
  );

  for (const id of ids) {
    if (id === webId) continue;
    const open = await isWebCardExpanded(page, id);
    if (open) {
      log(`Đóng web card đang mở nhầm (${id}).`);
      await setWebCardExpanded(page, id, false);
    }
  }

  // Chỉ mở card target (nếu đang đóng)
  const already = await isWebCardExpanded(page, webId);
  if (!already) {
    log(`Mở card target ${webId}...`);
    await setWebCardExpanded(page, webId, true);
  } else {
    log(`Card target ${webId} đã mở sẵn.`);
  }

  const ok = await isWebCardExpanded(page, webId);
  if (!ok) {
    await setWebCardExpanded(page, webId, true);
  }
  log(`Chỉ thao tác trên card ${webId} — không mở web khác.`);
}

/** Expand đúng card web (theo id). Prefer focusOnlyWebCard khi có nhiều web. */
export async function expandWebCard(page, webId) {
  await setWebCardExpanded(page, webId, true);
}

/**
 * Bấm Quick Login trên đúng card Main Web (không lấy subdomain).
 * @returns {Promise<boolean>}
 */
export async function clickMainWebQuickLogin(page, webId, log = () => {}) {
  const clicked = await page.evaluate((id) => {
    const card =
      document.getElementById(id) ||
      document.querySelector(`#websContainer [id="${id}"]`);
    if (!card) return false;
    const scope = card.querySelector('.card-header') || card;
    const candidates = Array.from(scope.querySelectorAll('a, button, [role="button"], span.btn, i'));
    const score = (el) => {
      const meta = `${el.getAttribute('title') || ''} ${el.getAttribute('aria-label') || ''} ${el.className || ''} ${el.id || ''}`;
      if (/quick\s*login|auto.?login/i.test(meta)) return 100;
      if (/login|sign-in|wp-admin/i.test(meta)) return 80;
      if (/fa-sign|fa-external|logout|arrow/i.test(meta)) return 60;
      return 0;
    };
    let best = null;
    let bestScore = 0;
    for (const el of candidates) {
      const s = score(el);
      if (s > bestScore) {
        bestScore = s;
        best = el.closest('a, button, [role="button"]') || el;
      }
    }
    // Fallback: nút icon cuối trên header (thường là login hồng)
    if (!best) {
      const btns = Array.from(scope.querySelectorAll('a.btn, button.btn, a[class*="btn"], button'));
      best = btns[btns.length - 1] || null;
    }
    if (!best) return false;
    best.click();
    return true;
  }, webId);

  if (clicked) log(`Đã bấm Quick Login trên Main Web (${webId}).`);
  return clicked;
}

/**
 * Mở project + Quick Login.
 * @param {object} [targetOpts]
 * @param {'main'|'website'} [targetOpts.webTargetMode]
 * @param {string} [targetOpts.preferUrl] Website URL khi mode=website
 * @returns {{ wpPage: import('puppeteer').Page, projectName: string, projectLabel: string, mainWebUrl: string, webTargetMode: string, isMainWeb: boolean }}
 */
export async function openProjectAndQuickLogin(browser, page, projectUrl, log, targetOpts = {}) {
  // Bỏ ?tab=web-info — Name chỉ có ở Project Information
  const cleanUrl = (() => {
    try {
      const u = new URL(projectUrl);
      u.search = '';
      u.hash = '';
      return u.toString();
    } catch {
      return String(projectUrl).split('?')[0];
    }
  })();

  const webTargetMode = targetOpts.webTargetMode === 'website' ? 'website' : 'main';
  const preferUrl = targetOpts.preferUrl || '';

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

  let projectName = '';
  let projectZip = '';
  for (let i = 0; i < 15; i += 1) {
    projectName = await readProjectName(page);
    projectZip = await readProjectZipcode(page);
    if (projectName) break;
    await sleepExact(300);
  }
  if (!projectZip) {
    projectZip = await readProjectZipcode(page);
  }

  if (projectName) {
    log(`Tên project (Name): ${projectName}`);
  } else {
    log('⚠ Không đọc được Name (#name + #btnSplit) — folder backup dùng tên mặc định.');
    projectName = '';
  }
  if (projectZip) {
    log(`Zip Code: ${projectZip}`);
  } else {
    log('⚠ Không đọc được Zip Code (#zipcode).');
  }

  const projectLabel = [projectZip, projectName].filter(Boolean).join(' ').trim();
  if (projectLabel) log(`Project: ${projectLabel}`);

  // Website Information → Target web → Quick Login
  const projectEditUrl = cleanUrl;
  const tabOk = await openWebsiteInformationTab(page, projectEditUrl, log);
  if (!tabOk) {
    throw new Error('Không mở được tab Website Information để chọn web target.');
  }
  const targetWeb = await resolveTargetWeb(
    page,
    { mode: webTargetMode, preferUrl },
    log
  );
  if (!targetWeb?.id) {
    throw new Error(
      webTargetMode === 'website'
        ? 'Không tìm thấy web khớp Website URL trên Website Information.'
        : 'Không tìm thấy Main Web trên Website Information.'
    );
  }
  if (webTargetMode === 'website' && !targetWeb.isMainWeb) {
    log(`⚠ CẢNH BÁO: đang Quick Login NON-Main Web (${targetWeb.url}) — không phải site live Main Web.`);
  }
  await focusOnlyWebCard(page, targetWeb.id, log);

  const pagesBefore = await browser.pages();

  log(`Bấm Quick Login CHỈ trên card ${targetWeb.url}...`);
  let clicked = await clickMainWebQuickLogin(page, targetWeb.id, log);

  if (!clicked) {
    throw new Error(
      `Không tìm thấy nút Quick Login trên card ${targetWeb.url} (không fallback sang web khác).`
    );
  }

  let wpPage = page;
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const pages = await browser.pages();
    const newer = pages.filter((p) => !pagesBefore.includes(p));
    if (newer.length) {
      wpPage = newer[newer.length - 1];
      break;
    }
    const u = page.url();
    if (u.includes('wp-admin') || u.includes('wp-login')) {
      wpPage = page;
      break;
    }
    await sleep(150);
  }

  await wpPage.bringToFront().catch(() => {});
  await wpPage.waitForNavigation(GOTO).catch(() => {});
  await sleep(500);

  if (wpPage.url().includes('wp-login')) {
    await sleep(800);
  }

  log(`Đã vào WordPress (${targetWeb.url}): ${wpPage.url()}`);
  return {
    wpPage,
    projectName,
    projectLabel,
    mainWebUrl: targetWeb.url,
    webTargetMode,
    isMainWeb: Boolean(targetWeb.isMainWeb),
  };
}

/**
 * Đồng bộ tài khoản khách lên WPM:
 * project URL?tab=tab-web-info
 * → mở Web card → endpoint đầu
 * → Add Account → điền username/password, Role=Editor, Notes="chủ tiệm"
 * → Submit/Save nếu có → verify username hiện trên form
 * @param {object} [targetOpts]
 * @param {'main'|'website'} [targetOpts.webTargetMode]
 * @param {string} [targetOpts.preferUrl]
 */
export async function syncAccountToWPM(page, projectUrl, account, log, targetOpts = {}) {
  const webTargetMode = targetOpts.webTargetMode === 'website' ? 'website' : 'main';
  const preferUrl = targetOpts.preferUrl || '';

  log(
    webTargetMode === 'website'
      ? 'Quay lại WPM → tab Website Information (khớp Website URL)...'
      : 'Quay lại WPM → tab Website Information (Main Web)...'
  );
  await page.bringToFront().catch(() => {});

  const landed = await openWebsiteInformationTab(page, projectUrl, log);
  if (!landed) {
    throw new Error('Không mở được tab Website Information trên WPM.');
  }

  const targetWeb = await resolveTargetWeb(page, { mode: webTargetMode, preferUrl }, log);
  if (!targetWeb?.id) {
    throw new Error(
      webTargetMode === 'website'
        ? 'Không tìm thấy web khớp Website URL để sync tài khoản.'
        : 'Không tìm thấy Main Web để sync tài khoản.'
    );
  }

  log(`Focus đúng card target (${targetWeb.url}) — đóng web khác...`);
  await focusOnlyWebCard(page, targetWeb.id, log);
  await sleepExact(400);

  log('Mở Endpoint 1 trên target web...');
  let endpointReady = false;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const clickInfo = await page.evaluate((webId) => {
      const root =
        document.getElementById(webId) ||
        document.querySelector(`#websContainer [id="${webId}"]`);
      if (!root) return { ok: false, reason: 'no-root' };

      const visible = (el) => {
        if (!el) return false;
        const st = window.getComputedStyle(el);
        if (st.display === 'none' || st.visibility === 'hidden') return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      };

      const hasAddAccount = () =>
        Array.from(root.querySelectorAll('a, button, span, div[role="button"]')).some((el) => {
          const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
          return /^add account\s*\+?$/i.test(t) && visible(el);
        });

      if (hasAddAccount()) {
        return { ok: true, alreadyOpen: true, header: 'already-open' };
      }

      const all = Array.from(
        root.querySelectorAll(
          'a, button, span, div, h1, h2, h3, h4, h5, .card-header, [data-toggle], [data-bs-toggle], [role="button"]'
        )
      );
      const scored = all
        .map((el) => {
          const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
          if (t.length > 80) return null;
          let score = 0;
          if (/^endpoint\s*1\b/i.test(t)) score = 100;
          else if (/^endpoint\s*\d+/i.test(t)) score = 90;
          else if (/endpoint\s*\d+/i.test(t) && t.length < 40) score = 80;
          else if (/^int\s*\d+/i.test(t)) score = 70;
          else if (/\bendpoint\b/i.test(t) && t.length < 40) score = 50;
          if (!score) return null;
          score -= Math.min((el.children?.length || 0) * 2, 20);
          return { el, score, t };
        })
        .filter(Boolean)
        .sort((a, b) => b.score - a.score);

      const hit = scored[0];
      if (!hit) return { ok: false, reason: 'no-endpoint-label' };

      const mark = `afp-endpoint-${Date.now()}`;
      const clickEl =
        hit.el.closest('.card-header, [data-toggle="collapse"], [data-bs-toggle="collapse"]') ||
        hit.el;
      clickEl.setAttribute('data-afp-endpoint', mark);
      clickEl.scrollIntoView?.({ block: 'center' });
      return { ok: true, alreadyOpen: false, mark, header: hit.t.slice(0, 60) };
    }, targetWeb.id);

    if (!clickInfo?.ok) {
      log(`⚠ Lần ${attempt}: không thấy label Endpoint (${clickInfo?.reason || '?'})`);
      await sleepExact(400);
      continue;
    }

    if (clickInfo.alreadyOpen) {
      log('Endpoint đã mở — thấy nút Add Account.');
      endpointReady = true;
      break;
    }

    log(`Click "${clickInfo.header}" (lần ${attempt})...`);
    try {
      const sel = `[data-afp-endpoint="${clickInfo.mark}"]`;
      await page.waitForSelector(sel, { visible: true, timeout: 3000 });
      await page.click(sel);
    } catch {
      await page.evaluate((mark) => {
        document.querySelector(`[data-afp-endpoint="${mark}"]`)?.click();
      }, clickInfo.mark);
    }
    await sleepExact(1000);

    const openOk = await page.evaluate((webId) => {
      const root =
        document.getElementById(webId) ||
        document.querySelector(`#websContainer [id="${webId}"]`);
      if (!root) return false;
      const visible = (el) => {
        if (!el) return false;
        const st = window.getComputedStyle(el);
        if (st.display === 'none' || st.visibility === 'hidden') return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      };
      return Array.from(root.querySelectorAll('a, button, span, div[role="button"]')).some((el) => {
        const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
        return /^add account\s*\+?$/i.test(t) && visible(el);
      });
    }, targetWeb.id);

    if (openOk) {
      log('✓ Endpoint đã mở — thấy Add Account.');
      endpointReady = true;
      break;
    }
    log(`⚠ Lần ${attempt}: click Endpoint nhưng chưa thấy Add Account — thử lại...`);
  }

  if (!endpointReady) {
    throw new Error(
      'Không mở được Endpoint 1 (không thấy nút Add Account). Mở tay Endpoint 1 trong card subdomain rồi Resume Sync.'
    );
  }

  const countBefore = await page.evaluate((webId) => {
    const root =
      document.getElementById(webId) ||
      document.querySelector(`#websContainer [id="${webId}"]`) ||
      document.body;
    const visible = (el) => {
      const st = window.getComputedStyle(el);
      if (st.display === 'none' || st.visibility === 'hidden') return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    return Array.from(root.querySelectorAll('label, .form-label, span, div, p, strong')).filter(
      (el) => {
        if (!visible(el)) return false;
        const t = (el.childNodes?.[0]?.textContent || el.textContent || '')
          .replace(/\s+/g, ' ')
          .trim();
        return /^username\s*\*?$/i.test(t) && t.length < 24;
      }
    ).length;
  }, targetWeb.id);
  log(`Add Account... (đang có ~${countBefore} account visible trong Endpoint)`);

  const added = await page.evaluate((webId) => {
    const root =
      document.getElementById(webId) ||
      document.querySelector(`#websContainer [id="${webId}"]`) ||
      document.body;
    const visible = (el) => {
      if (!el) return false;
      const st = window.getComputedStyle(el);
      if (st.display === 'none' || st.visibility === 'hidden') return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    const hit = Array.from(root.querySelectorAll('a, button, span, div[role="button"]')).find(
      (el) => {
        const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
        return /^add account\s*\+?$/i.test(t) && visible(el);
      }
    );
    if (!hit) return { ok: false };
    const mark = `afp-add-acc-${Date.now()}`;
    hit.setAttribute('data-afp-add-account', mark);
    hit.scrollIntoView?.({ block: 'center' });
    return { ok: true, mark };
  }, targetWeb.id);

  if (!added?.ok) {
    throw new Error('Endpoint đã mở nhưng không thấy nút Add Account visible.');
  }
  try {
    await page.click(`[data-afp-add-account="${added.mark}"]`);
  } catch {
    await page.evaluate((mark) => {
      document.querySelector(`[data-afp-add-account="${mark}"]`)?.click();
    }, added.mark);
  }

  let appeared = false;
  const waitUntil = Date.now() + 15000;
  while (Date.now() < waitUntil) {
    const info = await page.evaluate((webId, before) => {
      const root =
        document.getElementById(webId) ||
        document.querySelector(`#websContainer [id="${webId}"]`) ||
        document.body;

      const visibleInput = (el) => {
        if (!el || el.disabled) return false;
        if (el.type === 'hidden' || el.type === 'checkbox' || el.type === 'radio') return false;
        const st = window.getComputedStyle(el);
        if (st.display === 'none' || st.visibility === 'hidden') return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      };

      const labelCount = Array.from(
        root.querySelectorAll('label, .form-label, span, div, p, strong')
      ).filter((el) => {
        const st = window.getComputedStyle(el);
        if (st.display === 'none' || st.visibility === 'hidden') return false;
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) return false;
        const t = (el.childNodes?.[0]?.textContent || el.textContent || '')
          .replace(/\s+/g, ' ')
          .trim();
        return /^username\s*\*?$/i.test(t) && t.length < 24;
      }).length;

      const inputs = Array.from(root.querySelectorAll('input')).filter(visibleInput);
      const emptyText = inputs.filter(
        (el) => el.type !== 'password' && !String(el.value || '').trim()
      );

      let emptyNearUser = false;
      for (const lab of root.querySelectorAll('label, .form-label, span, div, p, strong')) {
        const t = (lab.textContent || '').replace(/\s+/g, ' ').trim();
        if (!/^username/i.test(t) || t.length > 30) continue;
        const r = lab.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) continue;
        const scope =
          lab.closest('.mb-3, .form-group, .col, .row, .form-floating, div') || lab.parentElement;
        const inp = scope && Array.from(scope.querySelectorAll('input')).find(visibleInput);
        if (inp && !String(inp.value || '').trim()) {
          emptyNearUser = true;
          break;
        }
      }

      return {
        labelCount,
        emptyText: emptyText.length,
        emptyNearUser,
        grew: labelCount > before,
        inputCount: inputs.length,
      };
    }, targetWeb.id, countBefore);

    if ((info.emptyNearUser || info.grew || info.emptyText > 0) && info.inputCount > 0) {
      appeared = true;
      log(
        info.grew
          ? `Đã thêm account mới (${countBefore} → ${info.labelCount}, inputs=${info.inputCount}).`
          : `Thấy form account trống (emptyNearUser=${info.emptyNearUser}, emptyInputs=${info.emptyText}, inputs=${info.inputCount}).`
      );
      break;
    }
    await sleepExact(300);
  }
  if (!appeared) {
    throw new Error(
      'Bấm Add Account rồi nhưng chưa thấy ô Username/Password visible trong Endpoint. Kiểm tra Endpoint 1 đã mở chưa.'
    );
  }
  await sleepExact(600);

  log('Điền Username, Password, Role=Editor, Notes="chủ tiệm" — CHỈ account mới...');

  const fieldIds = await page.evaluate(
    (webId, wantUser) => {
      const root =
        document.getElementById(webId) ||
        document.querySelector(`#websContainer [id="${webId}"]`) ||
        document.body;

      const visibleInput = (el) => {
        if (!el || el.disabled) return false;
        if (el.type === 'hidden' || el.type === 'checkbox' || el.type === 'radio') return false;
        const st = window.getComputedStyle(el);
        if (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity) === 0) return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      };

      const mark = (el, key) => {
        if (!el) return null;
        const id = `afp-wpm-${key}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        el.setAttribute('data-afp', id);
        el.scrollIntoView?.({ block: 'center' });
        return id;
      };

      const labelText = (el) =>
        (el.childNodes?.[0]?.textContent || el.textContent || '').replace(/\s+/g, ' ').trim();

      const findInBlock = (block, labelRe, opts = {}) => {
        const labs = Array.from(
          block.querySelectorAll('label, .form-label, span, div, p, strong, small')
        ).filter((el) => {
          const t = labelText(el);
          return labelRe.test(t) && t.length < 48;
        });
        for (const lab of labs) {
          let scope =
            lab.closest(
              '.mb-3, .form-group, .col-md-6, .col-md-4, .col, .row, .form-floating, .input-group'
            ) || lab.parentElement;
          for (let i = 0; i < 4 && scope && block.contains(scope); i += 1) {
            const fields = Array.from(scope.querySelectorAll('input, textarea, select')).filter(visibleInput);
            let hit = null;
            if (opts.select) hit = fields.find((el) => el.tagName === 'SELECT');
            else if (opts.textarea) {
              hit =
                fields.find((el) => el.tagName === 'TEXTAREA') ||
                fields.find((el) => /note/i.test(`${el.name || ''} ${el.id || ''} ${el.placeholder || ''}`));
            } else if (opts.password) {
              hit =
                fields.find((el) => el.type === 'password') ||
                fields.find((el) => /pass/i.test(`${el.name || ''} ${el.id || ''} ${el.placeholder || ''}`)) ||
                fields.find((el) => el.tagName === 'INPUT' && el.type !== 'checkbox');
            } else {
              hit =
                fields.find((el) => /user/i.test(`${el.name || ''} ${el.id || ''} ${el.placeholder || ''}`)) ||
                fields.find((el) => el.tagName === 'INPUT' && el.type !== 'password');
            }
            if (hit && block.contains(hit)) return hit;
            scope = scope.parentElement;
          }
        }
        return null;
      };

      const readPair = (block) => {
        const inputs = Array.from(block.querySelectorAll('input')).filter(visibleInput);
        const userEl =
          findInBlock(block, /^username/i) ||
          inputs.find((el) => /user/i.test(`${el.name || ''} ${el.id || ''}`)) ||
          inputs.find((el) => el.type !== 'password') ||
          null;
        let passEl =
          findInBlock(block, /^password/i, { password: true }) ||
          inputs.find((el) => /pass/i.test(`${el.name || ''} ${el.id || ''}`) || el.type === 'password');
        if (passEl && passEl === userEl) passEl = inputs.find((el) => el !== userEl) || null;
        if (!passEl && userEl) {
          const idx = inputs.indexOf(userEl);
          if (idx >= 0) passEl = inputs[idx + 1] || null;
        }
        return {
          userEl,
          passEl,
          userVal: String(userEl?.value || '').trim(),
          passVal: String(passEl?.value || '').trim(),
        };
      };

      const candidates = Array.from(
        root.querySelectorAll('.card, [class*="account"], .border, .row, section, div')
      ).filter((el) => {
        if (!root.contains(el)) return false;
        const t = el.innerText || '';
        if (t.length < 20 || t.length > 3500) return false;
        return /username/i.test(t) && (/password/i.test(t) || /account notes|role/i.test(t));
      });
      const blocks = candidates.filter(
        (el) => !candidates.some((other) => other !== el && el.contains(other))
      );

      const want = String(wantUser || '').trim().toLowerCase();
      let best = null;
      let bestScore = -1e9;
      const scored = [];
      for (let i = 0; i < blocks.length; i += 1) {
        const b = blocks[i];
        const { userVal, passVal } = readPair(b);
        let score = i * 2;
        if (!passVal) score += 80;
        if (!userVal) score += 50;
        if (want && userVal.toLowerCase() === want) score += 60;
        if (passVal) score -= 200;
        if (/^mac-admin$|^mac-tech$/i.test(userVal)) score -= 300;
        if (userVal && want && userVal.toLowerCase() !== want && passVal) score -= 150;
        scored.push({ i, userVal, passFilled: Boolean(passVal), score });
        if (score > bestScore) {
          bestScore = score;
          best = b;
        }
      }

      if (!best || bestScore < 0) {
        return {
          username: null,
          password: null,
          notes: null,
          role: null,
          blockCount: blocks.length,
          error: 'Không chọn được account mới — không sửa account cũ. scores=' + JSON.stringify(scored),
        };
      }

      const prefer = best;
      const pair = readPair(prefer);
      if (pair.passVal && pair.userVal && want && pair.userVal.toLowerCase() !== want) {
        return {
          username: null,
          password: null,
          notes: null,
          role: null,
          blockCount: blocks.length,
          error: 'Block chọn nhầm account cũ (' + pair.userVal + '). Không ghi đè.',
        };
      }

      const usernameEl = pair.userEl;
      const passwordEl = pair.passEl;
      const notesEl =
        findInBlock(prefer, /account notes/i, { textarea: true }) ||
        findInBlock(prefer, /^notes/i, { textarea: true }) ||
        Array.from(prefer.querySelectorAll('textarea')).find(visibleInput);
      const roleEl =
        findInBlock(prefer, /^role$/i, { select: true }) ||
        Array.from(prefer.querySelectorAll('select')).find((el) =>
          Array.from(el.options || []).some((o) => /editor|admin|tech/i.test(o.text || ''))
        );

      return {
        username: mark(usernameEl, 'user'),
        password: mark(passwordEl, 'pass'),
        notes: mark(notesEl, 'notes'),
        role: mark(roleEl, 'role'),
        blockCount: blocks.length,
        debug: {
          hasUser: !!usernameEl,
          hasPass: !!passwordEl,
          userVal: pair.userVal.slice(0, 40),
          passEmpty: !pair.passVal,
          score: bestScore,
        },
      };
    },
    targetWeb.id,
    account.username
  );

  if (fieldIds.error) {
    throw new Error(fieldIds.error);
  }

  if (fieldIds.error) {
    throw new Error(fieldIds.error);
  }

  if (!fieldIds.username || !fieldIds.password) {
    throw new Error(
      `Không tìm thấy ô Username/Password của account mới (user=${!!fieldIds.username}, pass=${!!fieldIds.password}, blocks=${fieldIds.blockCount}, passEmpty=${fieldIds.debug?.passEmpty}). Không sửa account cũ.`
    );
  }

  if (fieldIds.debug) {
    log(
      `Account block chọn: user="${fieldIds.debug.userVal || '(trống)'}", passEmpty=${fieldIds.debug.passEmpty}, score=${fieldIds.debug.score}`
    );
  }

  const userHandle = await page.$(`[data-afp="${fieldIds.username}"]`);
  const passHandle = await page.$(`[data-afp="${fieldIds.password}"]`);
  if (!userHandle || !passHandle) {
    throw new Error('Không gắn được handle Username/Password trên WPM.');
  }

  // Chặn ghi đè account cũ (mac-admin…)
  const guard = await page.evaluate(
    (userSel, passSel, want) => {
      const u = document.querySelector(`[data-afp="${userSel}"]`);
      const p = document.querySelector(`[data-afp="${passSel}"]`);
      const userVal = String(u?.value || '').trim();
      const passVal = String(p?.value || '').trim();
      const wantL = String(want || '').trim().toLowerCase();
      if (/^mac-admin$|^mac-tech$/i.test(userVal) && passVal) {
        return { ok: false, reason: `Đang trỏ vào account cũ ${userVal} — dừng.` };
      }
      if (userVal && wantL && userVal.toLowerCase() !== wantL && passVal) {
        return { ok: false, reason: `Đang trỏ vào account khác (${userVal}) đã có password — dừng.` };
      }
      return { ok: true, userVal, passEmpty: !passVal };
    },
    fieldIds.username,
    fieldIds.password,
    account.username
  );
  if (!guard.ok) {
    throw new Error(guard.reason);
  }

  await fillNative(page, userHandle, account.username);
  await fillNative(page, passHandle, account.password);

  // Notes "chủ tiệm" — bắt buộc trong cùng block account mới
  let notesOk = false;
  if (fieldIds.notes) {
    const notesHandle = await page.$(`[data-afp="${fieldIds.notes}"]`);
    if (notesHandle) {
      await fillNative(page, notesHandle, 'chủ tiệm');
      notesOk = true;
    }
  }
  if (!notesOk) {
    const notesMark = await page.evaluate((userSel) => {
      const u = document.querySelector(`[data-afp="${userSel}"]`);
      if (!u) return null;
      const block =
        u.closest('.card, [class*="account"], .border') ||
        u.closest('.row') ||
        u.parentElement?.parentElement?.parentElement;
      if (!block) return null;
      const visible = (el) => {
        if (!el) return false;
        const st = window.getComputedStyle(el);
        if (st.display === 'none' || st.visibility === 'hidden') return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      };
      const fields = Array.from(block.querySelectorAll('textarea, input:not([type="hidden"])')).filter(
        visible
      );
      let notes =
        fields.find((el) => el.tagName === 'TEXTAREA') ||
        fields.find((el) =>
          /note/i.test(`${el.name || ''} ${el.id || ''} ${el.placeholder || ''}`)
        );
      if (!notes) {
        // Label "Account Notes"
        for (const lab of block.querySelectorAll('label, span, div, p, small')) {
          const t = (lab.textContent || '').replace(/\s+/g, ' ').trim();
          if (!/account\s*notes|^notes$/i.test(t) || t.length > 40) continue;
          const scope = lab.closest('.mb-3, .form-group, .col, div') || lab.parentElement;
          notes = scope?.querySelector('textarea, input:not([type="hidden"])');
          if (notes && visible(notes)) break;
        }
      }
      if (!notes) return null;
      const id = `afp-wpm-notes-fb-${Date.now()}`;
      notes.setAttribute('data-afp', id);
      notes.scrollIntoView?.({ block: 'center' });
      return id;
    }, fieldIds.username);
    if (notesMark) {
      const notesHandle = await page.$(`[data-afp="${notesMark}"]`);
      if (notesHandle) {
        await fillNative(page, notesHandle, 'chủ tiệm');
        notesOk = true;
      }
    }
  }
  if (!notesOk) {
    log('⚠ Không tìm thấy ô Account Notes trong account mới — cần điền tay "chủ tiệm".');
  } else {
    log('Đã điền Account Notes = "chủ tiệm".');
  }

  let roleOk = false;
  if (fieldIds.role) {
    roleOk = await page.evaluate((sel) => {
      const roleEl = document.querySelector(`[data-afp="${sel}"]`);
      if (!roleEl) return false;
      if (roleEl.tagName === 'SELECT') {
        const opt = Array.from(roleEl.options).find(
          (o) => /editor/i.test((o.text || '').trim()) || /^editor$/i.test(o.value)
        );
        if (!opt) return false;
        roleEl.value = opt.value;
        roleEl.dispatchEvent(new Event('input', { bubbles: true }));
        roleEl.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      }
      return false;
    }, fieldIds.role);

    if (!roleOk) {
      roleOk = await page.evaluate((sel) => {
        const roleEl = document.querySelector(`[data-afp="${sel}"]`);
        const wrap = roleEl?.closest('div') || roleEl;
        wrap?.click();
        const opt = Array.from(
          document.querySelectorAll('li, option, .dropdown-item, [role="option"]')
        ).find((el) => /^editor$/i.test((el.textContent || '').trim()));
        if (opt) {
          opt.click();
          return true;
        }
        return false;
      }, fieldIds.role);
    }
  }
  log(`Đã điền form (role=${roleOk}, notes=${notesOk}). Lưu...`);

  // Đọc lại value vừa type (trước Submit) — xác nhận điền được
  const typedOk = await page.evaluate(
    (userSel, user) => {
      const el = document.querySelector(`[data-afp="${userSel}"]`);
      return el && String(el.value || '').trim() === user;
    },
    fieldIds.username,
    account.username
  );
  if (!typedOk) {
    log('⚠ Ô Username chưa giữ đúng giá trị sau khi type — vẫn Submit thử...');
  }

  const submitted = await page.evaluate(() => {
    const texts = [/^\s*submit\s*$/i, /^\s*save\s*$/i, /^\s*update\s*$/i, /^\s*create\s*$/i];
    const btns = Array.from(
      document.querySelectorAll('button, input[type="submit"], a.btn, [role="button"]')
    );
    for (const re of texts) {
      const hit = btns.find((el) => {
        const t = (el.innerText || el.value || el.textContent || '').replace(/\s+/g, ' ').trim();
        return re.test(t) && el.offsetParent !== null;
      });
      if (hit) {
        hit.scrollIntoView?.({ block: 'center' });
        hit.click();
        return (hit.innerText || hit.value || '').trim();
      }
    }
    return null;
  });

  if (submitted) {
    log(`Đã bấm "${submitted}" trên WPM (sync account).`);
  } else {
    try {
      await clickByText(page, 'Submit', { timeout: 2500 });
      log('Đã bấm Submit trên WPM (fallback).');
    } catch {
      log('⚠ Không thấy Submit/Save — WPM có thể tự lưu khi đổi field.');
    }
  }

  await sleepExact(2000);

  // Verify: reload tab Website Information rồi tìm username (kể cả input ẩn / text)
  const checkUserOnWpm = async () =>
    page.evaluate((user) => {
      const inInputs = Array.from(document.querySelectorAll('input, textarea')).some(
        (el) => String(el.value || '').trim() === user
      );
      const inText = (document.body?.innerText || '').includes(user);
      return inInputs || inText;
    }, account.username);

  let verified = await checkUserOnWpm();
  if (!verified) {
    log('Chưa thấy username trên form sau Submit — reload tab Website Information kiểm tra...');
    await openWebsiteInformationTab(page, projectUrl, log);
    await sleepExact(400);
    const again = await resolveTargetWeb(page, { mode: webTargetMode, preferUrl }, log);
    if (again?.id) {
      await focusOnlyWebCard(page, again.id, log);
      await sleepExact(400);
      await page.evaluate((webId) => {
        const root =
          document.getElementById(webId) ||
          document.querySelector(`#websContainer [id="${webId}"]`) ||
          document.body;
        const headers = Array.from(root.querySelectorAll('.card-header'));
        (headers[1] || headers[0])?.click();
      }, again.id);
      await sleepExact(600);
    }
    verified = await checkUserOnWpm();
  }

  if (verified) {
    log(`Đã sync tài khoản "${account.username}" lên WPM (Website Information).`);
    return;
  }

  // Đã Submit + đã điền — WP user tạo riêng ở bước trước; không fail cả job vì verify DOM WPM
  if (submitted || typedOk) {
    log(
      `⚠ Sau Submit chưa thấy "${account.username}" trên DOM WPM (có thể form đã đóng). ` +
        'Coi như đã sync — kiểm tra tay tab Website Information nếu cần.'
    );
    return;
  }

  throw new Error(
    `Không sync được account "${account.username}" lên WPM (chưa Submit / chưa thấy trên form).`
  );
}
