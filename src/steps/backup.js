import fs from 'fs';
import path from 'path';
import {
  originOf,
  clickFirst,
  sleep,
  sleepExact,
  DOWNLOADS_DIR,
  ensureDirs,
  dismissBlockingAlerts,
} from '../utils.js';

const GOTO = { waitUntil: 'domcontentloaded', timeout: 60000 };

/** Tên an toàn cho Windows folder/file */
function sanitizeFolderName(name) {
  return (
    String(name || '')
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120) || 'backup'
  );
}

/** VD: "Olivia & Oliver Nail Lounge - backup - 20_07_26" */
export function makeBackupBundleLabel(projectName, date = new Date()) {
  const dd = String(date.getDate()).padStart(2, '0');
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const yy = String(date.getFullYear()).slice(-2);
  const shop = sanitizeFolderName(projectName || 'Unknown shop');
  return `${shop} - backup - ${dd}_${mm}_${yy}`;
}

async function assertNotForbidden(page) {
  const denied = await page.evaluate(() => {
    const t = document.body?.innerText || '';
    return /not allowed to access this page|không được phép truy cập/i.test(t);
  });
  if (denied) {
    throw new Error(
      'WP báo "Sorry, you are not allowed to access this page." — thường do chưa Activate UpdraftPlus hoặc session/capability lỗi.'
    );
  }
}

