import { originOf, sleep, sleepExact, evaluateSafe, withAcceptedDialogs } from '../utils.js';
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

function scanAmeRow() {
  const rows = Array.from(document.querySelectorAll('#the-list > tr'));
  for (const row of rows) {
    if (row.classList.contains('plugin-update-tr')) continue;
    const slug = String(row.getAttribute('data-slug') || '').toLowerCase();
    const pluginAttr = String(
      row.getAttribute('data-plugin') ||
        row.querySelector('input[name="checked[]"]')?.value ||
        ''
    )
      .replace(/\\/g, '/')
      .toLowerCase();
    const id = String(row.id || '').toLowerCase();
    const name = (row.querySelector('.plugin-title strong')?.textContent || '')
      .replace(/\s+/g, ' ')
      .trim();
    const isAme =
      slug.includes('admin-menu-editor') ||
      pluginAttr.includes('admin-menu-editor') ||
      id === 'admin-menu-editor' ||
      id === 'admin-menu-editor-pro' ||
      /^admin menu editor\b/i.test(name);
    if (!isAme) continue;
    const deactivate = row.querySelector('.row-actions a[href*="action=deactivate"]');
    const deleteLink = row.querySelector(
      '.row-actions a[href*="action=delete-plugin"], .row-actions a.delete'
    );
    const activate = row.querySelector('.row-actions a[href*="action=activate"]');
    const hrefForPlugin =
      deactivate?.getAttribute('href') || deleteLink?.getAttribute('href') || '';
    const pluginMatch = hrefForPlugin.match(/[?&]plugin=([^&]+)/i);
    return {
      found: true,
      active: Boolean(deactivate),
      inactive: Boolean(activate) && !deactivate,
      deactivateHref: deactivate?.getAttribute('href') || null,
      deleteHref: deleteLink?.getAttribute('href') || null,
      plugin:
        (pluginMatch ? decodeURIComponent(pluginMatch[1].replace(/\+/g, ' ')) : '') ||
        row.getAttribute('data-plugin') ||
        '',
      slug: slug || id,
      title: name.slice(0, 80),
    };
  }
  return { found: false };
}

async function findAmeActionsInPage(page) {
  return evaluateSafe(page, scanAmeRow);
}

async function readPageHint(page) {
  return evaluateSafe(page, () => {
    const ftp = Boolean(
      document.querySelector(
        '#request-filesystem-credentials-form, #request-filesystem-credentials-dialog, #upgrade'
      )
    );
    const verify = Boolean(document.querySelector('input[name="verify-delete"]'));
    const notice = (
      document.querySelector('.notice-error, .notice-success, #message, .updated, .error')
        ?.innerText || ''
    )
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 160);
    return { url: location.href, ftp, verify, notice };
  });
}

async function gotoPluginsList(page, base) {
  await page.goto(`${base}/wp-admin/plugins.php`, GOTO);
  await sleep(400);
}

async function confirmVerifyDeleteIfPresent(page, log) {
  const has = await evaluateSafe(page, () =>
    Boolean(document.querySelector('input[name="verify-delete"]'))
  );
  if (!has) return false;
  log('Trang confirm WP — bấm Yes, delete these files...');
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 25000 }).catch(() => {}),
    page.evaluate(() => {
      const btn = document.querySelector('input[name="verify-delete"]');
      const form = btn?.form;
      if (form && typeof form.requestSubmit === 'function') form.requestSubmit(btn);
      else btn?.click();
    }),
  ]);
  await sleep(400);
  return true;
}

async function waitAmeGone(page, timeoutMs = 25000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const info = await findAmeActionsInPage(page).catch(() => ({ found: true }));
    if (!info.found) return true;
    const hint = await readPageHint(page);
    if (hint.ftp) {
      throw new Error(
        'WP hỏi FTP/filesystem credentials — host không cho xóa plugin trực tiếp.'
      );
    }
    if (hint.verify) {
      await confirmVerifyDeleteIfPresent(page, () => {});
    }
    await sleep(400);
  }
  return false;
}

