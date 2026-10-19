import {
  originOf,
  clickByText,
  sleep,
  sleepExact,
  dismissBlockingAlerts,
  evaluateSafe,
  clearUnloadGuard,
  withAcceptedDialogs,
} from '../utils.js';
import { isHttpStepsEnabled } from '../http/wpSession.js';

const GOTO = { waitUntil: 'domcontentloaded', timeout: 60000 };

const MAC_CORE_URLS = (base) => [
  `${base}/wp-admin/admin.php?page=mac-core`,
  `${base}/wp-admin/admin.php?page=mac_core`,
  `${base}/wp-admin/admin.php?page=maccore`,
  `${base}/wp-admin/admin.php?page=mac-core-dashboard`,
];

async function openMacCorePage(page, log) {
  const base = originOf(page.url());
  log('Mở Mac Core...');
  let opened = false;
  for (const url of MAC_CORE_URLS(base)) {
    await page.goto(url, GOTO).catch(() => {});
    await sleep(200);
    const ok = await evaluateSafe(page, () => {
      const t = (document.body?.innerText || '').toLowerCase();
      const title = (document.title || '').toLowerCase();
      return t.includes('mac core') || title.includes('mac core') || t.includes('mac-core');
    }).catch(() => false);
    if (ok) {
      opened = true;
      break;
    }
  }

  if (!opened) {
    log('Thử mở Mac Core từ menu sidebar...');
    const clicked = await evaluateSafe(page, () => {
      const links = Array.from(document.querySelectorAll('#adminmenu a, .wp-submenu a, a'));
      for (const a of links) {
        const t = (a.innerText || a.textContent || '').trim().toLowerCase();
        if (t === 'mac core' || t.includes('mac core')) {
          a.click();
          return true;
        }
      }
      return false;
    }).catch(() => false);
    if (clicked) {
      await page.waitForNavigation(GOTO).catch(() => {});
      await sleep(300);
      opened = true;
    }
  }

  if (!opened) {
    throw new Error('Không tìm thấy trang Mac Core. Kiểm tra plugin Mac Core đã active chưa.');
  }
  return base;
}

