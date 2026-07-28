import {
  originOf,
  clickByText,
  sleep,
  sleepExact,
  dismissBlockingAlerts,
  evaluateSafe,
} from '../utils.js';

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
      refreshed = await evaluateSafe(page, () => {
        const btn = Array.from(document.querySelectorAll('button, a, input[type="button"]')).find(
          (el) => /refresh\s+plugin\s*list/i.test((el.innerText || el.value || '').trim())
        );
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
  } finally {
    page.off('dialog', onDialog);
  }
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

/**
 * Vào /wp-admin/admin.php?page=mac-role
 * → bấm Create from "F Package User" → chờ load xong (có heartbeat log).
 */
export async function configureFPackageUser(page, packageTier = 'F', log) {
  const base = originOf(page.url());
  const GOTO = { waitUntil: 'domcontentloaded', timeout: 60000 };
  const url = `${base}/wp-admin/admin.php?page=mac-role`;

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

  const altLabels = [
    `Create from "${packageTier} Package User"`,
    'Create from "F Package User"',
    'Create from "F-Package User"',
    'Create from F Package User',
  ];

  log('Bấm Create from "F Package User"...');

  const mark = await evaluateSafe(page, () => {
    const btns = Array.from(
      document.querySelectorAll(
        'a, button, input[type="button"], input[type="submit"], [role="button"]'
      )
    );
    const hit = btns.find((el) =>
      /create from\s*["']?f[\s-]*package\s*user["']?/i.test(
        (el.innerText || el.value || el.textContent || '').trim()
      )
    );
    if (!hit) return null;
    const id = `afp-create-fpkg-${Date.now()}`;
    hit.setAttribute('data-afp-create', id);
    hit.scrollIntoView?.({ block: 'center' });
    return id;
  }).catch(() => null);

  let clicked = false;
  if (mark) {
    const sel = `[data-afp-create="${mark}"]`;
    const navWait = page
      .waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 90000 })
      .catch(() => null);
    try {
      await page.click(sel, { delay: 20 });
      clicked = true;
    } catch {
      clicked = await evaluateSafe(
        page,
        (m) => {
          const el = document.querySelector(`[data-afp-create="${m}"]`);
          if (!el) return false;
          el.click();
          return true;
        },
        mark
      ).catch(() => false);
    }

    if (clicked) {
      log('Đã bấm Create — chờ Mac Role xử lý (có thể 30–90s, đừng F5)...');
      const started = Date.now();
      let navDone = false;
      navWait.then(() => {
        navDone = true;
      });
      let lastBeat = 0;
      while (Date.now() - started < 90000) {
        if (navDone) break;
        const elapsed = Math.round((Date.now() - started) / 1000);
        if (elapsed >= 10 && elapsed - lastBeat >= 10) {
          lastBeat = elapsed;
          log(`… Mac Role vẫn đang xử lý Create (${elapsed}s)`);
        }
        await sleep(500);
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
            okHint: /created|updated|role saved|success/i.test(text),
          };
        }).catch(() => null);
        if (
          state?.okHint ||
          (state && !state.busy && !state.stillCreateBtn && elapsed > 3)
        ) {
          break;
        }
      }
      await navWait;
    }
  }

  if (!clicked) {
    for (const label of altLabels) {
      try {
        const navWait = page
          .waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 90000 })
          .catch(() => null);
        await clickByText(page, label, { timeout: 5000 });
        clicked = true;
        log('Đã bấm Create (fallback text) — chờ xử lý...');
        await navWait;
        break;
      } catch {
        /* next */
      }
    }
  }

  if (!clicked) {
    throw new Error('Không tìm thấy nút Create from "F Package User" trên trang Mac Role.');
  }

  await sleep(600);
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    const busy = await evaluateSafe(
      page,
      () => !!document.querySelector('.spinner.is-active, .updating-message, .is-loading')
    ).catch(() => false);
    if (!busy) break;
    await sleep(300);
  }

  log('Mac Role: F Package User đã tạo xong.');
}