async function ensureUpdraftInstalledAndActive(page, base, log) {
  // Đã active? Thử mở thẳng trang Updraft
  log('Kiểm tra UpdraftPlus đã sẵn sàng chưa...');
  await page.goto(`${base}/wp-admin/options-general.php?page=updraftplus`, GOTO);
  await sleep(300);
  const alreadyOk = await page.evaluate(() => {
    const t = document.body?.innerText || '';
    if (/not allowed to access this page/i.test(t)) return false;
    return /backup now|updraftplus|existing backups/i.test(t);
  });
  if (alreadyOk) {
    log('UpdraftPlus đã active — vào settings được.');
    return;
  }

  // Mọi dialog "Leave site?" / beforeunload → Leave
  const onDialog = async (dialog) => {
    const msg = dialog.message() || '';
    log(`Dialog: "${msg.slice(0, 80)}" → Leave/OK`);
    try {
      await dialog.accept();
    } catch {
      /* ignore */
    }
  };
  page.on('dialog', onDialog);

  try {
    const addPluginsUrl =
      `${base}/wp-admin/plugin-install.php?s=updraftplus&tab=search&type=term`;

    const readCard = () =>
      page.evaluate(() => {
        const card =
          document.querySelector('.plugin-card-updraftplus') ||
          Array.from(document.querySelectorAll('.plugin-card')).find((c) => {
            const name = (c.querySelector('.name, h3')?.innerText || '').toLowerCase();
            return (
              name.includes('updraftplus') &&
              !name.includes('exclude') &&
              !name.includes('thumbnail')
            );
          });
        if (!card) return { status: 'no-card' };
        const t = (card.innerText || '').toLowerCase();
        if (t.includes('installing') || t.includes('updating')) {
          return { status: 'installing' };
        }
        const hasActivate = Array.from(card.querySelectorAll('a, button')).some((el) =>
          /^activate$/i.test((el.innerText || el.textContent || '').trim())
        );
        const hasInstall = Array.from(card.querySelectorAll('a, button')).some((el) =>
          /install now/i.test((el.innerText || el.textContent || '').trim())
        );
        if (/active|activated|network active/i.test(t) && !hasInstall && !hasActivate) {
          return { status: 'already-active' };
        }
        if (hasActivate) return { status: 'ready-to-activate' };
        if (hasInstall) return { status: 'need-install' };
        return { status: 'waiting' };
      });

    const clickOnCard = (action) =>
      page.evaluate((action) => {
        const card =
          document.querySelector('.plugin-card-updraftplus') ||
          Array.from(document.querySelectorAll('.plugin-card')).find((c) => {
            const name = (c.querySelector('.name, h3')?.innerText || '').toLowerCase();
            return name.includes('updraftplus') && !name.includes('exclude');
          });
        if (!card) return false;
        const re = action === 'install' ? /install now/i : /^activate$/i;
        const btn = Array.from(card.querySelectorAll('a, button')).find((el) =>
          re.test((el.innerText || el.textContent || '').trim())
        );
        if (!btn) return false;
        btn.click();
        return true;
      }, action);

    // --- Add Plugins: Install → chờ Activate hiện → bấm Activate (không reload) ---
    log('Mở Add Plugins...');
    await page.goto(addPluginsUrl, GOTO);
    await sleep(500);

    let state = await readCard();
    if (state.status === 'no-card') {
      throw new Error('Không thấy card UpdraftPlus trên Add Plugins.');
    }

    if (state.status === 'need-install') {
      log('Bấm Install Now...');
      if (!(await clickOnCard('install'))) {
        throw new Error('Không bấm được Install Now.');
      }
    }

    if (state.status !== 'already-active') {
      log('Chờ nút Activate hiện ra (chưa bấm sớm)...');
      const deadline = Date.now() + 180000;
      while (Date.now() < deadline) {
        await sleep(500);
        state = await readCard();
        if (state.status === 'installing') {
          log('… đang Installing… chờ...');
          await sleep(5000);
          continue;
        }
        if (state.status === 'ready-to-activate') {
          log('Đã hiện Activate — bấm Activate trên card...');
          if (!(await clickOnCard('activate'))) {
            throw new Error('Không bấm được Activate trên card.');
          }
          await page
            .waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 45000 })
            .catch(() => {});
          await sleep(500);
          break;
        }
        if (state.status === 'already-active') {
          log('Card báo đã active.');
          break;
        }
        if (state.status === 'need-install') {
          // đôi khi AJAX fail — thử Install lại
          log('Vẫn thấy Install Now — thử Install lại...');
          await clickOnCard('install');
        }
      }
      if (state.status !== 'ready-to-activate' && state.status !== 'already-active') {
        // vòng lặp hết mà chưa kịp break sau activate
        state = await readCard();
        if (state.status === 'ready-to-activate') {
          await clickOnCard('activate');
          await page
            .waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 45000 })
            .catch(() => {});
          await sleep(500);
        } else if (state.status !== 'already-active') {
          log('⚠ Chưa Activate được trên card — sẽ kiểm tra trên Plugins list.');
        }
      }
    }

    // --- Plugins list: tìm Updraft → Activate lần nữa nếu chưa active; chờ + lặp ---
    log('Vào Plugins list — kiểm tra / Activate lại nếu cần...');
    const pluginsDeadline = Date.now() + 120000;
    let confirmedActive = false;

    while (Date.now() < pluginsDeadline) {
      await page.goto(`${base}/wp-admin/plugins.php`, GOTO);
      await sleep(500);

      const status = await page.evaluate(() => {
        const rows = Array.from(document.querySelectorAll('#the-list tr, tr'));
        for (const row of rows) {
          const text = row.innerText || '';
          if (!/updraftplus/i.test(text)) continue;
          // Tránh nhầm plugin "Exclude ... UpdraftPlus"
          const title =
            row.querySelector('.plugin-title strong, .plugin-title')?.innerText || text;
          if (/exclude/i.test(title) && !/^updraftplus/i.test(title.trim())) continue;

          const activate = row.querySelector('a[href*="action=activate"]');
          const deactivate = row.querySelector('a[href*="action=deactivate"]');
          return {
            found: true,
            active: !!deactivate,
            activateHref: activate?.getAttribute('href') || null,
          };
        }
        return { found: false, active: false, activateHref: null };
      });

      if (!status.found) {
        log('… chưa thấy UpdraftPlus trong Plugins — chờ rồi thử lại...');
        await sleep(700);
        continue;
      }

      if (status.active) {
        log('UpdraftPlus đã Active trên Plugins list.');
        confirmedActive = true;
        break;
      }

      if (status.activateHref) {
        log('Chưa Active trên Plugins — Activate lần nữa...');
        const href = status.activateHref.startsWith('http')
          ? status.activateHref
          : `${base}/wp-admin/${status.activateHref.replace(/^\//, '')}`;
        await page.goto(href, GOTO);
        await sleep(600);
        // vòng tiếp sẽ xác nhận lại
        continue;
      }

      log('… thấy plugin nhưng chưa rõ trạng thái — chờ rồi thử lại...');
      await sleep(700);
    }

    if (!confirmedActive) {
      // Kiểm tra lần cuối
      await page.goto(`${base}/wp-admin/plugins.php`, GOTO);
      await sleep(400);
      confirmedActive = await page.evaluate(() => {
        const rows = Array.from(document.querySelectorAll('#the-list tr, tr'));
        for (const row of rows) {
          if (!/updraftplus/i.test(row.innerText || '')) continue;
          if (row.querySelector('a[href*="action=deactivate"]')) return true;
        }
        return false;
      });
    }

    if (!confirmedActive) {
      throw new Error(
        'UpdraftPlus chưa Active sau khi chờ / Activate trên card + Plugins list.'
      );
    }

    // Vào settings
    log('Vào /wp-admin/options-general.php?page=updraftplus ...');
    await page.goto(`${base}/wp-admin/options-general.php?page=updraftplus`, GOTO);
    await sleep(350);
    await assertNotForbidden(page);

    const opened = await page.evaluate(() =>
      /backup now|updraftplus|existing backups/i.test(document.body?.innerText || '')
    );
    if (!opened) {
      throw new Error('Đã Active nhưng không mở được trang UpdraftPlus settings.');
    }
    log('UpdraftPlus sẵn sàng.');
  } finally {
    page.off('dialog', onDialog);
  }
}