/** Nonce AJAX + link Activate từ DOM Mac Core. */
async function readMacCoreTokens(page) {
  return page.evaluate(() => {
    let ajaxNonce = '';
    for (const k of Object.keys(window)) {
      if (!/mac/i.test(k)) continue;
      const o = window[k];
      if (!o || typeof o !== 'object') continue;
      ajaxNonce =
        ajaxNonce ||
        o.nonce ||
        o._nonce ||
        o.ajaxNonce ||
        o.ajax_nonce ||
        (o.data && (o.data.nonce || o.data._nonce)) ||
        '';
    }
    if (!ajaxNonce) {
      for (const s of Array.from(document.querySelectorAll('script:not([src])'))) {
        const t = s.textContent || '';
        const m =
          t.match(/["']nonce["']\s*:\s*["']([a-f0-9]+)["']/i) ||
          t.match(/nonce["']?\s*[=:]\s*["']([a-f0-9]+)["']/i);
        if (m?.[1]) {
          ajaxNonce = m[1];
          break;
        }
      }
    }
    for (const el of Array.from(document.querySelectorAll('[data-nonce], [data-ajax-nonce]'))) {
      ajaxNonce =
        ajaxNonce ||
        el.getAttribute('data-nonce') ||
        el.getAttribute('data-ajax-nonce') ||
        '';
    }

    const act = Array.from(document.querySelectorAll('a[href]')).find((a) => {
      const h = a.getAttribute('href') || '';
      return /action=activate/i.test(h) && /mac-role|addon=mac-role/i.test(h);
    });
    let activateHref = '';
    let activateNonce = '';
    if (act) {
      try {
        const u = new URL(act.href, location.href);
        activateHref = u.href;
        activateNonce = u.searchParams.get('_wpnonce') || '';
      } catch {
        activateHref = act.href;
      }
    }

    const rowText = (() => {
      const titles = Array.from(
        document.querySelectorAll('h1,h2,h3,h4,h5,strong,.card-title,.addon-title,div,span')
      );
      for (const title of titles) {
        if (!/^mac\s*role$/i.test((title.textContent || '').trim())) continue;
        const row =
          title.closest('.card, .addon, .plugin-card, .col, article, li, tr, section') ||
          title.parentElement?.parentElement;
        return (row?.innerText || '').replace(/\s+/g, ' ');
      }
      return '';
    })();

    return {
      ajaxNonce,
      activateHref,
      activateNonce,
      alreadyActive: /installed\s*&\s*active/i.test(rowText),
      hasInstall: /install now/i.test(rowText),
      hasActivate: /\bactivate\b/i.test(rowText) && !/installed\s*&\s*active/i.test(rowText),
      ajaxurl: window.ajaxurl || '/wp-admin/admin-ajax.php',
    };
  });
}

async function macCoreAjax(page, fields) {
  return page.evaluate(async (fields) => {
    const ajaxurl = window.ajaxurl || '/wp-admin/admin-ajax.php';
    const body = new URLSearchParams(fields);
    const res = await fetch(ajaxurl, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        Accept: '*/*',
        'X-Requested-With': 'XMLHttpRequest',
      },
      body: body.toString(),
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* ignore */
    }
    return { status: res.status, ok: res.ok, text: text.slice(0, 3000), json };
  }, fields);
}

function macCoreSuccess(res) {
  if (!res) return false;
  if (res.json?.success === true || res.json?.success === 'true') return true;
  if (res.json?.data && res.status >= 200 && res.status < 300) return true;
  if (res.ok && /success|installed|activated/i.test(res.text || '')) return true;
  return false;
}

/**
 * HTTP: check status → install_plugin → GET activate (nonce từ DOM).
 */
export async function installMacRoleViaHttp(page, log) {
  // Dialog TRƯỚC goto — tránh treo "Leave site?" còn từ user-new.php
  return withAcceptedDialogs(
    page,
    async () => {
      await clearUnloadGuard(page);
      const base = await openMacCorePage(page, log);

      let tokens = await readMacCoreTokens(page);
      if (tokens.alreadyActive) {
        log('MAC Role đã Installed & Active (DOM) — bỏ qua HTTP install.');
        return { via: 'http', skipped: true };
      }

      if (!tokens.ajaxNonce) {
        throw new Error('Không lấy được nonce Mac Core trên trang (HTTP).');
      }
      log(`✓ Mac Core nonce OK (${tokens.ajaxNonce.slice(0, 6)}…)`);

      log('HTTP: check_install_status (mac-role)...');
      const statusRes = await macCoreAjax(page, {
        action: 'mac_core_check_install_status',
        nonce: tokens.ajaxNonce,
        plugin_slug: 'mac-role',
      });
      const statusData = statusRes.json?.data || {};
      // Chỉ tin boolean — KHÔNG regex JSON (chữ "installed"/"active" trong key cũng khớp).
      const installed =
        statusData.installed === true || statusData.is_installed === true;
      const active = statusData.active === true || statusData.is_active === true;
      log(
        `→ status: installed=${installed}, active=${active} | ${JSON.stringify(statusData).slice(0, 160)}`
      );

      if (!installed) {
        log('HTTP: mac_core_install_plugin...');
        const installRes = await macCoreAjax(page, {
          action: 'mac_core_install_plugin',
          nonce: tokens.ajaxNonce,
          plugin_slug: 'mac-role',
        });
        if (!macCoreSuccess(installRes)) {
          throw new Error(
            `Install HTTP fail (status ${installRes.status}): ${(installRes.text || '').slice(0, 180)}`
          );
        }
        log('✓ Install plugin OK (HTTP).');
        await sleepExact(800);
        await page.goto(MAC_CORE_URLS(base)[0], GOTO).catch(() => page.reload(GOTO));
        await sleepExact(600);
        tokens = await readMacCoreTokens(page);
      } else if (active || tokens.alreadyActive) {
        log('⏭ MAC Role đã cài & active — bỏ qua Install/Activate.');
        return { via: 'http', skipped: true };
      } else {
        log('⏭ Plugin đã cài — sang Activate.');
      }

      tokens = await readMacCoreTokens(page);
      if (tokens.alreadyActive) {
        log('MAC Role đã Active sau install.');
        return { via: 'http', skipped: false };
      }

      let activateUrl = tokens.activateHref;
      if (!activateUrl && tokens.activateNonce) {
        activateUrl = `${base}/wp-admin/admin.php?page=mac-core&action=activate&addon=mac-role&_wpnonce=${tokens.activateNonce}`;
      }
      if (!activateUrl) {
        await page.reload(GOTO);
        await sleep(400);
        tokens = await readMacCoreTokens(page);
        activateUrl = tokens.activateHref;
        if (!activateUrl && tokens.activateNonce) {
          activateUrl = `${base}/wp-admin/admin.php?page=mac-core&action=activate&addon=mac-role&_wpnonce=${tokens.activateNonce}`;
        }
      }
      if (!activateUrl) {
        throw new Error('Không tìm thấy URL Activate (addon=mac-role&_wpnonce=...).');
      }

      log(`HTTP: Activate GET …action=activate&addon=mac-role…`);
      await page.goto(activateUrl, GOTO);
      await sleepExact(800);
      await page.goto(MAC_CORE_URLS(base)[0], GOTO).catch(() => {});
      await sleep(400);
      tokens = await readMacCoreTokens(page);
      if (tokens.alreadyActive || !tokens.hasActivate) {
        log('✓ Activate MAC Role OK (HTTP).');
      } else {
        log(
          '⚠ Sau Activate chưa thấy Installed & Active — vẫn tiếp tục (menu có thể hiện sau).'
        );
      }
      return { via: 'http', skipped: false };
    },
    log
  );
}

/**
 * Mac Role qua Mac Core (Chrome click — fallback).
 */
export async function installMacRoleViaBrowser(page, log) {
  return withAcceptedDialogs(
    page,
    async () => {
      await clearUnloadGuard(page);
      const base = await openMacCorePage(page, log);
      const macCoreUrls = MAC_CORE_URLS(base);

      log('Bấm Refresh Plugin List...');
      let refreshed = false;
      for (const label of [
        'Refresh Plugin List',
        'Refresh Plugins List',
        'Refresh plugin list',
      ]) {
        try {
          await clickByText(page, label, { timeout: 4000 });
          refreshed = true;
          break;
        } catch {
          /* next */
        }
      }
      if (!refreshed) {
        refreshed = await evaluateSafe(page, () => {
          const btn = Array.from(
            document.querySelectorAll('button, a, input[type="button"]')
          ).find((el) => /refresh\s+plugin\s*list/i.test((el.innerText || el.value || '').trim()));
          if (btn) {
            btn.click();
            return true;
          }
          return false;
        }).catch(() => false);
      }
      if (!refreshed) {
        throw new Error('Không tìm thấy nút "Refresh Plugin List" trên Mac Core.');
      }

      log('Chờ OK alert + page reload sau Refresh...');
      await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
      await sleep(600);

      const stillMacCore = await evaluateSafe(page, () =>
        /mac core/i.test(`${document.title} ${document.body?.innerText || ''}`)
      ).catch(() => false);
      if (!stillMacCore) {
        await page.goto(macCoreUrls[0], GOTO);
        await sleep(300);
      }

      log('Tìm MAC Role → Install Now...');
      const installState = await clickMacRoleButton(page, 'install');
      if (installState === 'already-active') {
        log('MAC Role đã Installed & Active.');
        return;
      }
      if (installState === 'need-activate') {
        log('MAC Role đã cài — sẽ Activate sau reload.');
      } else if (!installState) {
        throw new Error('Không tìm thấy MAC Role / nút Install Now sau khi Refresh.');
      } else {
        log('Đã bấm Install Now cho MAC Role.');
      }

      log('Chờ OK alert (nếu có) + reload page sau Install...');
      await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 90000 }).catch(() => {});
      await sleep(700);

      if (
        !(await evaluateSafe(page, () =>
          /mac core/i.test(document.title + (document.body?.innerText || ''))
        ).catch(() => false))
      ) {
        await page.goto(macCoreUrls[0], GOTO);
        await sleep(300);
      } else {
        log('Reload Mac Core trước khi Activate...');
        await page.reload(GOTO);
        await sleep(400);
      }

      log('Activate MAC Role...');
      const actState = await clickMacRoleButton(page, 'activate');
      if (actState === 'already-active') {
        log('MAC Role đã Active.');
      } else if (!actState) {
        throw new Error('Không tìm thấy nút Activate cho MAC Role sau Install + reload.');
      } else {
        log('Đã bấm Activate MAC Role.');
        await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
        await sleep(400);
      }

      log('Reload để hiện menu Mac Role...');
      await page.reload(GOTO);
      await sleep(400);
    },
    log
  );
}