/**
 * WP admin hiện đại xóa plugin bằng AJAX (wp.updates.deletePlugin), không phải GET href.
 */
async function deleteAmeViaWpAjax(page, info, log) {
  const pluginFile = info.plugin || '';
  const slug = info.slug || 'admin-menu-editor';
  if (!pluginFile) return { ok: false, reason: 'no-plugin-file' };

  log(`AJAX: wp.updates.deletePlugin (${pluginFile})...`);
  const result = await evaluateSafe(
    page,
    async (plugin, slugName) => {
      const api = window.wp && window.wp.updates;
      if (!api || typeof api.deletePlugin !== 'function') {
        return { ok: false, reason: 'no-wp-updates' };
      }
      try {
        const ret = api.deletePlugin({ plugin, slug: slugName });
        if (ret && typeof ret.then === 'function') {
          await ret;
        } else {
          await new Promise((r) => setTimeout(r, 2500));
        }
        return { ok: true };
      } catch (err) {
        return { ok: false, reason: String(err && err.message ? err.message : err).slice(0, 160) };
      }
    },
    pluginFile,
    slug
  );
  if (!result?.ok) return result || { ok: false, reason: 'ajax-fail' };
  const gone = await waitAmeGone(page, 20000);
  return gone ? { ok: true } : { ok: false, reason: 'ajax-row-still-there' };
}

async function deleteAmeViaRowClick(page, log) {
  log('Click Delete trên hàng plugin...');
  const clicked = await withAcceptedDialogs(
    page,
    async () => {
      const result = await evaluateSafe(page, () => {
        const rows = Array.from(document.querySelectorAll('#the-list > tr'));
        for (const row of rows) {
          if (row.classList.contains('plugin-update-tr')) continue;
          const slug = String(row.getAttribute('data-slug') || '').toLowerCase();
          const plugin = String(row.getAttribute('data-plugin') || '').toLowerCase();
          const id = String(row.id || '').toLowerCase();
          const name = (row.querySelector('.plugin-title strong')?.textContent || '').trim();
          const isAme =
            slug.includes('admin-menu-editor') ||
            plugin.includes('admin-menu-editor') ||
            id === 'admin-menu-editor' ||
            id === 'admin-menu-editor-pro' ||
            /^admin menu editor\b/i.test(name);
          if (!isAme) continue;
          const a = row.querySelector('.row-actions a.delete, .row-actions a[href*="delete-plugin"]');
          if (!a) return { ok: false, reason: 'no-delete-link' };
          a.click();
          return { ok: true };
        }
        return { ok: false, reason: 'no-row' };
      });
      if (result?.ok) {
        await sleep(800);
        await confirmVerifyDeleteIfPresent(page, log);
      }
      return result;
    },
    log
  );
  if (!clicked?.ok) {
    log(`⚠ Chưa click được Delete (${clicked?.reason || 'unknown'}) — thử cách khác.`);
    return false;
  }
  return waitAmeGone(page, 25000);
}

async function deleteAmeViaHref(page, base, info, log) {
  if (!info.deleteHref) return false;
  log('Goto link Delete + confirm Yes, delete...');
  await withAcceptedDialogs(
    page,
    async () => {
      await page.goto(absAdminUrl(base, info.deleteHref), GOTO);
      await sleepExact(600);
      await confirmVerifyDeleteIfPresent(page, log);
    },
    log
  );
  if (await waitAmeGone(page, 12000)) return true;
  await gotoPluginsList(page, base);
  return !(await findAmeActionsInPage(page)).found;
}