async function openUpdraftPage(page, base, log) {
  // Prefer URL chuẩn; nếu vừa install xong thường đã ở đây
  const url = `${base}/wp-admin/options-general.php?page=updraftplus`;
  if (!page.url().includes('page=updraftplus')) {
    log(`Mở ${url.replace(base, '')}`);
    await page.goto(url, GOTO);
    await sleep(350);
  }
  await assertNotForbidden(page);
  const ok = await page.evaluate(() =>
    /backup now|updraftplus|existing backups/i.test(document.body?.innerText || '')
  );
  if (ok) return true;

  // Fallback menu
  const clicked = await page.evaluate(() => {
    const hit = Array.from(document.querySelectorAll('#adminmenu a, a')).find((a) =>
      /updraft/i.test((a.textContent || '').trim())
    );
    if (hit) {
      hit.click();
      return true;
    }
    return false;
  });
  if (clicked) {
    await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await sleep(300);
    return page.evaluate(() =>
      /backup now|updraftplus|existing backups/i.test(document.body?.innerText || '')
    );
  }
  return false;
}

export async function installAndBackupUpdraftPlus(page, options = {}, log) {
  const base = originOf(page.url());
  ensureDirs();

  await ensureUpdraftInstalledAndActive(page, base, log);

  log('Mở UpdraftPlus → Backup Now...');
  const opened = await openUpdraftPage(page, base, log);
  if (!opened) {
    throw new Error(
      'Không mở được trang UpdraftPlus (permission hoặc plugin chưa active). Kiểm tra Plugins → UpdraftPlus.'
    );
  }

  // Snapshot backup mới nhất HIỆN CÓ — sau này chỉ tải hàng mới hơn
  const beforeSnap = await snapshotNewestBackup(page);
  log(
    beforeSnap
      ? `Backup sẵn có (mới nhất): ${beforeSnap.label} (ts=${beforeSnap.timestamp})`
      : 'Chưa có backup sẵn — lần này sẽ là backup đầu.'
  );

  // Backup Now
  const clickedBackup = await page.evaluate(() => {
    const btn =
      document.querySelector('#updraft-backupnow-button') ||
      Array.from(document.querySelectorAll('button, a, input[type="button"]')).find((el) =>
        /backup now/i.test((el.innerText || el.value || '').trim())
      );
    if (btn) {
      btn.click();
      return true;
    }
    return false;
  });
  if (!clickedBackup) {
    try {
      await clickFirst(
        page,
        ['#updraft-backupnow-button', 'button#updraft-backupnow-button'],
        { timeout: 8000 }
      );
    } catch {
      throw new Error('Không tìm thấy nút Backup Now.');
    }
  }
  await sleep(200);

  // Confirm modal
  await page.evaluate(() => {
    const modalBtns = Array.from(
      document.querySelectorAll('.updraft_backup_btn, button, input[type="button"], a.button')
    );
    const confirm = modalBtns.find((el) =>
      /backup now/i.test((el.innerText || el.value || '').trim())
    );
    const inModal = modalBtns.find((el) => {
      const inDlg = el.closest(
        '.ui-dialog, .updraft_backup_modal, #updraft-backupnow-modal, .ud_dialog'
      );
      return inDlg && /backup now/i.test((el.innerText || el.value || '').trim());
    });
    (inModal || confirm)?.click();
  });

  // 1) Chờ backup MỚI thật sự xong (không tin text cũ trên trang)
  await waitUntilNewBackupReady(page, base, beforeSnap, log);

  // 2) Tải file về máy — chỉ khi tick option (không zip)
  if (options.downloadBackup) {
    log('Reload trang UpdraftPlus rồi tải file backup MỚI (không zip)...');
    await page.goto(`${base}/wp-admin/options-general.php?page=updraftplus`, GOTO);
    await sleepExact(1500);
    await dismissBlockingAlerts(page, log);
    await downloadUpdraftBackupParts(page, base, log, beforeSnap, options.projectName);
  } else {
    log('⏭ Bỏ qua tải file backup về máy (không tick option).');
  }
}