async function clickMacRoleButton(page, mode) {
  return evaluateSafe(
    page,
    (modeInner) => {
      const titles = Array.from(
        document.querySelectorAll('h1,h2,h3,h4,h5,strong,.card-title,.addon-title,div,span')
      );
      for (const title of titles) {
        if (!/^mac\s*role$/i.test((title.textContent || '').trim())) continue;
        const row =
          title.closest('.card, .addon, .plugin-card, .col, article, li, tr, section') ||
          title.parentElement?.parentElement;
        if (!row) continue;
        const text = row.innerText || '';
        if (/installed\s*&\s*active/i.test(text)) return 'already-active';

        if (modeInner === 'install') {
          const install = Array.from(row.querySelectorAll('a, button')).find((el) =>
            /install now|^install$/i.test((el.innerText || '').trim())
          );
          if (install) {
            install.click();
            return 'install';
          }
          const act = Array.from(row.querySelectorAll('a, button')).find((el) =>
            /^activate$/i.test((el.innerText || '').trim())
          );
          if (act) return 'need-activate';
        }

        if (modeInner === 'activate') {
          const act = Array.from(row.querySelectorAll('a, button')).find(
            (el) =>
              /^activate$/i.test((el.innerText || '').trim()) ||
              /activate plugin/i.test((el.innerText || '').trim())
          );
          if (act) {
            act.click();
            return 'activate';
          }
        }
      }
      return null;
    },
    mode
  );
}

/** @param {string} packageTier */
function templateIdForTier(packageTier) {
  const t = String(packageTier || 'F').trim().toUpperCase();
  if (t === 'F') return 'f_package_user';
  // fallback phổ biến
  return `${t.toLowerCase()}_package_user`;
}