async function deleteAmeViaBulk(page, log) {
  log('Bulk: tick Admin Menu Editor → Delete selected...');
  const bulk = await evaluateSafe(page, () => {
    const rows = Array.from(document.querySelectorAll('#the-list > tr'));
    let checked = false;
    for (const row of rows) {
      const plugin = String(
        row.getAttribute('data-plugin') || row.querySelector('input[name="checked[]"]')?.value || ''
      ).toLowerCase();
      const slug = String(row.getAttribute('data-slug') || row.id || '').toLowerCase();
      if (!plugin.includes('admin-menu-editor') && !slug.includes('admin-menu-editor')) continue;
      const cb = row.querySelector('input[type="checkbox"][name="checked[]"]');
      if (!cb) continue;
      cb.checked = true;
      cb.dispatchEvent(new Event('change', { bubbles: true }));
      checked = true;
    }
    if (!checked) return { ok: false, reason: 'no-checkbox' };
    const form =
      document.querySelector('#bulk-action-form') ||
      document.querySelector('form#posts-filter') ||
      document.querySelector('#the-list')?.closest('form');
    const action =
      form?.querySelector('select[name="action"]') || document.querySelector('select[name="action"]');
    if (action) {
      action.value = 'delete-selected';
      action.dispatchEvent(new Event('change', { bubbles: true }));
    }
    const apply = document.querySelector('#doaction');
    if (form && typeof form.requestSubmit === 'function' && apply) {
      form.requestSubmit(apply);
    } else {
      apply?.click();
    }
    return { ok: true };
  });
  if (!bulk?.ok) return false;
  await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 25000 }).catch(() => {});
  await sleep(400);
  await confirmVerifyDeleteIfPresent(page, log);
  return waitAmeGone(page, 20000);
}

async function deactivateAme(page, base, info, log) {
  if (!info.found || !info.active) return info;

  if (info.deactivateHref) {
    log('Deactivate Admin Menu Editor (đang Active — WP chỉ Delete được khi inactive)...');
    await page.goto(absAdminUrl(base, info.deactivateHref), GOTO);
    await sleepExact(500);
    await gotoPluginsList(page, base);
    info = await findAmeActionsInPage(page);
  }

  if (info.found && info.active) {
    log('⚠ Vẫn Active — click Deactivate trên hàng...');
    await withAcceptedDialogs(
      page,
      async () => {
        await evaluateSafe(page, () => {
          const rows = Array.from(document.querySelectorAll('#the-list > tr'));
          for (const row of rows) {
            const plugin = String(row.getAttribute('data-plugin') || '').toLowerCase();
            const slug = String(row.getAttribute('data-slug') || row.id || '').toLowerCase();
            if (!plugin.includes('admin-menu-editor') && !slug.includes('admin-menu-editor')) continue;
            row.querySelector('.row-actions a[href*="action=deactivate"]')?.click();
            return;
          }
        });
        await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
      },
      log
    );
    await sleep(400);
    await gotoPluginsList(page, base);
    info = await findAmeActionsInPage(page);
  }

  return info;
}

async function deleteAmeAllWays(page, base, info, log) {
  const ajax = await deleteAmeViaWpAjax(page, info, log);
  if (ajax.ok) return true;
  log(`⚠ AJAX delete không xong (${ajax.reason}) — thử click / href / bulk...`);

  await gotoPluginsList(page, base);
  info = await findAmeActionsInPage(page);
  if (!info.found) return true;

  if (await deleteAmeViaRowClick(page, log)) return true;

  await gotoPluginsList(page, base);
  info = await findAmeActionsInPage(page);
  if (!info.found) return true;

  if (await deleteAmeViaHref(page, base, info, log)) return true;

  await gotoPluginsList(page, base);
  if (!(await findAmeActionsInPage(page)).found) return true;

  return deleteAmeViaBulk(page, log);
}

