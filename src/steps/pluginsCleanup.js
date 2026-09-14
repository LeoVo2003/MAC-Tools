import { originOf, sleep, sleepExact, evaluateSafe } from '../utils.js';
import { isHttpStepsEnabled, stripHtmlText } from '../http/wpSession.js';

const GOTO = { waitUntil: 'domcontentloaded', timeout: 60000 };

/** Plugin file paths thường gặp (free + pro). */
const AME_PLUGIN_FILES = [
  'admin-menu-editor/menu-editor.php',
  'admin-menu-editor-pro/menu-editor.php',
  'admin-menu-editor/admin-menu-editor.php',
];

function absAdminUrl(base, href) {
  if (!href) return null;
  const h = String(href).replace(/&amp;/g, '&').trim();
  if (/^https?:\/\//i.test(h)) return h;
  if (h.startsWith('//')) return `https:${h}`;
  const path = h.replace(/^\//, '').replace(/^wp-admin\//i, '');
  return `${base}/wp-admin/${path}`;
}

function isAmePluginFile(plugin) {
  const p = decodeURIComponent(String(plugin || '')).replace(/\\/g, '/').toLowerCase();
  return (
    p.includes('admin-menu-editor') ||
    AME_PLUGIN_FILES.some((f) => p === f.toLowerCase())
  );
}

/**
 * Đọc plugins.php → tìm hàng Admin Menu Editor + link deactivate/delete.
 */
async function findAmeActionsInPage(page) {
  return evaluateSafe(page, () => {
    const rows = Array.from(document.querySelectorAll('#the-list > tr[id^=""], #the-list tr, tr'));
    for (const row of rows) {
      const id = row.id || '';
      const text = (row.innerText || '').toLowerCase();
      const title =
        row.querySelector('.plugin-title strong, .plugin-title, td.plugin-title')?.innerText ||
        '';
      const titleL = title.toLowerCase();
      const isAme =
        /admin-menu-editor/i.test(id) ||
        /^admin menu editor/i.test(title.trim()) ||
        (/admin menu editor/i.test(titleL) && !/exclude/i.test(titleL));
      if (!isAme && !/admin-menu-editor/i.test(row.innerHTML || '')) continue;
      // Tránh nhầm plugin khác có chữ "menu editor" xa
      if (!isAme && !/admin-menu-editor/i.test(row.innerHTML || '')) continue;

      const deactivate = row.querySelector('a[href*="action=deactivate"]');
      const deleteLink = row.querySelector('a[href*="action=delete-plugin"], a.delete, a[href*="action=delete"]');
      const activate = row.querySelector('a[href*="action=activate"]');
      const pluginMatch =
        (deactivate?.getAttribute('href') || deleteLink?.getAttribute('href') || '').match(
          /[?&]plugin=([^&]+)/i
        );
      return {
        found: true,
        active: Boolean(deactivate),
        inactive: Boolean(activate) && !deactivate,
        deactivateHref: deactivate?.getAttribute('href') || null,
        deleteHref: deleteLink?.getAttribute('href') || null,
        plugin: pluginMatch ? decodeURIComponent(pluginMatch[1].replace(/\+/g, ' ')) : '',
        title: title.trim().slice(0, 80),
      };
    }
    return { found: false };
  });
}

async function gotoPluginsList(page, base) {
  await page.goto(`${base}/wp-admin/plugins.php`, GOTO);
  await sleep(400);
}

/**
 * HTTP/in-page: deactivate rồi delete Admin Menu Editor nếu có.
 */
async function removeAdminMenuEditorViaHttp(page, base, log) {
  log('HTTP: kiểm tra Admin Menu Editor trên Plugins...');
  await gotoPluginsList(page, base);

  let info = await findAmeActionsInPage(page);
  if (!info.found) {
    log('⏭ Không có Admin Menu Editor — bỏ qua gỡ.');
    return { removed: false, skipped: true, via: 'http' };
  }

  log(`Phát hiện Admin Menu Editor (“${info.title || info.plugin || 'plugin'}”) — gỡ...`);

  if (info.active && info.deactivateHref) {
    const url = absAdminUrl(base, info.deactivateHref);
    log('HTTP: Deactivate Admin Menu Editor...');
    await page.goto(url, GOTO);
    await sleepExact(500);
    await gotoPluginsList(page, base);
    info = await findAmeActionsInPage(page);
  }

  // Sau deactivate: tìm lại Delete
  if (!info.deleteHref) {
    await gotoPluginsList(page, base);
    info = await findAmeActionsInPage(page);
  }

  if (info.found && info.deleteHref) {
    const delUrl = absAdminUrl(base, info.deleteHref);
    log('HTTP: Delete Admin Menu Editor...');
    // WP có thể hỏi confirm — accept dialog
    const onDialog = async (dialog) => {
      try {
        await dialog.accept();
      } catch {
        /* ignore */
      }
    };
    page.on('dialog', onDialog);
    try {
      await page.goto(delUrl, GOTO);
      await sleepExact(600);
      // Trang confirm “Yes, delete” nếu có
      await page.evaluate(() => {
        const btn =
          document.querySelector('#submit, input[name="verify-delete"], button[type="submit"]') ||
          Array.from(document.querySelectorAll('a.button, button, input[type="submit"]')).find(
            (el) => /yes.*delete|delete|xóa/i.test((el.innerText || el.value || '').trim())
          );
        btn?.click?.();
      });
      await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
      await sleep(400);
    } finally {
      page.off('dialog', onDialog);
    }
  } else if (info.found) {
    // Bulk delete: tick checkbox + action delete-selected
    log('HTTP: Delete qua bulk (không thấy link Delete đơn)...');
    const bulk = await page.evaluate((files) => {
      const want = files.map((f) => f.toLowerCase());
      const rows = Array.from(document.querySelectorAll('#the-list tr'));
      let checked = false;
      for (const row of rows) {
        const cb = row.querySelector('input[type="checkbox"][name="checked[]"]');
        if (!cb) continue;
        const v = decodeURIComponent(String(cb.value || '')).toLowerCase();
        if (want.some((f) => v === f || v.includes('admin-menu-editor'))) {
          cb.checked = true;
          cb.dispatchEvent(new Event('change', { bubbles: true }));
          checked = true;
        }
      }
      if (!checked) return { ok: false, reason: 'no-checkbox' };
      const action = document.querySelector('select[name="action"]');
      if (action) {
        action.value = 'delete-selected';
        action.dispatchEvent(new Event('change', { bubbles: true }));
      }
      const apply =
        document.querySelector('#doaction') ||
        document.querySelector('input[type="submit"][id^="doaction"]');
      apply?.click?.();
      return { ok: true };
    }, AME_PLUGIN_FILES);
    if (!bulk.ok) throw new Error('Không tick được Admin Menu Editor để xóa.');
    await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
    await sleep(400);
    await page.evaluate(() => {
      const btn =
        document.querySelector('input[name="verify-delete"], #submit') ||
        Array.from(document.querySelectorAll('input[type="submit"], button')).find((el) =>
          /yes.*delete|delete|xóa/i.test((el.value || el.innerText || '').trim())
        );
      btn?.click?.();
    });
    await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
  }

  await gotoPluginsList(page, base);
  const after = await findAmeActionsInPage(page);
  if (after.found) {
    throw new Error('Đã thử gỡ Admin Menu Editor nhưng vẫn còn trên Plugins list.');
  }
  log('✓ Đã gỡ Admin Menu Editor (deactivate + delete).');
  return { removed: true, skipped: false, via: 'http' };
}

async function removeAdminMenuEditorViaBrowser(page, base, log) {
  log('Chrome: kiểm tra / gỡ Admin Menu Editor...');
  await gotoPluginsList(page, base);
  let info = await findAmeActionsInPage(page);
  if (!info.found) {
    log('⏭ Không có Admin Menu Editor — bỏ qua gỡ.');
    return { removed: false, skipped: true, via: 'browser' };
  }

  log(`Phát hiện Admin Menu Editor — Deactivate + Delete (Chrome)...`);
  const onDialog = async (dialog) => {
    try {
      await dialog.accept();
    } catch {
      /* ignore */
    }
  };
  page.on('dialog', onDialog);
  try {
    if (info.active && info.deactivateHref) {
      await page.goto(absAdminUrl(base, info.deactivateHref), GOTO);
      await sleepExact(500);
      await gotoPluginsList(page, base);
      info = await findAmeActionsInPage(page);
    }
    if (info.deleteHref) {
      await page.goto(absAdminUrl(base, info.deleteHref), GOTO);
      await sleep(400);
      await page.evaluate(() => {
        const btn =
          document.querySelector('input[name="verify-delete"], #submit') ||
          Array.from(document.querySelectorAll('input[type="submit"], button, a.button')).find(
            (el) => /yes.*delete|delete|xóa/i.test((el.innerText || el.value || '').trim())
          );
        btn?.click?.();
      });
      await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
    }
  } finally {
    page.off('dialog', onDialog);
  }

  await gotoPluginsList(page, base);
  const after = await findAmeActionsInPage(page);
  if (after.found) {
    throw new Error('Chrome: Admin Menu Editor vẫn còn sau khi gỡ.');
  }
  log('✓ Đã gỡ Admin Menu Editor (Chrome).');
  return { removed: true, skipped: false, via: 'browser' };
}

/**
 * Trước bước Backup/Updraft: nếu có Admin Menu Editor → deactivate + delete.
 * Fail → log cảnh báo, không chặn Backup (trừ khi muốn cứng sau).
 */
export async function removeAdminMenuEditorIfPresent(page, log) {
  const base = originOf(page.url());
  if (!base) throw new Error('Không xác định origin WP để kiểm tra plugin.');

  try {
    if (isHttpStepsEnabled()) {
      try {
        return await removeAdminMenuEditorViaHttp(page, base, log);
      } catch (err) {
        log(
          `⚠ Gỡ Admin Menu Editor HTTP fail — fallback Chrome: ${String(err?.message || err).slice(0, 140)}`
        );
      }
    }
    return await removeAdminMenuEditorViaBrowser(page, base, log);
  } catch (err) {
    log(
      `⚠ Không gỡ được Admin Menu Editor (${String(err?.message || err).slice(0, 140)}) — tiếp tục Backup.`
    );
    return { removed: false, skipped: false, error: String(err?.message || err) };
  }
}

export { isAmePluginFile, AME_PLUGIN_FILES };