/**
 * Đọc hàng backup mới nhất trong Existing Backups (theo data-timestamp / ngày giờ).
 * @returns {{ timestamp: number, label: string, rowKey: string } | null}
 */
async function snapshotNewestBackup(page) {
  return page.evaluate(() => {
    const root =
      document.querySelector('#updraft_existing_backups') ||
      document.querySelector('#updraft-navtab-backups-content') ||
      document.body;

    const rows = Array.from(
      root.querySelectorAll(
        'tr.updraft_existing_backups_row, tr[class*="updraft"], tr, .updraft_existing_backups_row'
      )
    ).filter((tr) => {
      const t = tr.innerText || '';
      return (
        (/restore/i.test(t) || /delete/i.test(t)) &&
        (/database/i.test(t) || /plugins/i.test(t) || /themes/i.test(t))
      );
    });

    const parseTs = (el) => {
      const attrs = [
        el.getAttribute('data-timestamp'),
        el.getAttribute('data-nonce'),
        el.dataset?.timestamp,
        el.id,
      ]
        .filter(Boolean)
        .join(' ');
      const m = attrs.match(/(\d{9,13})/);
      if (m) return Number(m[1]) > 1e12 ? Math.floor(Number(m[1]) / 1000) : Number(m[1]);

      // Ngày trong text: "20 Jul 2026 10:05" / "July 20, 2026 10:05 am"
      const text = (el.innerText || '').replace(/\s+/g, ' ');
      const d = Date.parse(text.slice(0, 80));
      if (!Number.isNaN(d)) return Math.floor(d / 1000);

      // updraft filename pattern backup_YYYY-MM-DD-HHiiss
      const fm = text.match(/(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})(\d{2})/);
      if (fm) {
        const iso = `${fm[1]}-${fm[2]}-${fm[3]}T${fm[4]}:${fm[5]}:${fm[6]}`;
        const t = Date.parse(iso);
        if (!Number.isNaN(t)) return Math.floor(t / 1000);
      }
      return 0;
    };

    let best = null;
    for (const row of rows) {
      const ts = parseTs(row);
      const label = (row.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 100);
      if (!best || ts > best.timestamp) {
        const key = `afp-backup-${ts}-${Math.random().toString(36).slice(2, 6)}`;
        best = { timestamp: ts, label, rowKey: key, el: row };
      }
    }
    if (!best) return null;
    best.el.setAttribute('data-afp-backup-row', best.rowKey);
    return { timestamp: best.timestamp, label: best.label, rowKey: best.rowKey };
  });
}

/**
 * Chờ backup mới hoàn tất:
 * - Có tín hiệu complete trên UI progress
 * - VÀ hàng Existing Backups mới hơn snapshot trước Backup Now
 */