async function removeAmeCore(page, base, log, label) {
  await gotoPluginsList(page, base);
  let info = await findAmeActionsInPage(page);
  if (!info.found) {
    log('⏭ Không có Admin Menu Editor — bỏ qua gỡ.');
    return { removed: false, skipped: true, via: label };
  }

  log(
    `Phát hiện Admin Menu Editor (“${info.title || info.plugin}”, file=${info.plugin || '?'}, ${
      info.active ? 'active' : 'inactive'
    }) — luôn Delete (Active thì Deactivate trước).`
  );

  info = await deactivateAme(page, base, info, log);
  if (!info.found) {
    log('✓ Admin Menu Editor đã biến sau Deactivate — vẫn kiểm tra Delete...');
    await gotoPluginsList(page, base);
    info = await findAmeActionsInPage(page);
    if (!info.found) {
      log('✓ Không còn Admin Menu Editor trên Plugins.');
      return { removed: true, skipped: false, via: label };
    }
  }

  if (info.active) {
    log('⚠ Vẫn Active — vẫn thử Delete (WP thường chặn; sẽ retry Deactivate+Delete).');
  } else {
    log('Inactive — Delete plugin...');
  }

  if (await deleteAmeAllWays(page, base, info, log)) {
    log('✓ Đã gỡ Admin Menu Editor (deactivate nếu cần + delete).');
    return { removed: true, skipped: false, via: label };
  }

  // Còn hàng và vẫn Active → deactivate lần nữa rồi Delete lại
  await gotoPluginsList(page, base);
  info = await findAmeActionsInPage(page);
  if (!info.found) {
    log('✓ Đã gỡ Admin Menu Editor.');
    return { removed: true, skipped: false, via: label };
  }
  if (info.active) {
    info = await deactivateAme(page, base, info, log);
  }
  if (info.found && (await deleteAmeAllWays(page, base, info, log))) {
    log('✓ Đã gỡ Admin Menu Editor (retry).');
    return { removed: true, skipped: false, via: label };
  }

  await gotoPluginsList(page, base);
  const after = await findAmeActionsInPage(page);
  if (!after.found) {
    log('✓ Đã gỡ Admin Menu Editor.');
    return { removed: true, skipped: false, via: label };
  }

  const hint = await readPageHint(page);
  const extra = stripHtmlText(hint.notice || '').slice(0, 120);
  throw new Error(
    `Vẫn còn trên Plugins list (${after.active ? 'vẫn Active' : 'inactive'}). ${
      extra || hint.url || ''
    }`.trim()
  );
}

/**
 * Trước bước Backup/Updraft: nếu có Admin Menu Editor → deactivate (nếu Active) rồi luôn Delete.
 * Fail → log cảnh báo, không chặn Backup.
 *
 * Phase 1: ưu tiên REST (helper plugin) → HTTP/DOM → browser.
 */
export async function removeAdminMenuEditorIfPresent(page, log) {
  const base = originOf(page.url());
  if (!base) throw new Error('Không xác định origin WP để kiểm tra plugin.');

  // Phase 1: thử REST trước
  if (isHttpStepsEnabled()) {
    try {
      const { getRestAuth, callHelper } = await import('../http/helperClient.js');
      const auth = await getRestAuth(page, base);
      const res = await callHelper(base, auth, '/plugins/remove', { slugs: ['admin-menu-editor'] });
      if (res.removed?.length) {
        log(`✓ Đã gỡ plugin qua REST: ${res.removed.join(', ')}`);
        return { removed: true, via: 'rest', slugs: res.removed };
      }
      log('Admin Menu Editor không có — bỏ qua.');
      return { removed: false, skipped: true, via: 'rest' };
    } catch (err) {
      log(`⚠ REST gỡ plugin thất bại (${(err?.message || '').slice(0, 120)}) — thử HTTP/DOM...`);
    }
  }

  try {
    const via = isHttpStepsEnabled() ? 'http' : 'browser';
    try {
      return await removeAmeCore(page, base, log, via);
    } catch (err) {
      if (!isHttpStepsEnabled()) throw err;
      log(
        `⚠ Gỡ Admin Menu Editor lần 1 fail — thử lại: ${String(err?.message || err).slice(0, 160)}`
      );
      return await removeAmeCore(page, base, log, 'browser');
    }
  } catch (err) {
    log(
      `⚠ Không gỡ được Admin Menu Editor (${String(err?.message || err).slice(0, 180)}) — tiếp tục Backup.`
    );
    return { removed: false, skipped: false, error: String(err?.message || err) };
  }
}

export { isAmePluginFile, AME_PLUGIN_FILES };