async function readMacRoleCreateNonce(page, templateId) {
  return page.evaluate((wantTemplate) => {
    let nonce = '';
    for (const k of Object.keys(window)) {
      if (!/rud|mac.?role|role/i.test(k)) continue;
      const o = window[k];
      if (!o || typeof o !== 'object') continue;
      nonce = nonce || o.nonce || o._nonce || o.ajaxNonce || '';
    }
    if (!nonce) {
      for (const s of Array.from(document.querySelectorAll('script:not([src])'))) {
        const t = s.textContent || '';
        if (!/rud_apply_template|f_package_user|nonce/i.test(t)) continue;
        const m =
          t.match(/["']nonce["']\s*:\s*["']([a-f0-9]+)["']/i) ||
          t.match(/nonce["']?\s*[=:]\s*["']([a-f0-9]+)["']/i);
        if (m?.[1]) {
          nonce = m[1];
          break;
        }
      }
    }
    for (const el of Array.from(
      document.querySelectorAll('[data-nonce], [data-template-id], [data-template]')
    )) {
      nonce = nonce || el.getAttribute('data-nonce') || '';
      const tid = el.getAttribute('data-template-id') || el.getAttribute('data-template') || '';
      if (tid && tid === wantTemplate && el.getAttribute('data-nonce')) {
        nonce = el.getAttribute('data-nonce');
      }
    }
    const hasCreateBtn = Array.from(
      document.querySelectorAll('a, button, input[type="button"], input[type="submit"]')
    ).some((el) =>
      /create from\s*["']?f[\s-]*package\s*user["']?/i.test(
        (el.innerText || el.value || el.textContent || '').trim()
      )
    );
    return { nonce, hasCreateBtn, ajaxurl: window.ajaxurl || '/wp-admin/admin-ajax.php' };
  }, templateId);
}

/**
 * HTTP: POST rud_apply_template (template_id=f_package_user).
 */
export async function configureFPackageUserViaHttp(page, packageTier = 'F', log) {
  const base = originOf(page.url());
  const url = `${base}/wp-admin/admin.php?page=mac-role`;
  const templateId = templateIdForTier(packageTier);

  const onDialog = async (dialog) => {
    const msg = dialog.message() || '';
    log(`Mac Role dialog: "${msg.slice(0, 120)}" → OK`);
    try {
      await dialog.accept();
    } catch {
      /* ignore */
    }
  };
  page.on('dialog', onDialog);

  try {
    log(`Mở Mac Role (HTTP): ${url.replace(base, '')}`);
    await page.goto(url, GOTO);
    await sleep(400);
    await dismissBlockingAlerts(page, log);

    const tokens = await readMacRoleCreateNonce(page, templateId);
    if (!tokens.hasCreateBtn) {
      const bodyHint = await evaluateSafe(page, () => {
        const body = (document.body?.innerText || '').replace(/\s+/g, ' ');
        return /f\s*package\s*user/i.test(body);
      }).catch(() => false);
      if (bodyHint) {
        log('F Package User đã có sẵn — bỏ qua Create (HTTP).');
        return { via: 'http', skipped: true };
      }
    }

    if (!tokens.nonce) {
      throw new Error('Không lấy được nonce rud_apply_template trên Mac Role.');
    }
    log(`HTTP: rud_apply_template (${templateId})...`);

    const res = await page.evaluate(
      async (payload) => {
        const body = new URLSearchParams();
        body.set('action', 'rud_apply_template');
        body.set('nonce', payload.nonce);
        body.set('template_id', payload.templateId);
        const res = await fetch(payload.ajaxurl, {
          method: 'POST',
          credentials: 'include',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
            Accept: '*/*',
            'X-Requested-With': 'XMLHttpRequest',
          },
          body: body.toString(),
        });
        const text = await res.text();
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {
          /* ignore */
        }
        return { status: res.status, ok: res.ok, text: text.slice(0, 3000), json };
      },
      { nonce: tokens.nonce, templateId, ajaxurl: tokens.ajaxurl }
    );

    const ok =
      res.json?.success === true ||
      res.json?.success === 'true' ||
      (res.ok && /success|created|applied|ok/i.test(res.text || ''));
    if (!ok) {
      throw new Error(
        `Create F HTTP fail (status ${res.status}): ${(res.text || '').slice(0, 180)}`
      );
    }
    log('✓ rud_apply_template OK — chờ WP settle...');

    // Chờ xử lý sau apply (cài plugin / reload)
    const started = Date.now();
    let lastBeat = 0;
    while (Date.now() - started < 75000) {
      const elapsed = Math.round((Date.now() - started) / 1000);
      if (elapsed >= 5 && elapsed - lastBeat >= 5) {
        lastBeat = elapsed;
        log(`… Mac Role vẫn đang xử lý Create HTTP (${elapsed}s)`);
      }
      await sleep(800);
      const state = await evaluateSafe(page, () => {
        const busy = !!document.querySelector(
          '.spinner.is-active, .updating-message, .is-loading'
        );
        const text = (document.body?.innerText || '').replace(/\s+/g, ' ');
        const stillCreateBtn = Array.from(
          document.querySelectorAll('a, button, input[type="button"]')
        ).some((el) =>
          /create from\s*["']?f[\s-]*package\s*user["']?/i.test(
            (el.innerText || el.value || '').trim()
          )
        );
        return {
          busy,
          stillCreateBtn,
          okHint: /created|updated|role saved|success|applied/i.test(text),
        };
      }).catch(() => null);

      if (state?.okHint) break;
      if (state && !state.busy && !state.stillCreateBtn && elapsed >= 3) break;
      // Reload nhẹ để thấy trạng thái mới
      if (elapsed === 8 || elapsed === 20) {
        await page.reload(GOTO).catch(() => {});
      }
    }

    log('Chờ WordPress ổn định sau Create (plugin có thể còn cài)...');
    for (let i = 0; i < 8; i += 1) {
      await sleepExact(1000);
      const loading = await evaluateSafe(page, () => {
        const t = (document.body?.innerText || '').toLowerCase();
        return (
          /đang tạo|installing|activating|please wait|updating plugins/i.test(t) ||
          !!document.querySelector('.updating-message, .spinner.is-active')
        );
      }).catch(() => false);
      if (!loading) break;
      if (i % 2 === 1) log(`… vẫn chờ plugin/Mac Role settle (${i + 1}s)`);
    }
    await page
      .goto(`${base}/wp-admin/`, { waitUntil: 'domcontentloaded', timeout: 60000 })
      .catch(() => {});
    await sleepExact(800);
    log('Mac Role: F Package User đã tạo xong (HTTP).');
    return { via: 'http', skipped: false };
  } finally {
    page.off('dialog', onDialog);
  }
}

/**
 * Chrome: Create from F Package User (fallback).
 */
export async function configureFPackageUserViaBrowser(page, packageTier = 'F', log) {
  const base = originOf(page.url());
  const url = `${base}/wp-admin/admin.php?page=mac-role`;

  const withTimeout = (promise, ms, label) =>
    Promise.race([
      promise,
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error(`Timeout ${ms}ms: ${label}`)), ms);
      }),
    ]);

  const onDialog = async (dialog) => {
    const msg = dialog.message() || '';
    log(`Mac Role dialog: "${msg.slice(0, 120)}" → OK`);
    try {
      await dialog.accept();
    } catch {
      /* ignore */
    }
  };
  page.on('dialog', onDialog);

  try {
    log(`Mở Mac Role: ${url.replace(base, '')}`);
    await page.goto(url, GOTO);
    await sleep(400);
    await dismissBlockingAlerts(page, log);

    const onPage = await evaluateSafe(page, () => {
      const t = (document.body?.innerText || '').toLowerCase();
      return (
        t.includes('role url links') ||
        t.includes('quick create from template') ||
        t.includes('f package user') ||
        t.includes('mac role')
      );
    }).catch(() => false);

    if (!onPage) {
      const menuClicked = await evaluateSafe(page, () => {
        const hit = Array.from(document.querySelectorAll('#adminmenu a, a')).find((a) =>
          /mac role|role url/i.test((a.textContent || '').trim())
        );
        if (hit) {
          hit.click();
          return true;
        }
        return false;
      }).catch(() => false);
      if (menuClicked) {
        await page.waitForNavigation(GOTO).catch(() => {});
        await sleep(300);
      }
    }

    const alreadyDone = await evaluateSafe(page, () => {
      const body = (document.body?.innerText || '').replace(/\s+/g, ' ');
      const hasCreateBtn = Array.from(
        document.querySelectorAll('a, button, input[type="button"], input[type="submit"]')
      ).some((el) =>
        /create from\s*["']?f[\s-]*package\s*user["']?/i.test(
          (el.innerText || el.value || el.textContent || '').trim()
        )
      );
      if (!hasCreateBtn && /f\s*package\s*user/i.test(body)) return true;
      if (
        !/quick create from template/i.test(body) &&
        /f\s*package\s*user/i.test(body) &&
        /role url|capabilities|edit role/i.test(body)
      ) {
        return true;
      }
      return false;
    }).catch(() => false);

    if (alreadyDone) {
      log('F Package User đã có sẵn — bỏ qua Create.');
      return;
    }

    log('Bấm Create from "F Package User"...');

    const clickResult = await evaluateSafe(page, () => {
      const btns = Array.from(
        document.querySelectorAll(
          'a, button, input[type="button"], input[type="submit"], [role="button"], .button'
        )
      );
      const hit = btns.find((el) =>
        /create from\s*["']?f[\s-]*package\s*user["']?/i.test(
          (el.innerText || el.value || el.textContent || '').trim()
        )
      );
      if (!hit) {
        const loose = btns.find((el) => {
          const t = (el.innerText || el.value || el.textContent || '').replace(/\s+/g, ' ').trim();
          return /create from/i.test(t) && /package/i.test(t) && /user/i.test(t);
        });
        if (!loose) return { ok: false, reason: 'no-button' };
        loose.scrollIntoView?.({ block: 'center' });
        loose.click();
        return { ok: true, label: (loose.innerText || loose.value || '').trim().slice(0, 80) };
      }
      hit.scrollIntoView?.({ block: 'center' });
      hit.click();
      return { ok: true, label: (hit.innerText || hit.value || '').trim().slice(0, 80) };
    }).catch((err) => {
      const msg = err?.message || String(err);
      if (/Execution context was destroyed|Cannot find context|navigat/i.test(msg)) {
        return { ok: true, label: 'Create (navigated)', navigated: true };
      }
      return { ok: false, reason: msg };
    });

    if (!clickResult?.ok) {
      let fallbackOk = false;
      for (const label of [
        `Create from "${packageTier} Package User"`,
        'Create from "F Package User"',
        'Create from "F-Package User"',
        'Create from F Package User',
      ]) {
        try {
          log(`Thử click text: ${label}`);
          await withTimeout(clickByText(page, label, { timeout: 4000 }), 6000, `click ${label}`);
          fallbackOk = true;
          break;
        } catch (e) {
          log(`⚠ ${e?.message || e}`);
        }
      }
      if (!fallbackOk) {
        throw new Error(
          `Không tìm thấy / click được Create from "F Package User" (${clickResult?.reason || '?'}).`
        );
      }
      log('Đã bấm Create (fallback text).');
    } else {
      log(`Đã bấm "${clickResult.label || 'Create'}" — chờ Mac Role xử lý...`);
    }

    const started = Date.now();
    let lastBeat = 0;
    const navWait = page
      .waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 75000 })
      .then(() => 'nav')
      .catch(() => null);

    while (Date.now() - started < 75000) {
      const elapsed = Math.round((Date.now() - started) / 1000);
      if (elapsed >= 5 && elapsed - lastBeat >= 5) {
        lastBeat = elapsed;
        log(`… Mac Role vẫn đang xử lý Create (${elapsed}s)`);
      }

      const raced = await Promise.race([navWait, sleep(800).then(() => 'tick')]);
      if (raced === 'nav') {
        log('Mac Role đã reload sau Create.');
        break;
      }

      const state = await evaluateSafe(page, () => {
        const busy = !!document.querySelector(
          '.spinner.is-active, .updating-message, .is-loading, .notice-success'
        );
        const text = (document.body?.innerText || '').replace(/\s+/g, ' ');
        const stillCreateBtn = Array.from(
          document.querySelectorAll('a, button, input[type="button"]')
        ).some((el) =>
          /create from\s*["']?f[\s-]*package\s*user["']?/i.test(
            (el.innerText || el.value || '').trim()
          )
        );
        return {
          busy,
          stillCreateBtn,
          okHint: /created|updated|role saved|success|new user created/i.test(text),
        };
      }).catch(() => null);

      if (state?.okHint) {
        log('Thấy thông báo success trên Mac Role.');
        break;
      }
      if (state && !state.busy && !state.stillCreateBtn && elapsed >= 4) {
        log('Nút Create đã biến mất — coi như F Package User đã tạo.');
        break;
      }
    }

    await sleep(800);
    log('Chờ WordPress ổn định sau Create (plugin có thể còn cài)...');
    for (let i = 0; i < 8; i += 1) {
      await sleepExact(1000);
      const loading = await evaluateSafe(page, () => {
        const t = (document.body?.innerText || '').toLowerCase();
        return (
          /đang tạo|installing|activating|please wait|updating plugins/i.test(t) ||
          !!document.querySelector('.updating-message, .spinner.is-active')
        );
      }).catch(() => false);
      if (!loading) break;
      if (i % 2 === 1) log(`… vẫn chờ plugin/Mac Role settle (${i + 1}s)`);
    }
    await page
      .goto(`${base}/wp-admin/`, { waitUntil: 'domcontentloaded', timeout: 60000 })
      .catch(() => {});
    await sleepExact(800);
    log('Mac Role: F Package User đã tạo xong.');
  } finally {
    page.off('dialog', onDialog);
  }
}