async function waitUntilNewBackupReady(page, base, beforeSnap, log) {
  log('Đang chờ backup MỚI hoàn tất (không tải backup cũ)...');
  const deadline = Date.now() + 360000; // 6 phút
  let sawProgress = false;
  let sawComplete = false;
  let lastLog = 0;

  while (Date.now() < deadline) {
    const state = await page.evaluate(() => {
      const body = document.body?.innerText || '';
      const progress =
        /backup.*progress|backing up|creating backup|database.*backup|uploaded.*%/i.test(body) ||
        !!document.querySelector(
          '#updraft-jobstatus, .updraft_finished, #updraft_lastlogmessagerow, .updraft-progress'
        );
      // Complete — tránh match mơ hồ "succeeded" trong notice cũ
      const complete =
        /backup\s*(apparently\s*)?(succeeded|complete|finished)/i.test(body) ||
        /the backup apparently succeeded/i.test(body) ||
        /backup complete/i.test(body) ||
        !!document.querySelector('.updraft_finished, #updraft-backup-complete');
      const active =
        /backup in progress|currently being backed|is running|please wait/i.test(body) ||
        !!document.querySelector('.updraft_active_job, #updraft_activejobs_table .job');
      return { progress, complete, active, snippet: body.replace(/\s+/g, ' ').slice(0, 200) };
    });

    if (state.progress || state.active) sawProgress = true;
    if (state.complete && (sawProgress || !beforeSnap)) sawComplete = true;

    // Poll hàng backup mới nhất
    const newest = await snapshotNewestBackup(page);
    const isNewer =
      newest &&
      (!beforeSnap ||
        newest.timestamp > beforeSnap.timestamp ||
        (newest.timestamp === beforeSnap.timestamp &&
          newest.label !== beforeSnap.label &&
          newest.timestamp > 0) ||
        (beforeSnap.timestamp === 0 && newest.timestamp > 0));

    // Cùng timestamp nhưng row mới (ts=0 fallback): so sánh label khác
    const labelChanged =
      newest && beforeSnap && newest.label && newest.label !== beforeSnap.label;

    if (Date.now() - lastLog > 15000) {
      log(
        `… chờ backup: progress=${sawProgress}, complete=${!!state.complete}, ` +
          `newest=${newest ? `${newest.label.slice(0, 60)} (ts=${newest.timestamp})` : 'n/a'}`
      );
      lastLog = Date.now();
    }

    // Điều kiện xong: có hàng mới HƠN trước đó, và (đã thấy complete HOẶC đã thấy progress rồi hết active)
    if (isNewer && (sawComplete || (sawProgress && !state.active && state.complete))) {
      log(
        `Backup mới đã xong: ${newest.label.slice(0, 80)} (ts=${newest.timestamp}` +
          (beforeSnap ? `, trước=${beforeSnap.timestamp}` : '') +
          ')'
      );
      await sleepExact(3000);
      return newest;
    }

    // Nếu chưa có beforeSnap: cần complete + có ít nhất 1 row
    if (!beforeSnap && newest && (sawComplete || (state.complete && !state.active))) {
      log(`Backup đầu tiên xong: ${newest.label.slice(0, 80)} (ts=${newest.timestamp})`);
      await sleepExact(3000);
      return newest;
    }

    // Thỉnh thoảng Updraft cập nhật list chậm — rescan
    if (sawComplete && !isNewer && Date.now() % 20000 < 1200) {
      await page.evaluate(() => {
        const btn = Array.from(document.querySelectorAll('a, button')).find((el) =>
          /rescan|re-scan|refresh.*local|scan.*backup/i.test((el.innerText || '').trim())
        );
        btn?.click();
      });
    }

    // Fallback: complete + label đổi (khi không parse được timestamp)
    if (sawComplete && labelChanged && !state.active) {
      log(`Backup mới (đổi label): ${newest.label.slice(0, 80)}`);
      await sleepExact(3000);
      return newest;
    }

    await sleepExact(1500);
  }

  // Hết giờ — kiểm tra lần cuối
  const newest = await snapshotNewestBackup(page);
  if (newest && beforeSnap && newest.timestamp > beforeSnap.timestamp) {
    log(`Hết thời gian chờ nhưng đã có backup mới hơn (ts=${newest.timestamp}) — tiếp tục tải.`);
    return newest;
  }

  throw new Error(
    'Timeout: backup mới chưa xong / chưa thấy hàng backup mới hơn bản cũ. Không tải backup cũ.'
  );
}

/**
 * Tìm nút Database/Plugins/... CHỈ trong hàng backup mới nhất (hoặc mới hơn beforeSnap).
 */
