import {
  originOf,
  sleep,
  sleepExact,
  clickByText,
  dismissBlockingAlerts,
  waitForAnyText,
  gotoWithRetry,
} from '../utils.js';
import { isHttpStepsEnabled } from '../http/wpSession.js';

const GOTO = { waitUntil: 'domcontentloaded', timeout: 60000 };

/** Tìm select theo label JetEngine (.cx-vui-component). */
async function findSelectByLabel(page, labelText) {
  return page.evaluate((labelText) => {
    const want = labelText.toLowerCase();
    const comps = Array.from(
      document.querySelectorAll('.cx-vui-component, .cx-vui-component--equalwidth')
    );
    for (const comp of comps) {
      const label = (
        comp.querySelector('.cx-vui-component__label, label.cx-vui-component__label, label')
          ?.textContent || ''
      )
        .trim()
        .toLowerCase();
      if (label !== want) continue;
      const sel = comp.querySelector('select.cx-vui-select, select');
      if (!sel) return null;
      const id = `afp-je-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      sel.setAttribute('data-afp', id);
      sel.scrollIntoView?.({ block: 'center' });
      const opt = sel.options[sel.selectedIndex];
      return {
        id,
        value: sel.value,
        text: (opt?.text || '').trim(),
        options: Array.from(sel.options)
          .slice(0, 30)
          .map((o) => ({ value: o.value, text: (o.text || '').trim() })),
      };
    }
    return null;
  }, labelText);
}

/**
 * Đổi select JetEngine/Vue: native setter + emit Vue + Event.
 * valueOr: string | { empty: true } | { value } | { text }
 */
async function setCxSelect(page, labelText, valueOr) {
  const found = await findSelectByLabel(page, labelText);
  if (!found) return { ok: false, error: `không thấy select "${labelText}"` };

  const result = await page.evaluate(
    (dataAfp, valueOr, labelHint) => {
      const sel = document.querySelector(`select[data-afp="${dataAfp}"]`);
      if (!sel) return { ok: false, error: 'mất select sau khi đánh dấu' };

      let value = '';
      if (valueOr && typeof valueOr === 'object') {
        if (valueOr.empty) {
          value = '';
        } else if (valueOr.value != null) {
          value = String(valueOr.value);
        } else if (valueOr.text) {
          const opt = Array.from(sel.options).find((o) =>
            new RegExp(`^${valueOr.text}$`, 'i').test((o.text || '').trim())
          );
          if (!opt) {
            return {
              ok: false,
              error: `không có option text="${valueOr.text}"`,
              options: Array.from(sel.options).map((o) => `${o.value}:${o.text}`).slice(0, 20),
            };
          }
          value = opt.value;
        }
      } else {
        value = String(valueOr ?? '');
      }

      const before = sel.value;
      const beforeText = (sel.options[sel.selectedIndex]?.text || '').trim();

      for (const opt of sel.options) {
        opt.selected = opt.value === value;
      }
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLSelectElement.prototype,
        'value'
      )?.set;
      setter?.call(sel, value);
      sel.value = value;

      const tryVue = (node) => node?.__vue__ || node?.__vueParentComponent?.ctx || null;
      try {
        let vue =
          tryVue(sel) ||
          tryVue(sel.closest('.cx-vui-component')) ||
          tryVue(sel.parentElement);
        if (vue?.$emit) {
          vue.$emit('input', value);
          vue.$emit('change', value);
        }
        let p = vue;
        for (let i = 0; i < 12 && p; i += 1) {
          const data = p.$data || p;
          const pageObj = data?.page || p.page;
          if (pageObj && typeof pageObj === 'object') {
            if (labelHint === 'parent' && 'parent' in pageObj) {
              pageObj.parent = value;
            }
            if (labelHint === 'position' && 'menu_position' in pageObj) {
              pageObj.menu_position = value;
            }
            if (labelHint === 'position' && 'position' in pageObj) {
              pageObj.position = value;
            }
          }
          p = p.$parent;
        }
      } catch {
        /* ignore */
      }

      sel.dispatchEvent(new Event('input', { bubbles: true }));
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      try {
        sel.dispatchEvent(new InputEvent('input', { bubbles: true, data: value }));
      } catch {
        /* older browsers */
      }

      const afterOpt = sel.options[sel.selectedIndex];
      return {
        ok: sel.value === value,
        before,
        beforeText,
        after: sel.value,
        afterText: (afterOpt?.text || '').trim(),
        value,
      };
    },
    found.id,
    valueOr,
    /parent/i.test(labelText) ? 'parent' : /position/i.test(labelText) ? 'position' : ''
  );

  try {
    const targetValue =
      valueOr && typeof valueOr === 'object'
        ? valueOr.empty
          ? ''
          : valueOr.value != null
            ? String(valueOr.value)
            : result.value
        : String(valueOr ?? '');
    if (targetValue !== undefined && targetValue !== null) {
      await page.select(`select[data-afp="${found.id}"]`, targetValue);
    }
  } catch {
    /* empty option đôi khi cần evaluate */
  }

  const again = await findSelectByLabel(page, labelText);
  return {
    ...result,
    ok: again
      ? valueOr?.empty
        ? again.value === '' && !/settings/i.test(again.text)
        : valueOr?.value != null
          ? again.value === String(valueOr.value)
          : valueOr?.text
            ? new RegExp(`^${valueOr.text}$`, 'i').test(again.text)
            : result.ok
      : result.ok,
    finalValue: again?.value,
    finalText: again?.text,
  };
}

async function clickUpdatePage(page, log) {
  let saved = false;
  for (const label of ['Update Page', 'Update', 'Save Changes', 'Save']) {
    try {
      await clickByText(page, label, { exact: label === 'Update Page', timeout: 4000 });
      saved = true;
      log(`Đã bấm: ${label}`);
      break;
    } catch {
      /* next */
    }
  }
  if (!saved) {
    saved = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button, a, input[type="submit"]'));
      const hit = btns.find((el) =>
        /update\s*page|^update$/i.test((el.innerText || el.value || '').trim())
      );
      if (hit) {
        hit.click();
        return true;
      }
      const accent = document.querySelector(
        'button.cx-vui-button--style-accent, .cx-vui-button--style-accent'
      );
      if (accent) {
        accent.click();
        return true;
      }
      return false;
    });
    if (saved) log('Đã bấm Update Page (fallback).');
  }
  if (!saved) throw new Error('Không bấm được Update Page.');

  log('Chờ popup "Page updated"...');
  await waitForAnyText(page, ['Page updated'], { timeout: 45000 }).catch(() => null);
  const saw = await page.evaluate(() => /page updated/i.test(document.body?.innerText || ''));
  if (saw) log('Đã thấy "Page updated".');
  else log('⚠ Không thấy toast Page updated — vẫn tiếp tục.');
  await sleepExact(1500);
}

/**
 * Patch Vue page object + POST admin-ajax (hoặc gọi vue.save / click Update).
 * @param {Record<string, string>} patch eg { parent: '', menu_position: '3', position: '3' }
 */
async function saveWebInfoViaDomAjax(page, patch, log) {
  const ajaxWait = page
    .waitForResponse(
      (res) => {
        try {
          const u = res.url();
          if (!/admin-ajax\.php/i.test(u)) return false;
          if (res.request().method() !== 'POST') return false;
          const data = res.request().postData() || '';
          return /jet_engine|option.?page|save/i.test(data) || data.length > 40;
        } catch {
          return false;
        }
      },
      { timeout: 25000 }
    )
    .catch(() => null);

  const result = await page.evaluate(async (patch) => {
    const tryVue = (node) => node?.__vue__ || node?.__vueParentComponent?.ctx || null;

    let pageObj = null;
    let vueHost = null;
    const nodes = Array.from(document.querySelectorAll('body *'));
    for (const el of nodes) {
      const v0 = tryVue(el);
      if (!v0) continue;
      let p = v0;
      for (let i = 0; i < 24 && p; i += 1) {
        const data = p.$data || p;
        const candidate = data?.page || p.page;
        if (
          candidate &&
          typeof candidate === 'object' &&
          ('parent' in candidate || 'slug' in candidate || 'menu_position' in candidate)
        ) {
          pageObj = candidate;
          vueHost = p;
          break;
        }
        p = p.$parent;
      }
      if (pageObj) break;
    }

    if (!pageObj) return { ok: false, reason: 'no-vue-page' };

    for (const [k, v] of Object.entries(patch || {})) {
      if (k in pageObj || k === 'parent' || k === 'menu_position' || k === 'position') {
        pageObj[k] = v;
      }
    }
    if ('menu_position' in patch) pageObj.menu_position = patch.menu_position;
    if ('position' in patch) pageObj.position = patch.position;
    if ('parent' in patch) pageObj.parent = patch.parent;

    for (const name of ['save', 'savePage', 'updatePage', 'onSave', 'submit']) {
      if (typeof vueHost?.[name] === 'function') {
        try {
          await vueHost[name]();
          return { ok: true, via: `vue.${name}`, slug: pageObj.slug || '' };
        } catch {
          /* try next */
        }
      }
    }

    const ajaxurl = window.ajaxurl || '/wp-admin/admin-ajax.php';
    const cfgKeys = Object.keys(window).filter((k) => /jet/i.test(k));
    let nonce = '';
    let action = 'jet_engine_ajax';
    let handler = '';
    for (const k of cfgKeys) {
      const cfg = window[k];
      if (!cfg || typeof cfg !== 'object') continue;
      nonce = nonce || cfg.nonce || cfg._nonce || cfg.ajaxNonce || '';
      handler = handler || cfg.handler || '';
      if (cfg.action) action = cfg.action;
    }
    if (!nonce) {
      nonce =
        document.querySelector('input[name="_wpnonce"]')?.value ||
        document.querySelector('#_wpnonce')?.value ||
        '';
    }

    if (!nonce) {
      for (const s of Array.from(document.querySelectorAll('script:not([src])'))) {
        const t = s.textContent || '';
        const m =
          t.match(/["']nonce["']\s*:\s*["']([a-zA-Z0-9]+)["']/) ||
          t.match(/nonce["']?\s*[=:]\s*["']([a-zA-Z0-9]+)["']/);
        if (m?.[1]) {
          nonce = m[1];
          break;
        }
      }
    }

    if (nonce) {
      const handlers = handler
        ? [handler]
        : ['save_page', 'save_option_page', 'options_page_save', 'save-page'];
      for (const h of handlers) {
        try {
          const body = new URLSearchParams();
          body.set('action', action);
          body.set('handler', h);
          body.set('nonce', nonce);
          body.set('_nonce', nonce);
          body.set('data', JSON.stringify(pageObj));
          body.set('page', JSON.stringify(pageObj));
          const res = await fetch(ajaxurl, {
            method: 'POST',
            credentials: 'include',
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
              Accept: 'application/json, text/javascript, */*; q=0.01',
              'X-Requested-With': 'XMLHttpRequest',
            },
            body: body.toString(),
          });
          const text = await res.text();
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {
            /* html */
          }
          const success =
            res.ok &&
            (json?.success === true ||
              json?.success === 'true' ||
              /page updated|success/i.test(text));
          if (success) {
            return { ok: true, via: `ajax:${action}/${h}`, slug: pageObj.slug || '' };
          }
        } catch {
          /* next handler */
        }
      }
    }

    const btns = Array.from(document.querySelectorAll('button, a, input[type="submit"]'));
    const hit =
      btns.find((el) => /update\s*page|^update$/i.test((el.innerText || el.value || '').trim())) ||
      document.querySelector('button.cx-vui-button--style-accent, .cx-vui-button--style-accent');
    if (!hit) return { ok: false, reason: 'no-update-btn', hasNonce: Boolean(nonce) };
    hit.click();
    return { ok: true, via: 'click-update', slug: pageObj.slug || '', hasNonce: Boolean(nonce) };
  }, patch);

  const ajaxRes = await ajaxWait;
  if (ajaxRes) {
    log(`✓ AJAX save: ${ajaxRes.status()} ${ajaxRes.url().split('?')[0]}`);
  }

  if (!result?.ok) {
    throw new Error(`Web Info DOM/AJAX save fail: ${result?.reason || 'unknown'}`);
  }
  log(`✓ Lưu Web Info via ${result.via}`);

  await waitForAnyText(page, ['Page updated'], { timeout: 20000 }).catch(() => null);
  await sleepExact(800);
  return result;
}

async function openWebInfoEdit(page, base, log) {
  const listUrl = `${base}/wp-admin/admin.php?page=jet-engine-options-pages`;
  log('Mở Jet Engine Options Pages list...');
  await page.goto(listUrl, GOTO);
  await sleepExact(800);
  await dismissBlockingAlerts(page, log);

  log('Chờ list Options Pages hiện...');
  const listDeadline = Date.now() + 60000;
  let listReady = false;
  while (Date.now() < listDeadline) {
    listReady = await page.evaluate(() => {
      const body = document.body?.innerText || '';
      if (!/web-info|options pages/i.test(body)) return false;
      return Array.from(document.querySelectorAll('a, button')).some((el) =>
        /^edit$/i.test((el.innerText || el.textContent || '').trim())
      );
    });
    if (listReady) break;
    await sleep(400);
  }
  if (!listReady) {
    throw new Error('Timeout: list Jet Engine Options Pages không hiện.');
  }

  log('Chọn Edit ở page slug = web-info...');
  const edited = await page.evaluate(() => {
    const rows = Array.from(
      document.querySelectorAll('tr, .cx-vui-list-table__item, .list-table-item')
    );
    for (const row of rows) {
      const text = (row.innerText || '').replace(/\s+/g, ' ');
      if (!/\bweb-info\b/i.test(text)) continue;
      const edit = Array.from(row.querySelectorAll('a, button')).find((el) =>
        /^edit$/i.test((el.innerText || el.textContent || '').trim())
      );
      if (edit) {
        edit.click();
        return true;
      }
    }
    for (const row of Array.from(document.querySelectorAll('div'))) {
      const text = (row.innerText || '').replace(/\s+/g, ' ');
      if (text.length > 400) continue;
      if (!/\bweb-info\b/i.test(text)) continue;
      const edit = Array.from(row.querySelectorAll('a, button')).find((el) =>
        /^edit$/i.test((el.innerText || '').trim())
      );
      if (edit) {
        edit.click();
        return true;
      }
    }
    return false;
  });
  if (!edited) throw new Error('Không tìm thấy Edit cho slug web-info.');

  await page.waitForNavigation(GOTO).catch(() => {});
  await sleepExact(1200);
  await dismissBlockingAlerts(page, log);

  await page
    .waitForSelector('.cx-vui-component, select.cx-vui-select', { timeout: 30000 })
    .catch(() => {});

  const onEdit = await page.evaluate(() => {
    const t = document.body?.innerText || '';
    return /parent page/i.test(t) && (/page slug|web-info|general settings/i.test(t));
  });
  if (!onEdit) {
    throw new Error('Sau Edit nhưng chưa vào form JetEngine (không thấy Parent page).');
  }
}

async function webInfoStillUnderSettings(page) {
  return page.evaluate(() => {
    const settingsMenu = document.querySelector('#menu-settings');
    if (!settingsMenu) return false;
    return Array.from(settingsMenu.querySelectorAll('a')).some((a) => {
      const href = (a.getAttribute('href') || '').toLowerCase();
      const text = (a.textContent || '').trim().toLowerCase();
      return href.includes('page=web-info') || text === 'web info';
    });
  });
}

async function webInfoTopLevel(page) {
  return page.evaluate(() => {
    const top = Array.from(
      document.querySelectorAll('#adminmenu > li.menu-top > a, #adminmenu > li > a .wp-menu-name')
    );
    return top.some((el) => /^web info$/i.test((el.textContent || '').trim()));
  });
}

async function detectWebInfoUnderSettings(page, base, log) {
  log('Kiểm tra Web Info trong menu Settings...');
  await gotoWithRetry(page, `${base}/wp-admin/index.php`, { attempts: 5, log });
  await sleepExact(800);
  await dismissBlockingAlerts(page, log);

  return page.evaluate(() => {
    const settingsMenu = document.querySelector('#menu-settings');
    if (!settingsMenu) {
      return { underSettings: false, reason: 'không có #menu-settings' };
    }
    const links = Array.from(settingsMenu.querySelectorAll('.wp-submenu a, a'));
    const webInfoLink = links.find((a) => {
      const href = (a.getAttribute('href') || '').toLowerCase();
      const text = (a.textContent || '').trim().toLowerCase();
      return (
        href.includes('page=web-info') ||
        href.includes('page=web_info') ||
        text === 'web info'
      );
    });
    if (!webInfoLink) {
      return { underSettings: false, reason: 'không có link Web Info dưới Settings' };
    }
    return {
      underSettings: true,
      href: webInfoLink.getAttribute('href') || '',
      text: (webInfoLink.textContent || '').trim(),
    };
  });
}

async function verifyWebInfoMoved(page, base, log) {
  log('Reload kiểm tra menu...');
  await sleepExact(2500);
  await gotoWithRetry(page, `${base}/wp-admin/index.php`, { attempts: 4, log });
  await sleepExact(1000);
  await page.reload(GOTO).catch(() => {});
  await sleepExact(1200);
  await dismissBlockingAlerts(page, log);
  const under = await webInfoStillUnderSettings(page);
  const onTop = await webInfoTopLevel(page);
  return { under, onTop };
}

/**
 * 2.1 HTTP/DOM: patch Vue + POST/AJAX (hoặc click Update), không điền select chậm như cũ.
 */
export async function pullWebInfoViaHttp(page, log) {
  const base = originOf(page.url());
  const detection = await detectWebInfoUnderSettings(page, base, log);

  if (!detection.underSettings) {
    log(`Web Info không nằm dưới Settings (${detection.reason}) — bỏ qua bước này.`);
    return { skipped: true, via: 'http' };
  }

  log(`Phát hiện Web Info dưới Settings ("${detection.text}") — HTTP/DOM...`);
  await openWebInfoEdit(page, base, log);

  log('HTTP/DOM lần 1: Parent → trống...');
  await setCxSelect(page, 'Parent page', { empty: true });
  await saveWebInfoViaDomAjax(page, { parent: '' }, log);

  log('HTTP/DOM lần 2: chờ Menu position...');
  const posDeadline = Date.now() + 20000;
  let posInfo = null;
  while (Date.now() < posDeadline) {
    posInfo = await findSelectByLabel(page, 'Menu position');
    if (posInfo) break;
    await setCxSelect(page, 'Parent page', { empty: true });
    await sleepExact(400);
  }
  if (!posInfo) {
    log('⚠ Menu position chưa hiện — mở lại Edit...');
    await openWebInfoEdit(page, base, log);
    await setCxSelect(page, 'Parent page', { empty: true });
    await saveWebInfoViaDomAjax(page, { parent: '' }, log);
    posInfo = await findSelectByLabel(page, 'Menu position');
  }
  if (!posInfo) {
    throw new Error('HTTP/DOM: không thấy Menu position sau khi Parent trống.');
  }

  log('HTTP/DOM: Menu position → Dashboard (3)...');
  let posSet = await setCxSelect(page, 'Menu position', { text: 'Dashboard' });
  if (!posSet.ok) posSet = await setCxSelect(page, 'Menu position', { value: '3' });
  await setCxSelect(page, 'Parent page', { empty: true });
  await saveWebInfoViaDomAjax(
    page,
    { parent: '', menu_position: '3', position: '3' },
    log
  );

  let { under, onTop } = await verifyWebInfoMoved(page, base, log);
  if (under || !onTop) {
    log(`⚠ Chưa chắc (under=${under}, top=${onTop}) — save lại 1 vòng HTTP/DOM...`);
    await openWebInfoEdit(page, base, log);
    await setCxSelect(page, 'Parent page', { empty: true });
    await setCxSelect(page, 'Menu position', { value: '3' });
    await saveWebInfoViaDomAjax(
      page,
      { parent: '', menu_position: '3', position: '3' },
      log
    );
    ({ under, onTop } = await verifyWebInfoMoved(page, base, log));
  }

  if (under) {
    throw new Error('HTTP/DOM: Web Info vẫn còn dưới Settings sau 2 lần save.');
  }
  if (!onTop) {
    log(
      'Web Info không còn dưới Settings, nhưng chưa thấy top-level — chấp nhận ra khỏi Settings.'
    );
  } else {
    log('Xong (HTTP/DOM): Web Info top-level, không còn dưới Settings.');
  }
  return { skipped: false, via: 'http' };
}

/**
 * Luồng Chrome cũ (2 lần Update + sleep dài).
 */
export async function pullWebInfoViaBrowser(page, log) {
  const base = originOf(page.url());

  const detection = await detectWebInfoUnderSettings(page, base, log);

  if (!detection.underSettings) {
    log(`Web Info không nằm dưới Settings (${detection.reason}) — bỏ qua bước này.`);
    return;
  }

  log(`Phát hiện Web Info dưới Settings ("${detection.text}").`);
  await openWebInfoEdit(page, base, log);

  log('Lần 1: Đổi Parent page → trống (option value="")...');
  let parentInfo = await findSelectByLabel(page, 'Parent page');
  if (!parentInfo) throw new Error('Không thấy select Parent page.');
  log(`Parent hiện tại: value="${parentInfo.value}" text="${parentInfo.text}"`);

  let parentSet = await setCxSelect(page, 'Parent page', { empty: true });
  if (!parentSet.ok || /settings/i.test(parentSet.finalText || '')) {
    await page.evaluate(() => {
      const comps = Array.from(document.querySelectorAll('.cx-vui-component'));
      for (const comp of comps) {
        const label = (
          comp.querySelector('.cx-vui-component__label, label')?.textContent || ''
        )
          .trim()
          .toLowerCase();
        if (label !== 'parent page') continue;
        const sel = comp.querySelector('select');
        if (!sel) return;
        const emptyOpt = Array.from(sel.options).find((o) => o.value === '');
        if (emptyOpt) emptyOpt.selected = true;
        sel.selectedIndex = Array.from(sel.options).findIndex((o) => o.value === '');
        const setter = Object.getOwnPropertyDescriptor(
          window.HTMLSelectElement.prototype,
          'value'
        )?.set;
        setter?.call(sel, '');
        sel.value = '';
        sel.dispatchEvent(new Event('input', { bubbles: true }));
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        const v = sel.__vue__;
        v?.$emit?.('input', '');
        v?.$emit?.('change', '');
      }
    });
    parentSet = await setCxSelect(page, 'Parent page', { empty: true });
  }

  parentInfo = await findSelectByLabel(page, 'Parent page');
  if (/settings/i.test(parentInfo?.text || '') || parentInfo?.value === 'options-general.php') {
    throw new Error(
      `Không đổi được Parent page khỏi Settings (value="${parentInfo?.value}", text="${parentInfo?.text}").`
    );
  }
  log(`Parent page → value="${parentInfo?.value}" text="${parentInfo?.text || '(trống)'}"`);

  log('Update Page (lần 1 — lưu Parent)...');
  await clickUpdatePage(page, log);

  log('Lần 2: Chờ Menu position hiện sau khi Parent trống...');
  const posDeadline = Date.now() + 25000;
  let posInfo = null;
  while (Date.now() < posDeadline) {
    posInfo = await findSelectByLabel(page, 'Menu position');
    if (posInfo) break;
    await setCxSelect(page, 'Parent page', { empty: true });
    await sleepExact(500);
  }

  if (!posInfo) {
    log('⚠ Menu position chưa hiện — mở lại Edit web-info...');
    await openWebInfoEdit(page, base, log);
    await setCxSelect(page, 'Parent page', { empty: true });
    await sleepExact(800);
    posInfo = await findSelectByLabel(page, 'Menu position');
  }

  if (!posInfo) {
    throw new Error('Không thấy Menu position sau khi Parent = trống. Không thể đặt Dashboard.');
  }

  log(`Menu position hiện tại: value="${posInfo.value}" text="${posInfo.text}"`);
  log('Đổi Menu position → Dashboard (value="3")...');
  let posSet = await setCxSelect(page, 'Menu position', { text: 'Dashboard' });
  if (!posSet.ok) {
    posSet = await setCxSelect(page, 'Menu position', { value: '3' });
  }
  posInfo = await findSelectByLabel(page, 'Menu position');
  if (posInfo?.value !== '3' && !/^dashboard$/i.test(posInfo?.text || '')) {
    throw new Error(
      `Không set Menu position = Dashboard (value="${posInfo?.value}", text="${posInfo?.text}").`
    );
  }
  log(`Menu position → value="${posInfo.value}" text="${posInfo.text}"`);

  await setCxSelect(page, 'Parent page', { empty: true });

  log('Update Page (lần 2 — lưu Menu position)...');
  await clickUpdatePage(page, log);

  log('Chờ 5 giây rồi reload kiểm tra menu...');
  await sleepExact(5000);

  await gotoWithRetry(page, `${base}/wp-admin/index.php`, { attempts: 4, log });
  await sleepExact(1000);
  await page.reload(GOTO).catch(() => {});
  await sleepExact(1500);
  await dismissBlockingAlerts(page, log);

  let under = await webInfoStillUnderSettings(page);
  let onTop = await webInfoTopLevel(page);

  if (under || !onTop) {
    log(
      `⚠ Sau 2 lần Update: underSettings=${under}, topLevel=${onTop} — thử lại full 1 vòng...`
    );
    await openWebInfoEdit(page, base, log);
    await setCxSelect(page, 'Parent page', { empty: true });
    await clickUpdatePage(page, log);
    await sleepExact(1000);
    const p2 = await findSelectByLabel(page, 'Menu position');
    if (!p2) throw new Error('Retry: không thấy Menu position.');
    await setCxSelect(page, 'Menu position', { value: '3' });
    await setCxSelect(page, 'Parent page', { empty: true });
    await clickUpdatePage(page, log);
    await sleepExact(5000);
    await gotoWithRetry(page, `${base}/wp-admin/index.php`, { attempts: 4, log });
    await sleepExact(1000);
    await page.reload(GOTO).catch(() => {});
    await sleepExact(1500);
    under = await webInfoStillUnderSettings(page);
    onTop = await webInfoTopLevel(page);
  }

  if (under) {
    throw new Error(
      'Web Info vẫn còn dưới Settings sau Parent Update + Menu position Update + reload.'
    );
  }
  if (!onTop) {
    log(
      'Web Info không còn dưới Settings, nhưng chưa thấy top-level "Web Info" — có thể nằm chỗ khác (vẫn chấp nhận ra khỏi Settings).'
    );
  } else {
    log('Xong: Web Info đã ra ngoài (top-level), không còn dưới Settings.');
  }
}

/**
 * Web Info → Dashboard.
 * 2.1: ưu tiên HTTP/DOM (Vue + AJAX), fail → Chrome cũ.
 */
export async function pullWebInfoToDashboard(page, log) {
  // Phase 1: thử REST trước
  if (isHttpStepsEnabled()) {
    try {
      const { getRestAuth, callHelper } = await import('../http/helperClient.js');
      const { originOf } = await import('../utils.js');
      const base = originOf(page.url());
      const auth = await getRestAuth(page, base);
      log('Chuyển Web Info ra menu top-level qua REST...');
      const res = await callHelper(base, auth, '/web-info/move-to-top');
      if (res.moved) {
        log('✓ Web Info đã chuyển ra menu top-level.');
        return;
      }
      // Helper báo cần fallback (submenu của plugin khác)
      log(`⚠ REST Web Info: ${res.reason || res.note || 'cần fallback'} — thử HTTP/DOM...`);
    } catch (err) {
      log(`⚠ REST Web Info thất bại (${(err?.message || '').slice(0, 120)}) — thử HTTP/DOM...`);
    }
  }
  if (isHttpStepsEnabled()) {
    try {
      await pullWebInfoViaHttp(page, log);
      return;
    } catch (err) {
      const msg = err?.message || String(err);
      log(`⚠ HTTP/DOM Web Info thất bại (${msg.slice(0, 160)}) — fallback Chrome...`);
      await pullWebInfoViaBrowser(page, log);
      return;
    }
  }
  await pullWebInfoViaBrowser(page, log);
}