/**
 * Mac Core → cài + Activate Mac Role.
 * 2.1: HTTP ưu tiên, fallback Chrome.
 */
export async function installMacRoleViaMacCore(page, log) {
  // Phase 1: thử REST (helper tải từ CRM giống Mac Core)
  if (isHttpStepsEnabled()) {
    try {
      const { getRestAuth, callHelper } = await import('../http/helperClient.js');
      const { originOf } = await import('../utils.js');
      const base = originOf(page.url());
      const auth = await getRestAuth(page, base);
      log('Cài Mac Role qua REST (từ CRM)...');
      const wpmBase = String(process.env.WPM_BASE || 'https://wpm.macusaone.com').replace(/\/+$/, '');
      const res = await callHelper(base, auth, '/mac-role/install-from-crm', { slug: 'mac-role', wpm_base: wpmBase });
      if (res.skipped) {
        log(`⏭ Mac Role đã ${res.reason === 'already_active' ? 'cài & active' : 'cài'} — bỏ qua.`);
      } else {
        log(`✓ Đã cài Mac Role từ CRM (${res.via}).`);
      }
      return;
    } catch (err) {
      log(`⚠ REST cài Mac Role thất bại (${(err?.message || '').slice(0, 120)}) — thử HTTP/DOM...`);
    }
  }
  if (isHttpStepsEnabled()) {
    try {
      await installMacRoleViaHttp(page, log);
      return;
    } catch (err) {
      const msg = err?.message || String(err);
      log(`⚠ HTTP Mac Core thất bại (${msg.slice(0, 160)}) — fallback Chrome...`);
      await installMacRoleViaBrowser(page, log);
      return;
    }
  }
  await installMacRoleViaBrowser(page, log);
}

