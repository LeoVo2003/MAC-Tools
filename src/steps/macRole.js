import { originOf, clickByText, sleep, dismissBlockingAlerts } from '../utils.js';

/**
 * Mac Role qua Mac Core:
 * Refresh Plugin List → OK alert → chờ reload page
 * → Mac Role Install Now → OK alert (nếu có) → reload page
 * → Activate
 */
export async function installMacRoleViaMacCore(page, log) {
  const base = originOf(page.url());
  const GOTO = { waitUntil: 'domcontentloaded', timeout: 60000 };

  log('Mở Mac Core...');
  const macCoreUrls = [
    `${base}/wp-admin/admin.php?page=mac-core`,
    `${base}/wp-admin/admin.php?page=mac_core`,
    `${base}/wp-admin/admin.php?page=maccore`,
    `${base}/wp-admin/admin.php?page=mac-core-dashboard`,
  ];

  let opened = false;
  for (const url of macCoreUrls) {
    await page.goto(url, GOTO).catch(() => {});
    await sleep(200);
    const ok = await page.evaluate(() => {
      const t = (document.body?.innerText || '').toLowerCase();
      const title = (document.title || '').toLowerCase();
      return t.includes('mac core') || title.includes('mac core') || t.includes('mac-core');
    });
    if (ok) {
      opened = true;
      break;
    }
  }

  if (!opened) {
    log('Thử mở Mac Core từ menu sidebar...');
    const clicked = await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll('#adminmenu a, .wp-submenu a, a'));
      for (const a of links) {
        const t = (a.innerText || a.textContent || '').trim().toLowerCase();
        if (t === 'mac core' || t.includes('mac core')) {
          a.click();
          return true;
        }
      }
      return false;
    });
    if (clicked) {
      await page.waitForNavigation(GOTO).catch(() => {});
      await sleep(300);
      opened = true;
    }
  }

  if (!opened) {
    throw new Error('Không tìm thấy trang Mac Core. Kiểm tra plugin Mac Core đã active chưa.');
  }

  const onDialog = async (dialog) => {
    const msg = dialog.message() || '';
    log(`Mac Core alert: "${msg}" → OK`);
    try {
      await dialog.accept();
    } catch {
      /* already handled */
    }
  };
  page.on('dialog', onDialog);

  try {
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
      refreshed = await page.evaluate(() => {
        const btn = Array.from(document.querySelectorAll('button, a, input[type="button"]')).find(
          (el) => /refresh\s+plugin\s*list/i.test((el.innerText || el.value || '').trim())
        );
        if (btn) {
          btn.click();
          return true;
        }
        return false;
      });
    }
    if (!refreshed) {
      throw new Error('Không tìm thấy nút "Refresh Plugin List" trên Mac Core.');
    }

    log('Chờ OK alert + page reload sau Refresh...');
    await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    await sleep(600);

    const stillMacCore = await page.evaluate(() =>
      /mac core/i.test(`${document.title} ${document.body?.innerText || ''}`)
    );
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
      !(await page.evaluate(() =>
        /mac core/i.test(document.title + (document.body?.innerText || ''))
      ))
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
  } finally {
    page.off('dialog', onDialog);
  }
}

async function clickMacRoleButton(page, mode) {
  return page.evaluate((mode) => {
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

      if (mode === 'install') {
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

      if (mode === 'activate') {
        const act = Array.from(row.querySelectorAll('a, button')).find((el) =>
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
  }, mode);
}

/**
 * Vào /wp-admin/admin.php?page=mac-role
 * → bấm Create from "F Package User" → chờ load xong.
 */
export async function configureFPackageUser(page, packageTier = 'F', log) {
  const base = originOf(page.url());
  const GOTO = { waitUntil: 'domcontentloaded', timeout: 60000 };
  const url = `${base}/wp-admin/admin.php?page=mac-role`;

  log(`Mở Mac Role: ${url.replace(base, '')}`);
  await page.goto(url, GOTO);
  await sleep(400);
  await dismissBlockingAlerts(page, log);

  const onPage = await page.evaluate(() => {
    const t = (document.body?.innerText || '').toLowerCase();
    return (
      t.includes('role url links') ||
      t.includes('quick create from template') ||
      t.includes('f package user') ||
      t.includes('mac role')
    );
  });

  if (!onPage) {
    const clicked = await page.evaluate(() => {
      const hit = Array.from(document.querySelectorAll('#adminmenu a, a')).find((a) =>
        /mac role|role url/i.test((a.textContent || '').trim())
      );
      if (hit) {
        hit.click();
        return true;
      }
      return false;
    });
    if (clicked) {
      await page.waitForNavigation(GOTO).catch(() => {});
      await sleep(300);
    }
  }

  const altLabels = [
    `Create from "${packageTier} Package User"`,
    'Create from "F Package User"',
    'Create from "F-Package User"',
  ];

  log('Bấm Create from "F Package User"...');
  let clicked = false;
  for (const label of altLabels) {
    try {
      await clickByText(page, label, { timeout: 4000 });
      clicked = true;
      break;
    } catch {
      /* next */
    }
  }

  if (!clicked) {
    clicked = await page.evaluate(() => {
      const btns = Array.from(
        document.querySelectorAll('a, button, input[type="button"], input[type="submit"]')
      );
      const hit = btns.find((el) =>
        /create from\s*["']?f\s*package\s*user["']?/i.test(
          (el.innerText || el.value || '').trim()
        )
      );
      if (hit) {
        hit.click();
        return true;
      }
      return false;
    });
  }

  if (!clicked) {
    throw new Error('Không tìm thấy nút Create from "F Package User" trên trang Mac Role.');
  }

  log('Đã bấm Create from "F Package User" — chờ load xong...');
  await page.waitForNavigation(GOTO).catch(() => {});
  await sleep(600);

  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    const busy = await page.evaluate(
      () => !!document.querySelector('.spinner.is-active, .updating-message, .is-loading')
    );
    if (!busy) break;
    await sleep(300);
  }

  log('Mac Role: F Package User đã tạo xong.');
}