async function findUpdraftPartButtons(page, beforeSnap = null) {
  return page.evaluate((beforeTs) => {
    const parts = ['Database', 'Plugins', 'Themes', 'Uploads', 'Others'];
    const root =
      document.querySelector('#updraft_existing_backups') ||
      document.querySelector('#updraft-navtab-backups-content') ||
      document.body;

    const parseTs = (el) => {
      const attrs = [
        el.getAttribute('data-timestamp'),
        el.getAttribute('data-nonce'),
        el.dataset?.timestamp,
        el.id,
      ]
        .filter(Boolean)
        .join(' ');
      const m = attrs.match(/(\d{9,13})/);
      if (m) return Number(m[1]) > 1e12 ? Math.floor(Number(m[1]) / 1000) : Number(m[1]);
      const text = (el.innerText || '').replace(/\s+/g, ' ');
      const d = Date.parse(text.slice(0, 80));
      if (!Number.isNaN(d)) return Math.floor(d / 1000);
      const fm = text.match(/(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})(\d{2})/);
      if (fm) {
        const t = Date.parse(`${fm[1]}-${fm[2]}-${fm[3]}T${fm[4]}:${fm[5]}:${fm[6]}`);
        if (!Number.isNaN(t)) return Math.floor(t / 1000);
      }
      return 0;
    };

    let rows = Array.from(
      root.querySelectorAll(
        'tr.updraft_existing_backups_row, tr[class*="updraft"], tr, .updraft_existing_backups_row'
      )
    ).filter((tr) => {
      const t = tr.innerText || '';
      return (
        (/restore/i.test(t) || /delete/i.test(t)) &&
        (/database/i.test(t) || /plugins/i.test(t))
      );
    });

    // Chỉ giữ hàng mới hơn backup cũ (nếu có)
    if (beforeTs != null && beforeTs > 0) {
      const newer = rows.filter((r) => parseTs(r) > beforeTs);
      if (newer.length) rows = newer;
    }

    // Chọn đúng 1 hàng mới nhất theo timestamp
    let newestRow = null;
    let newestTs = -1;
    for (const row of rows) {
      const ts = parseTs(row);
      if (ts >= newestTs) {
        newestTs = ts;
        newestRow = row;
      }
    }
    // Updraft thường để hàng mới nhất ở trên — nếu ts bằng nhau lấy rows[0]
    if (!newestRow && rows.length) newestRow = rows[0];
    if (newestRow && newestTs <= 0 && rows.length) newestRow = rows[0];

    const scopes = newestRow ? [newestRow] : [];

    const scoreEl = (el, part) => {
      const text = (el.innerText || el.textContent || el.value || '')
        .replace(/\s+/g, ' ')
        .trim();
      const title = (el.getAttribute('title') || '').trim();
      const aria = (el.getAttribute('aria-label') || '').trim();
      const dataWhat = (
        el.getAttribute('data-what') ||
        el.getAttribute('data-type') ||
        ''
      ).toLowerCase();
      const onclick = (el.getAttribute('onclick') || '').toLowerCase();
      const cls = (el.className || '').toString().toLowerCase();
      const blob = `${text} ${title} ${aria}`.trim();

      if (new RegExp(`^${part}$`, 'i').test(text)) return 100;
      if (new RegExp(`^${part}$`, 'i').test(title) || new RegExp(`^${part}$`, 'i').test(aria))
        return 90;
      if (text.length < 40 && new RegExp(`^${part}\\b`, 'i').test(text)) return 80;
      if (part === 'Database' && (dataWhat === 'db' || /['"]db['"]/.test(onclick))) return 70;
      if (part === 'Plugins' && (dataWhat === 'plugins' || /plugins/.test(onclick))) return 70;
      if (part === 'Themes' && (dataWhat === 'themes' || /themes/.test(onclick))) return 70;
      if (part === 'Uploads' && (dataWhat === 'uploads' || /uploads/.test(onclick))) return 70;
      if (part === 'Others' && (dataWhat === 'others' || /others/.test(onclick))) return 70;
      if (cls.includes('updraft') && new RegExp(part, 'i').test(blob) && blob.length < 50) return 60;
      return 0;
    };

    // Xóa mark cũ
    document.querySelectorAll('[data-afp-part]').forEach((el) => el.removeAttribute('data-afp-part'));
    if (newestRow) newestRow.setAttribute('data-afp-newest-row', '1');

    const found = {};
    for (const part of parts) {
      let best = null;
      let bestScore = 0;
      for (const scope of scopes) {
        const candidates = Array.from(
          scope.querySelectorAll(
            'a, button, span, input[type="button"], input[type="submit"], [onclick], [data-what], [title]'
          )
        );
        for (const el of candidates) {
          const s = scoreEl(el, part);
          if (s > bestScore) {
            bestScore = s;
            best = el;
          }
        }
      }
      if (best && bestScore >= 60) {
        best.setAttribute('data-afp-part', part.toLowerCase());
        found[part] = {
          score: bestScore,
          text: (best.innerText || best.title || '').trim().slice(0, 40),
        };
      }
    }

    return {
      ok: Object.keys(found).length >= 3,
      count: Object.keys(found).length,
      found,
      newestTs,
      debug: {
        hasSection: !!document.querySelector('#updraft_existing_backups'),
        rowCount: rows.length,
        sample: (newestRow?.innerText || '').replace(/\s+/g, ' ').slice(0, 160),
      },
    };
  }, beforeSnap?.timestamp ?? null);
}

async function waitForBackupRow(page, base, log, beforeSnap = null) {
  const deadline = Date.now() + 120000;
  let attempt = 0;

  while (Date.now() < deadline) {
    attempt += 1;

    await page.evaluate(() => {
      const el =
        document.querySelector('#updraft_existing_backups') ||
        Array.from(document.querySelectorAll('h2,h3,h4')).find((h) =>
          /existing backups/i.test(h.innerText || '')
        );
      el?.scrollIntoView?.({ block: 'center' });
    });
    await sleep(200);

    const info = await findUpdraftPartButtons(page, beforeSnap);
    const isNewEnough =
      !beforeSnap?.timestamp ||
      (info.newestTs > 0 && info.newestTs > beforeSnap.timestamp);

    if (info.ok && isNewEnough) {
      log(
        `Thấy ${info.count}/5 nút download trên backup mới nhất (#${attempt}, ts=${info.newestTs}): ${Object.keys(info.found).join(', ')}`
      );
      return true;
    }

    // Không parse được ts nhưng đã qua bước chờ backup mới — dùng hàng đầu Updraft (mới nhất)
    if (info.ok && beforeSnap?.timestamp && info.newestTs === 0 && attempt >= 3) {
      log(
        `Thấy ${info.count}/5 nút (không đọc được timestamp) — dùng hàng đầu Existing Backups (#${attempt}).`
      );
      return true;
    }

    if (attempt <= 3 || attempt % 5 === 0) {
      log(
        `Chưa sẵn sàng tải (#${attempt}) — found=${info.count}, newestTs=${info.newestTs}, before=${beforeSnap?.timestamp ?? 'n/a'}, sample="${info.debug?.sample || ''}"`
      );
    }

    if (attempt % 5 === 0) {
      await page.goto(`${base}/wp-admin/options-general.php?page=updraftplus`, {
        waitUntil: 'domcontentloaded',
        timeout: 45000,
      });
      await sleep(800);
      await page.evaluate(() => {
        const btn = Array.from(document.querySelectorAll('a, button')).find((el) =>
          /rescan|re-scan|refresh.*backup|scan.*backup/i.test((el.innerText || '').trim())
        );
        btn?.click();
      });
      await sleep(600);
    } else {
      await sleep(800);
    }
  }

  return false;
}

/**
 * Sau backup: click 5 nút Database/Plugins/Themes/Uploads/Others
 * CHỈ trên hàng backup mới nhất (mới hơn beforeSnap).
 */
async function downloadUpdraftBackupParts(page, base, log, beforeSnap = null, projectName = '') {
  log('Tải backup: chỉ lấy hàng MỚI NHẤT theo thời gian...');
  await dismissBlockingAlerts(page, log);

  const newest = await snapshotNewestBackup(page);
  if (beforeSnap?.timestamp && newest?.timestamp && newest.timestamp <= beforeSnap.timestamp) {
    log(
      `⚠ Backup mới nhất trên list (ts=${newest.timestamp}) không mới hơn bản trước Backup Now (ts=${beforeSnap.timestamp}) — không tải backup cũ.`
    );
    throw new Error('Chưa có backup mới hơn trên Existing Backups — bỏ qua download để tránh tải bản cũ.');
  }
  if (newest) {
    log(`Sẽ tải backup: ${newest.label.slice(0, 100)} (ts=${newest.timestamp})`);
  }

  const ready = await waitForBackupRow(page, base, log, beforeSnap);
  if (!ready) {
    log('⚠ Timeout: không thấy nút Database/Plugins/... trên backup mới — bỏ qua download.');
    return;
  }

  const bundleLabel = makeBackupBundleLabel(projectName);
  const jobDir = path.join(DOWNLOADS_DIR, bundleLabel);
  fs.mkdirSync(jobDir, { recursive: true });
  log(`Thư mục tải file: ${path.resolve(jobDir)}`);

  const client = await page.createCDPSession();
  await client.send('Page.setDownloadBehavior', {
    behavior: 'allow',
    downloadPath: jobDir,
  });

  const parts = ['Database', 'Plugins', 'Themes', 'Uploads', 'Others'];
  const clicked = [];

  for (const label of parts) {
    await findUpdraftPartButtons(page, beforeSnap);

    let ok = false;
    for (let tryN = 0; tryN < 4 && !ok; tryN += 1) {
      ok = await page.evaluate((part) => {
        const row =
          document.querySelector('[data-afp-newest-row="1"]') ||
          document.querySelector('#updraft_existing_backups');
        const marked =
          row?.querySelector(`[data-afp-part="${part.toLowerCase()}"]`) ||
          document.querySelector(`[data-afp-part="${part.toLowerCase()}"]`);
        if (marked) {
          marked.scrollIntoView?.({ block: 'center' });
          marked.click();
          return true;
        }
        const scope = row || document.body;
        const candidates = Array.from(
          scope.querySelectorAll('a, button, span, input[type="button"], [onclick]')
        );
        const btn = candidates.find((el) => {
          const text = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
          return text.length < 40 && new RegExp(`^${part}\\b`, 'i').test(text);
        });
        if (btn) {
          btn.scrollIntoView?.({ block: 'center' });
          btn.click();
          return true;
        }
        return false;
      }, label);

      if (!ok) {
        await findUpdraftPartButtons(page, beforeSnap);
        await sleep(400);
      }
    }

    if (ok) {
      clicked.push(label);
      log(`  → đã chọn ${label}`);
      await sleep(500);
    } else {
      log(`  ⚠ không thấy nút ${label}`);
    }
  }

  if (!clicked.length) {
    log('⚠ Không click được các phần backup — bỏ qua download.');
    return;
  }

  log('Chờ panel File ready / Download to your computer...');
  const need = clicked.length;
  const deadline = Date.now() + 180000;
  let readyCount = 0;
  while (Date.now() < deadline) {
    readyCount = await page.evaluate(() =>
      Array.from(document.querySelectorAll('a, button')).filter((el) =>
        /download to your computer/i.test((el.innerText || el.textContent || '').trim())
      ).length
    );
    if (readyCount >= need) break;
    await sleep(500);
  }

  if (readyCount === 0) {
    log('⚠ Không thấy nút "Download to your computer" — bỏ qua tải file.');
    return;
  }

  log(`Thấy ${readyCount}/${need} nút Download — tải về máy...`);

  for (let i = 0; i < readyCount; i += 1) {
    const clickedOne = await page.evaluate((index) => {
      const btns = Array.from(document.querySelectorAll('a, button')).filter((el) =>
        /download to your computer/i.test((el.innerText || el.textContent || '').trim())
      );
      const btn = btns[index];
      if (!btn) return false;
      btn.click();
      return true;
    }, i);
    if (clickedOne) {
      log(`  → Download to your computer (#${i + 1})`);
      await sleep(700);
    }
  }

  log('Chờ file về ổ đĩa...');
  const waitUntil = Date.now() + 180000;
  let files = [];
  while (Date.now() < waitUntil) {
    const all = fs.readdirSync(jobDir);
    const stillDownloading = all.some((f) => f.endsWith('.crdownload') || f.endsWith('.tmp'));
    files = all.filter(
      (f) => !f.endsWith('.crdownload') && !f.endsWith('.tmp')
    );
    if (files.length > 0 && !stillDownloading) {
      await sleep(500);
      files = fs
        .readdirSync(jobDir)
        .filter((f) => !f.endsWith('.crdownload') && !f.endsWith('.tmp'));
      break;
    }
    await sleep(500);
  }

  if (!files.length) {
    log(`⚠ Thư mục trống: ${path.resolve(jobDir)}`);
    return;
  }

  log(`Đã tải ${files.length} file vào: ${path.resolve(jobDir)}`);
  for (const f of files) log(`  • ${f}`);
}