/**
 * Sau Create F: vào Mac Role Settings → bật Grant WordPress capabilities for allowed URLs → Save.
 * HTTP/DOM ưu tiên, Chrome fallback.
 */
async function enableGrantWpCapabilitiesViaHttp(page, base, log) {
  const url = `${base}/wp-admin/admin.php?page=mac-role-settings`;
  log(`HTTP: Mac Role Settings — bật Grant WP capabilities... (${url.replace(base, '')})`);
  await page.goto(url, GOTO);
  await sleep(500);
  await dismissBlockingAlerts(page, log);

  const result = await evaluateSafe(page, async () => {
    const bodyText = document.body?.innerText || '';
    if (!/mac\s*role|grant\s*wordpress\s*capabilities|allowed\s*urls/i.test(bodyText)) {
      return { ok: false, reason: 'not-settings-page' };
    }

    const norm = (s) =>
      String(s || '')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();

    const needle = 'grant wordpress capabilities for allowed urls';
    let checkbox = null;

    // 1) label text khớp
    for (const lab of Array.from(document.querySelectorAll('label'))) {
      if (norm(lab.textContent).includes(needle)) {
        checkbox =
          lab.control ||
          (lab.getAttribute('for') ? document.getElementById(lab.getAttribute('for')) : null) ||
          lab.querySelector('input[type="checkbox"]');
        if (checkbox) break;
      }
    }

    // 2) gần text node
    if (!checkbox) {
      const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
      let n;
      while ((n = walk.nextNode())) {
        if (!n.matches?.('label, th, td, span, div, p, li')) continue;
        if ((n.children?.length || 0) > 6) continue;
        if (!norm(n.textContent).includes(needle)) continue;
        const row = n.closest('tr, .form-field, .form-group, .mb-3, .row, label') || n.parentElement;
        checkbox = row?.querySelector('input[type="checkbox"]');
        if (checkbox) break;
      }
    }

    // 3) name/id gợi ý
    if (!checkbox) {
      checkbox =
        document.querySelector(
          'input[type="checkbox"][name*="grant" i], input[type="checkbox"][id*="grant" i], input[type="checkbox"][name*="capabilit" i], input[type="checkbox"][name*="allowed_url" i]'
        ) || null;
    }

    if (!checkbox) return { ok: false, reason: 'no-checkbox' };

    const already = Boolean(checkbox.checked);
    if (!already) {
      checkbox.checked = true;
      checkbox.dispatchEvent(new Event('input', { bubbles: true }));
      checkbox.dispatchEvent(new Event('change', { bubbles: true }));
      checkbox.click?.();
      if (!checkbox.checked) checkbox.checked = true;
    }

    // Save: submit form hoặc nút Save/Update
    const form = checkbox.closest('form') || document.querySelector('form');
    const saveBtn =
      form?.querySelector(
        'input[type="submit"], button[type="submit"], button.button-primary, input.button-primary'
      ) ||
      Array.from(document.querySelectorAll('button, input[type="submit"], input[type="button"]')).find(
        (el) => /^(save|update|submit|lưu)$/i.test((el.innerText || el.value || '').trim())
      );

    if (form && typeof form.requestSubmit === 'function' && saveBtn) {
      form.requestSubmit(saveBtn);
    } else if (saveBtn) {
      saveBtn.click();
    } else if (form) {
      form.submit();
    } else {
      return { ok: false, reason: 'no-save', already };
    }

    return { ok: true, already, name: checkbox.name || checkbox.id || '' };
  });

  if (!result?.ok) {
    throw new Error(`Grant caps HTTP: ${result?.reason || 'unknown'}`);
  }

  await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
  await sleep(500);

  // Verify still checked
  await page.goto(url, GOTO).catch(() => {});
  await sleep(400);
  const verified = await evaluateSafe(page, () => {
    const needle = 'grant wordpress capabilities for allowed urls';
    const norm = (s) =>
      String(s || '')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
    for (const lab of Array.from(document.querySelectorAll('label'))) {
      if (!norm(lab.textContent).includes(needle)) continue;
      const cb =
        lab.control ||
        (lab.getAttribute('for') ? document.getElementById(lab.getAttribute('for')) : null) ||
        lab.querySelector('input[type="checkbox"]');
      if (cb) return Boolean(cb.checked);
    }
    const cb = document.querySelector(
      'input[type="checkbox"][name*="grant" i], input[type="checkbox"][id*="grant" i], input[type="checkbox"][name*="capabilit" i]'
    );
    return cb ? Boolean(cb.checked) : null;
  });

  if (verified === false) {
    throw new Error('Grant caps đã Save nhưng checkbox vẫn tắt sau reload.');
  }
  log(
    result.already
      ? '✓ Grant WordPress capabilities… đã bật sẵn (HTTP).'
      : '✓ Đã bật Grant WordPress capabilities for allowed URLs + Save (HTTP).'
  );
  return { via: 'http', already: Boolean(result.already) };
}

