import {
  originOf,
  clickFirst,
  sleep,
  sleepExact,
} from '../utils.js';
import { isHttpStepsEnabled, stripHtmlText } from '../http/wpSession.js';

const GOTO = { waitUntil: 'domcontentloaded', timeout: 60000 };
const UPDRAFT_SLUG = 'updraftplus';
const UPDRAFT_FILE = 'updraftplus/updraftplus.php';

function absWpAdminUrl(base, href) {
  if (!href) return null;
  const h = String(href).replace(/&amp;/g, '&').trim();
  if (/^https?:\/\//i.test(h)) return h;
  if (h.startsWith('//')) return `https:${h}`;
  const path = h.replace(/^\//, '').replace(/^wp-admin\//i, '');
  return `${base}/wp-admin/${path}`;
}

function updraftSettingsOk(html) {
  const t = stripHtmlText(html);
  if (/not allowed to access this page|không được phép truy cập/i.test(t)) return false;
  return /backup now|updraftplus|existing backups/i.test(t);
}

/** Parse link Install Now / Activate Updraft từ HTML admin (tránh nhầm plugin Exclude…). */
function parseUpdraftActionHref(html, kind) {
  const raw = String(html || '');
  if (kind === 'install') {
    const re =
      /href=["']([^"']*update\.php\?[^"']*action=install-plugin[^"']*plugin=updraftplus[^"']*)["']/gi;
    let m;
    while ((m = re.exec(raw))) {
      const href = m[1].replace(/&amp;/g, '&');
      if (/exclude|thumbnail/i.test(href)) continue;
      return href;
    }
    // data-slug="updraftplus" gần install-now
    const card = raw.match(
      /data-slug=["']updraftplus["'][\s\S]{0,400}?href=["']([^"']*install-plugin[^"']*)["']/i
    );
    if (card?.[1]) return card[1].replace(/&amp;/g, '&');
    return null;
  }

  // activate
  const re =
    /href=["']([^"']*action=activate[^"']*plugin=updraftplus(?:%2F|\/)updraftplus\.php[^"']*)["']/gi;
  let m;
  while ((m = re.exec(raw))) {
    const href = m[1].replace(/&amp;/g, '&');
    if (/exclude/i.test(href)) continue;
    return href;
  }
  return null;
}

function pluginRowLooksActive(html) {
  // Có deactivate cho đúng file UpdraftPlus
  return /action=deactivate[^"']*plugin=updraftplus(?:%2F|\/)updraftplus\.php/i.test(
    String(html || '')
  );
}

/**
 * fetch trong Chrome (credentials include) — tránh Node fetch bị WAF/404 giả
 * (giống createUser HTTP).
 */
async function wpFetchInPage(page, url, { method = 'GET', body = null, referer = '' } = {}) {
  return page.evaluate(
    async (u, m, b, ref) => {
      const headers = {
        Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
      };
      if (ref) headers.Referer = ref;
      if (b) headers['Content-Type'] = 'application/x-www-form-urlencoded';
      const res = await fetch(u, {
        method: m,
        credentials: 'include',
        redirect: 'follow',
        headers,
        body: m === 'GET' || m === 'HEAD' ? undefined : b,
      });
      const text = await res.text();
      return { ok: res.ok, status: res.status, url: res.url, text };
    },
    url,
    method,
    body,
    referer || `${new URL(url).origin}/wp-admin/`
  );
}

function httpFailDetail(label, res) {
  const snip = stripHtmlText(res?.text || '').slice(0, 120);
  return `${label} HTTP ${res?.status || '?'} url=${String(res?.url || '').slice(0, 80)} ${snip}`;
}

/**
 * HTTP: check settings → install (wordpress.org) → activate.
 * Dùng fetch trong tab WP (không Node wpFetch) — site macmar hay 404 Node.
 */
export async function ensureUpdraftInstalledAndActiveViaHttp(page, base, log) {
  // Đảm bảo đang ở origin WP (cookie session)
  if (!String(page.url() || '').includes(base.replace(/^https?:\/\//, ''))) {
    await page.goto(`${base}/wp-admin/`, GOTO).catch(() => {});
    await sleep(200);
  }

  const adminRef = `${base}/wp-admin/`;

  log('HTTP: kiểm tra trang UpdraftPlus (in-page)...');
  let settings = await wpFetchInPage(
    page,
    `${base}/wp-admin/options-general.php?page=updraftplus`,
    { referer: adminRef }
  );
  if (updraftSettingsOk(settings.text)) {
    log('UpdraftPlus đã active — vào settings được (HTTP).');
    return { via: 'http', skipped: true };
  }

  log('HTTP: đọc Plugins list (in-page)...');
  let plugins = await wpFetchInPage(page, `${base}/wp-admin/plugins.php`, {
    referer: adminRef,
  });
  // Một số host/WAF trả 404 cho Node; in-page vẫn có thể 404 tạm — không throw ngay
  if (!plugins.ok && plugins.status >= 400) {
    log(`⚠ plugins.php ${plugins.status} — bỏ qua list, thử Add Plugins...`);
    plugins = { ok: false, status: plugins.status, url: plugins.url, text: '' };
  }

  if (pluginRowLooksActive(plugins.text)) {
    log('Plugins list: UpdraftPlus đã Active — thử settings lại...');
    settings = await wpFetchInPage(
      page,
      `${base}/wp-admin/options-general.php?page=updraftplus`,
      { referer: adminRef }
    );
    if (updraftSettingsOk(settings.text)) {
      log('✓ UpdraftPlus sẵn sàng (HTTP).');
      return { via: 'http', skipped: true };
    }
  }

  let activateHref = parseUpdraftActionHref(plugins.text, 'activate');
  const alreadyOnDisk = /updraftplus\/updraftplus\.php|plugin=updraftplus/i.test(
    plugins.text || ''
  );

  if (!activateHref && !alreadyOnDisk) {
    // GET update.php?_wpnonce=… hay bị "link expired" (403).
    // Đúng như nút Install Now: POST admin-ajax action=install-plugin + _ajax_nonce=updates.
    const searchUrl = `${base}/wp-admin/plugin-install.php?s=${UPDRAFT_SLUG}&tab=search&type=term`;
    log('HTTP: mở Add Plugins (lấy updates nonce)...');
    await page.goto(searchUrl, GOTO);
    await sleep(400);

    const cardState = await page.evaluate(() => {
      const card =
        document.querySelector('.plugin-card-updraftplus') ||
        Array.from(document.querySelectorAll('.plugin-card')).find((c) => {
          const name = (c.querySelector('.name, h3')?.innerText || '').toLowerCase();
          return name.includes('updraftplus') && !name.includes('exclude');
        });
      if (!card) return { status: 'no-card' };
      const t = (card.innerText || '').toLowerCase();
      const hasActivate = Array.from(card.querySelectorAll('a, button')).some((el) =>
        /^activate$/i.test((el.innerText || el.textContent || '').trim())
      );
      const hasInstall = Array.from(card.querySelectorAll('a, button')).some((el) =>
        /install now/i.test((el.innerText || el.textContent || '').trim())
      );
      if (hasActivate) return { status: 'ready-to-activate' };
      if (hasInstall) return { status: 'need-install' };
      if (/active|activated/i.test(t)) return { status: 'already-active' };
      return { status: 'waiting' };
    });

    if (cardState.status === 'no-card') {
      throw new Error('Không thấy card UpdraftPlus trên Add Plugins (HTTP).');
    }

    if (cardState.status === 'need-install') {
      log('HTTP: POST admin-ajax install-plugin (updraftplus)...');
      const installRes = await page.evaluate(async (slug) => {
        const ajaxurl = window.ajaxurl || '/wp-admin/admin-ajax.php';
        let nonce =
          window._wpUpdatesSettings?.ajax_nonce ||
          window.wp?.updates?.ajaxNonce ||
          '';
        if (!nonce) {
          for (const s of Array.from(document.querySelectorAll('script'))) {
            const t = s.textContent || '';
            const m =
              t.match(/ajax_nonce["']\s*:\s*["']([a-f0-9]+)["']/i) ||
              t.match(/["']_ajax_nonce["']\s*:\s*["']([a-f0-9]+)["']/i);
            if (m) {
              nonce = m[1];
              break;
            }
          }
        }
        if (!nonce) return { ok: false, error: 'no-updates-nonce' };

        const body = new URLSearchParams();
        body.set('action', 'install-plugin');
        body.set('_ajax_nonce', nonce);
        body.set('slug', slug);

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
          /* ignore */
        }
        return {
          ok: res.ok,
          status: res.status,
          text: text.slice(0, 500),
          json,
          nonceOk: Boolean(nonce),
        };
      }, UPDRAFT_SLUG);

      if (installRes.error === 'no-updates-nonce') {
        throw new Error('Không lấy được _wpUpdatesSettings.ajax_nonce trên Add Plugins.');
      }

      const data = installRes.json?.data || {};
      const success =
        installRes.json?.success === true ||
        data.pluginName ||
        data.activateUrl ||
        /folder_exists|already.?installed/i.test(JSON.stringify(installRes.json || {}));

      // folder_exists = đã có trên disk → sang activate
      const folderExists =
        installRes.json?.success === false &&
        /folder_exists|already.?installed|destination folder already exists/i.test(
          JSON.stringify(installRes.json || installRes.text || '')
        );

      if (!success && !folderExists) {
        throw new Error(
          `Install AJAX fail (${installRes.status}): ${String(
            installRes.json?.data?.errorMessage ||
              installRes.json?.data?.errorCode ||
              installRes.text ||
              ''
          ).slice(0, 180)}`
        );
      }

      if (folderExists) {
        log('⏭ Plugin folder đã có — sang Activate.');
      } else {
        log('✓ Install UpdraftPlus OK (admin-ajax).');
      }

      if (data.activateUrl) {
        activateHref = data.activateUrl;
      }
      await sleepExact(600);
    } else if (cardState.status === 'ready-to-activate') {
      log('Card đã có Activate — bỏ qua Install.');
      activateHref = await page.evaluate(() => {
        const card =
          document.querySelector('.plugin-card-updraftplus') ||
          Array.from(document.querySelectorAll('.plugin-card')).find((c) => {
            const name = (c.querySelector('.name, h3')?.innerText || '').toLowerCase();
            return name.includes('updraftplus') && !name.includes('exclude');
          });
        const a = Array.from(card?.querySelectorAll('a') || []).find((el) =>
          /action=activate/i.test(el.getAttribute('href') || '')
        );
        return a?.getAttribute('href') || null;
      });
    } else if (cardState.status === 'already-active') {
      log('Card báo đã active.');
    }

    plugins = await wpFetchInPage(page, `${base}/wp-admin/plugins.php`, {
      referer: adminRef,
    });
    if (!plugins.ok && plugins.status >= 400) {
      plugins = { ok: false, status: plugins.status, url: plugins.url, text: plugins.text || '' };
    }
    activateHref = activateHref || parseUpdraftActionHref(plugins.text, 'activate');

    if (!activateHref && /updraftplus\/updraftplus\.php/i.test(plugins.text)) {
      const nonce =
        plugins.text.match(
          /action=activate[^"']*plugin=updraftplus(?:%2F|\/)updraftplus\.php[^"']*_wpnonce=([a-f0-9]+)/i
        ) ||
        plugins.text.match(
          /_wpnonce=([a-f0-9]+)[^"']*action=activate[^"']*plugin=updraftplus/i
        );
      if (nonce?.[1]) {
        activateHref = `plugins.php?action=activate&plugin=${encodeURIComponent(UPDRAFT_FILE)}&_wpnonce=${nonce[1]}`;
      }
    }
  }

  if (!pluginRowLooksActive(plugins.text)) {
    if (!activateHref) {
      throw new Error('Không tìm thấy link Activate UpdraftPlus (HTTP).');
    }
    const activateUrl = absWpAdminUrl(base, activateHref);
    // Activate: dùng navigation (nonce cookie ổn định hơn fetch)
    log('HTTP: Activate (goto) …updraftplus/updraftplus.php…');
    await page.goto(activateUrl, GOTO);
    await sleepExact(600);
    plugins = await wpFetchInPage(page, `${base}/wp-admin/plugins.php`, {
      referer: adminRef,
    });
    if (!pluginRowLooksActive(plugins.text)) {
      // Fallback: fetch nếu goto chưa thấy deactivate
      const actRes = await wpFetchInPage(page, activateUrl, {
        referer: `${base}/wp-admin/plugins.php`,
      });
      if (!pluginRowLooksActive(actRes.text) && !pluginRowLooksActive(plugins.text)) {
        throw new Error(
          httpFailDetail('Activate', actRes) || 'Activate xong vẫn chưa thấy Deactivate trên Plugins.'
        );
      }
    }
    log('✓ Activate UpdraftPlus OK (HTTP).');
    await sleepExact(400);
  } else {
    log('⏭ UpdraftPlus đã Active — bỏ qua Activate.');
  }

  settings = await wpFetchInPage(
    page,
    `${base}/wp-admin/options-general.php?page=updraftplus`,
    { referer: adminRef }
  );
  if (!updraftSettingsOk(settings.text)) {
    throw new Error('HTTP: đã cài/activate nhưng không mở được trang UpdraftPlus settings.');
  }
  log('UpdraftPlus sẵn sàng (HTTP).');
  return { via: 'http', skipped: false };
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

async function ensureUpdraftInstalledAndActiveViaBrowser(page, base, log) {
  // Đã active? Thử mở thẳng trang Updraft
  log('Kiểm tra UpdraftPlus đã sẵn sàng chưa (Chrome)...');
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

async function ensureUpdraftInstalledAndActive(page, base, log) {
  if (isHttpStepsEnabled()) {
    try {
      await ensureUpdraftInstalledAndActiveViaHttp(page, base, log);
      // Đồng bộ tab Chrome sang trang Updraft (Backup Now vẫn cần DOM)
      await page.goto(`${base}/wp-admin/options-general.php?page=updraftplus`, GOTO).catch(() => {});
      await sleep(300);
      return;
    } catch (err) {
      log(
        `⚠ Updraft install HTTP fail — fallback Chrome: ${String(err?.message || err).slice(0, 160)}`
      );
    }
  }
  await ensureUpdraftInstalledAndActiveViaBrowser(page, base, log);
}

export async function installAndBackupUpdraftPlus(page, options = {}, log) {
  const base = originOf(page.url());

  await ensureUpdraftInstalledAndActive(page, base, log);

  log('Mở UpdraftPlus → Backup Now...');
  const opened = await openUpdraftPage(page, base, log);
  if (!opened) {
    throw new Error(
      'Không mở được trang UpdraftPlus (permission hoặc plugin chưa active). Kiểm tra Plugins → UpdraftPlus.'
    );
  }

  // Snapshot backup mới nhất HIỆN CÓ — chờ hàng mới hơn sau Backup Now
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

  // Chờ backup MỚI trên site xong — không tải file về máy (dễ timeout/lag)
  await waitUntilNewBackupReady(page, base, beforeSnap, log, options.shouldCancel);
  log('✓ Backup trên site xong — không tải file về máy.');
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

      const text = (el.innerText || '').replace(/\s+/g, ' ');

      // "Jul 29, 2026 21:11" / "29 Jul 2026 21:11" (Updraft hay dùng)
      const mdY =
        text.match(
          /\b((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2},?\s+\d{4}\s+\d{1,2}:\d{2}(?:\s*[ap]m)?)\b/i
        ) ||
        text.match(
          /\b((\d{1,2})\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{4}\s+\d{1,2}:\d{2}(?:\s*[ap]m)?)\b/i
        );
      if (mdY?.[1]) {
        const t = Date.parse(mdY[1].replace(/,/g, ''));
        if (!Number.isNaN(t)) return Math.floor(t / 1000);
      }

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
    let bestIndex = Infinity;
    rows.forEach((row, index) => {
      const ts = parseTs(row);
      const label = (row.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 120);
      // Updraft list newest-first: cùng ts → lấy hàng trên
      if (
        !best ||
        ts > best.timestamp ||
        (ts === best.timestamp && index < bestIndex)
      ) {
        const key = `afp-backup-${ts}-${Math.random().toString(36).slice(2, 6)}`;
        best = { timestamp: ts, label, rowKey: key, el: row };
        bestIndex = index;
      }
    });
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
async function waitUntilNewBackupReady(page, base, beforeSnap, log, shouldCancel = null) {
  log('Đang chờ backup MỚI hoàn tất (không tải backup cũ)...');
  const deadline = Date.now() + 360000; // 6 phút
  let sawProgress = false;
  let sawComplete = false;
  let lastLog = 0;
  let stableNewCount = 0;

  const isFinishedLabel = (label) =>
    label && !/not\s*finished|in\s*progress|incomplete/i.test(label);

  while (Date.now() < deadline) {
    if (shouldCancel?.()) throw new Error('Job đã bị hủy.');
    const state = await page.evaluate(() => {
      const body = document.body?.innerText || '';
      // Progress: KHÔNG lấy .updraft_finished (cái đó = xong)
      const progress =
        /backing up|creating backup|backup.*progress|uploaded\s*\d+%/i.test(body) ||
        !!document.querySelector(
          '#updraft-jobstatus:not(.updraft_finished), .updraft-progress, #updraft_activejobsrow'
        );
      const complete =
        /backup\s*(apparently\s*)?(succeeded|complete|finished)/i.test(body) ||
        /the backup apparently succeeded/i.test(body) ||
        /backup complete/i.test(body) ||
        !!document.querySelector('.updraft_finished, #updraft-backup-complete');
      // Active: hẹp — tránh "please wait" / "is running" trên notice WP khác
      const active =
        /backup in progress|currently being backed|backing up (database|plugins|themes|uploads)/i.test(
          body
        ) || !!document.querySelector('#updraft_activejobs_table .job, #updraft_activejobsrow .job');
      return { progress, complete, active };
    });

    if (state.progress || state.active) sawProgress = true;
    if (state.complete && (sawProgress || !beforeSnap)) sawComplete = true;

    const newest = await snapshotNewestBackup(page);
    const labelChanged =
      newest && beforeSnap && newest.label && newest.label !== beforeSnap.label;
    const finishedRow = newest && isFinishedLabel(newest.label);

    const isNewer =
      newest &&
      (!beforeSnap ||
        newest.timestamp > beforeSnap.timestamp ||
        (newest.timestamp === beforeSnap.timestamp &&
          newest.label !== beforeSnap.label &&
          (newest.timestamp > 0 || finishedRow)) ||
        (beforeSnap.timestamp === 0 && newest.timestamp > 0) ||
        // Cả hai ts=0 nhưng label đổi + đã finished (case Updraft không có data-timestamp)
        (beforeSnap.timestamp === 0 &&
          newest.timestamp === 0 &&
          labelChanged &&
          finishedRow));

    if (isNewer && finishedRow) stableNewCount += 1;
    else stableNewCount = 0;

    if (Date.now() - lastLog > 15000) {
      log(
        `… chờ backup: progress=${sawProgress}, complete=${!!state.complete}, active=${!!state.active}, ` +
          `newer=${!!isNewer}, newest=${newest ? `${newest.label.slice(0, 55)} (ts=${newest.timestamp})` : 'n/a'}`
      );
      lastLog = Date.now();
    }

    // Xong: hàng mới + finished + (complete UI hoặc progress đã chạy rồi hết active)
    if (
      isNewer &&
      finishedRow &&
      (sawComplete || state.complete || (sawProgress && !state.active) || stableNewCount >= 2)
    ) {
      log(
        `Backup mới đã xong: ${newest.label.slice(0, 80)} (ts=${newest.timestamp}` +
          (beforeSnap ? `, trước=${beforeSnap.timestamp}` : '') +
          ')'
      );
      await sleepExact(2000);
      return newest;
    }

    if (!beforeSnap && newest && finishedRow && (sawComplete || (state.complete && !state.active))) {
      log(`Backup đầu tiên xong: ${newest.label.slice(0, 80)} (ts=${newest.timestamp})`);
      await sleepExact(2000);
      return newest;
    }

    // Rescan list khi UI báo xong nhưng chưa thấy hàng mới
    if (sawComplete && !isNewer && Date.now() % 20000 < 1600) {
      await page.evaluate(() => {
        const btn = Array.from(document.querySelectorAll('a, button')).find((el) =>
          /rescan|re-scan|refresh.*local|scan.*backup/i.test((el.innerText || '').trim())
        );
        btn?.click();
      });
    }

    // Fallback: label đổi + không còn "Not finished"
    if (labelChanged && finishedRow && (sawComplete || state.complete || !state.active)) {
      log(`Backup mới (đổi label): ${newest.label.slice(0, 80)}`);
      await sleepExact(2000);
      return newest;
    }

    await sleepExact(1500);
  }

  const newest = await snapshotNewestBackup(page);
  if (
    newest &&
    beforeSnap &&
    (newest.timestamp > beforeSnap.timestamp ||
      (newest.label !== beforeSnap.label && isFinishedLabel(newest.label)))
  ) {
    log(
      `Hết thời gian chờ nhưng đã có backup mới hơn — tiếp tục (${newest.label.slice(0, 60)}).`
    );
    return newest;
  }

  throw new Error(
    'Timeout: backup mới chưa xong / chưa thấy hàng backup mới hơn bản cũ.'
  );
}