async function enableGrantWpCapabilitiesViaBrowser(page, base, log) {
  const url = `${base}/wp-admin/admin.php?page=mac-role-settings`;
  log('Chrome: Mac Role Settings — bật Grant WP capabilities...');
  await page.goto(url, GOTO);
  await sleep(500);
  await dismissBlockingAlerts(page, log);

  const toggled = await page.evaluate(() => {
    const needle = 'grant wordpress capabilities for allowed urls';
    const norm = (s) =>
      String(s || '')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
    for (const lab of Array.from(document.querySelectorAll('label'))) {
      if (!norm(lab.textContent).includes(needle)) continue;
      const cb =
        lab.control ||
        (lab.getAttribute('for') ? document.getElementById(lab.getAttribute('for')) : null) ||
        lab.querySelector('input[type="checkbox"]');
      if (!cb) continue;
      if (!cb.checked) cb.click();
      return { ok: true, checked: cb.checked };
    }
    const cb = document.querySelector(
      'input[type="checkbox"][name*="grant" i], input[type="checkbox"][name*="capabilit" i]'
    );
    if (cb) {
      if (!cb.checked) cb.click();
      return { ok: true, checked: cb.checked };
    }
    return { ok: false };
  });

  if (!toggled?.ok) {
    throw new Error('Chrome: không tìm thấy checkbox Grant WordPress capabilities…');
  }

  try {
    await clickByText(page, 'Save', { exact: true, timeout: 4000 });
  } catch {
    await clickByText(page, 'Update', { exact: true, timeout: 3000 }).catch(() =>
      page.evaluate(() => {
        document.querySelector('input[type="submit"], button[type="submit"]')?.click();
      })
    );
  }
  await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
  await sleep(400);
  log('✓ Đã bật Grant WordPress capabilities for allowed URLs + Save (Chrome).');
  return { via: 'browser' };
}

export async function enableGrantWpCapabilitiesForAllowedUrls(page, log) {
  const base = originOf(page.url());
  if (!base) throw new Error('Không xác định origin WP cho Mac Role Settings.');

  // Phase 1: thử REST trước
  if (isHttpStepsEnabled()) {
    try {
      const { getRestAuth, callHelper } = await import('../http/helperClient.js');
      const auth = await getRestAuth(page, base);
      log('Bật Grant WP capabilities qua REST...');
      const res = await callHelper(base, auth, '/mac-role/grant-capabilities', {});
      if (res.ok) {
        log(`✓ Đã bật Grant WP capabilities (option ${res.option}, key ${res.key}).`);
        return { via: 'rest', ...res };
      }
      log(`⚠ REST grant caps: ${res.reason || res.note} — thử HTTP/DOM...`);
    } catch (err) {
      log(`⚠ REST grant caps thất bại (${(err?.message || '').slice(0, 120)}) — thử HTTP/DOM...`);
    }
  }

  if (isHttpStepsEnabled()) {
    try {
      return await enableGrantWpCapabilitiesViaHttp(page, base, log);
    } catch (err) {
      log(
        `⚠ Grant caps HTTP fail — fallback Chrome: ${String(err?.message || err).slice(0, 140)}`
      );
    }
  }
  return enableGrantWpCapabilitiesViaBrowser(page, base, log);
}

/**
 * Mac Role → Create F Package User.
 * 2.1: HTTP rud_apply_template, fallback Chrome.
 * Sau Create: bật Grant WordPress capabilities for allowed URLs.
 */
export async function configureFPackageUser(page, packageTier = 'F', log) {
  // Phase 1: thử REST trước
  if (isHttpStepsEnabled()) {
    try {
      const { getRestAuth, callHelper } = await import('../http/helperClient.js');
      const base = originOf(page.url());
      const auth = await getRestAuth(page, base);
      log('Apply Mac Role template qua REST...');
      const res = await callHelper(base, auth, '/mac-role/apply-template', {
        template_id: `${packageTier.toLowerCase()}_package_user`,
      });
      log(`✓ Đã apply template "${res.template_id}" (${res.via || 'ok'})`);
    } catch (err) {
      log(`⚠ REST Mac Role thất bại (${(err?.message || '').slice(0, 120)}) — thử HTTP/DOM...`);
      try {
        await configureFPackageUserViaHttp(page, packageTier, log);
      } catch (err2) {
        const msg = err2?.message || String(err2);
        log(`⚠ HTTP Create F thất bại (${msg.slice(0, 160)}) — fallback Chrome...`);
        await configureFPackageUserViaBrowser(page, packageTier, log);
      }
    }
  } else {
    await configureFPackageUserViaBrowser(page, packageTier, log);
  }

  try {
    await enableGrantWpCapabilitiesForAllowedUrls(page, log);
  } catch (err) {
    log(
      `⚠ Không bật được Grant WP capabilities (${String(err?.message || err).slice(0, 140)}) — kiểm tra tay Mac Role → Settings.`
    );
  }
}
