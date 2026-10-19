/**
 * Client cho MAC Tools Helper plugin — Phase 1 User Guide.
 *
 * Flow:
 *   1. installHelper(page, siteUrl)  — dùng browser session đã login để upload
 *      plugin zip qua wp-admin/plugin-install.php?tab=upload rồi activate
 *   2. Các bước gọi REST /mac/v1/* bằng cookie + REST nonce (pure Node fetch)
 *   3. removeHelper(siteUrl, auth)    — xóa plugin cuối job
 */
import { readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HELPER_PHP = join(__dirname, 'mac-tools-helper.php');
const PLUGIN_SLUG = 'mac-tools-helper';
const PLUGIN_FILE = 'mac-tools-helper/mac-tools-helper.php';

/** Tạo zip từ file PHP (dùng gzip + định dạng zip tối giản). */
async function makeZip() {
  // Dùng adm-zip nếu có, không thì fallback: tạo zip thủ công tối giản
  let AdmZip;
  try {
    AdmZip = (await import('adm-zip')).default;
  } catch { AdmZip = null; }

  const zipPath = join(tmpdir(), `mac-tools-helper-${Date.now()}.zip`);
  if (AdmZip) {
    const zip = new AdmZip();
    zip.addLocalFile(HELPER_PHP, 'mac-tools-helper');
    zip.writeZip(zipPath);
    return zipPath;
  }
  // Fallback: zip thủ công (store, không nén) — đủ cho WP chấp nhận
  const content = readFileSync(HELPER_PHP);
  const name = Buffer.from('mac-tools-helper/mac-tools-helper.php');
  const crc = crc32(content);
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0); // signature
  header.writeUInt16LE(20, 4); // version
  header.writeUInt16LE(0, 6); // flags
  header.writeUInt16LE(0, 8); // method = store
  header.writeUInt16LE(0, 10); // time
  header.writeUInt16LE(0, 12); // date
  header.writeUInt32LE(crc, 14);
  header.writeUInt32LE(content.length, 18);
  header.writeUInt32LE(content.length, 22);
  header.writeUInt16LE(name.length, 26);
  header.writeUInt16LE(0, 28); // extra len
  // Central directory
  const cd = Buffer.alloc(46);
  cd.writeUInt32LE(0x02014b50, 0);
  cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6);
  cd.writeUInt16LE(0, 8); cd.writeUInt16LE(0, 10);
  cd.writeUInt16LE(0, 12); cd.writeUInt16LE(0, 14);
  cd.writeUInt32LE(crc, 16);
  cd.writeUInt32LE(content.length, 20);
  cd.writeUInt32LE(content.length, 24);
  cd.writeUInt16LE(name.length, 28);
  cd.writeUInt16LE(0, 30); cd.writeUInt16LE(0, 32);
  cd.writeUInt16LE(0, 34); cd.writeUInt16LE(0, 36);
  cd.writeUInt32LE(0, 38); // external attrs
  cd.writeUInt32LE(0, 42); // local header offset
  // End of central directory
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4); eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(1, 8); eocd.writeUInt16LE(1, 10);
  const cdStart = 30 + name.length + content.length;
  eocd.writeUInt32LE(46 + name.length, 12);
  eocd.writeUInt32LE(cdStart, 16);
  eocd.writeUInt16LE(0, 20);

  const { writeFileSync } = await import('fs');
  writeFileSync(zipPath, Buffer.concat([header, name, content, cd, name, eocd]));
  return zipPath;
}

function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

/**
 * Upload + activate helper plugin dùng browser session đã login.
 * @param {import('puppeteer').Page} page — đã login wp-admin
 * @param {string} siteUrl — origin của site (https://example.com)
 */
export async function installHelper(page, siteUrl) {
  const base = siteUrl.replace(/\/+$/, '');

  // N1: check version khi reuse — nếu khác thì cài lại
  const EXPECTED_VERSION = '1.0.6';
  try {
    const auth = await getRestAuth(page, base);
    const check = await checkHelper(base, auth);
    if (check.ok) {
      // Kiểm tra version
      const verRes = await callHelper(base, auth, '/version');
      if (verRes?.version === EXPECTED_VERSION) {
        return { ok: true, reused: true };
      }
      // Version khác → sẽ cài đè bên dưới
    }
  } catch {}

  const zipPath = await makeZip();

  try {
    // 1. Mở trang upload plugin
    await page.goto(`${base}/wp-admin/plugin-install.php?tab=upload`, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // 2. Lấy nonce từ form upload + set file vào input
    const nonce = await page.evaluate(() => {
      const el = document.querySelector('input[name="_wpnonce"]');
      return el ? el.value : null;
    });
    if (!nonce) throw new Error('Không lấy được nonce upload plugin.');

    // Set file zip vào input[type=file]
    const fileInput = await page.$('input[type="file"][name="pluginzip"]');
    if (!fileInput) throw new Error('Không tìm thấy input upload plugin.');
    await fileInput.uploadFile(zipPath);

    // 3. Upload zip qua fetch trong browser context (có cookie)
    const result = await page.evaluate(async (uploadUrl, wpnonce) => {
      const formData = new FormData();
      // File sẽ được đọc từ input[type=file] — cần set file trước
      const input = document.querySelector('input[type="file"][name="pluginzip"]');
      if (!input || !input.files.length) return { ok: false, error: 'no_file' };
      formData.append('pluginzip', input.files[0]);
      formData.append('_wpnonce', wpnonce);
      formData.append('_wp_http_referer', '/wp-admin/plugin-install.php?tab=upload');
      formData.append('install-plugin-submit', 'Install Now');
      const r = await fetch(uploadUrl, { method: 'POST', body: formData, credentials: 'include', redirect: 'follow' });
      const text = await r.text();
      return { ok: r.ok, status: r.status, url: r.url, text: text.slice(0, 2000) };
    }, `${base}/wp-admin/update.php?action=upload-plugin`, nonce);

    if (!result.ok) throw new Error(`Upload helper thất bại: ${result.status}`);

    // 4. Activate plugin — click và ĐỢI navigate xong
    await page.goto(`${base}/wp-admin/plugins.php`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const activated = await page.evaluate((pluginFile) => {
      const link = [...document.querySelectorAll('a')].find(a =>
        a.href.includes('action=activate') && a.href.includes(pluginFile.replace('/', '%2F'))
      );
      if (link) { link.click(); return 'clicked'; }
      const row = document.querySelector(`tr[data-plugin="${pluginFile}"]`);
      if (row && row.classList.contains('active')) return 'already_active';
      return 'not_found';
    }, PLUGIN_FILE);

    if (activated === 'clicked') {
      // Đợi trang activate load xong (có thể redirect về plugins.php?activate=true)
      await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
      await new Promise(r => setTimeout(r, 2000));
    }

    // 5. Verify plugin đã active thật chưa
    await page.goto(`${base}/wp-admin/plugins.php`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const isActive = await page.evaluate((pluginFile) => {
      const row = document.querySelector(`tr[data-plugin="${pluginFile}"]`);
      return !!(row && row.classList.contains('active'));
    }, PLUGIN_FILE);

    if (!isActive) {
      throw new Error(`Plugin ${PLUGIN_SLUG} chưa active sau khi cài (activate=${activated}). Kiểm tra PHP lỗi.`);
    }

    // 6. Ổn định page sau khi cài
    await page.goto(`${base}/wp-admin/`, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await page.waitForFunction(() => document.readyState === 'complete', { timeout: 15000 }).catch(() => {});

    return { installed: true, activate: activated, verified: isActive };
  } finally {
    const { unlinkSync } = await import('fs');
    try { unlinkSync(zipPath); } catch {}
  }
}

/**
 * Lấy cookie header + REST nonce từ browser session đã login.
 * @param {import('puppeteer').Page} page — đã login wp-admin
 * @param {string} siteUrl
 */
export async function getRestAuth(page, siteUrl) {
  const base = siteUrl.replace(/\/+$/, '');

  // Retry nếu page đang navigate (Execution context was destroyed)
  let cookies = null;
  for (let i = 0; i < 3; i++) {
    try {
      cookies = await page.cookies(base);
      break;
    } catch (e) {
      if (/destroyed|detached/i.test(e.message) && i < 2) {
        await new Promise(r => setTimeout(r, 2000));
        continue;
      }
      throw e;
    }
  }
  const cookieHeader = (cookies || []).map(c => `${c.name}=${c.value}`).join('; ');

  // Lấy REST nonce từ wp-admin (cần cho cookie auth với POST)
  const nonce = await page.evaluate(() => {
    // Thử từ wpApiSettings
    if (window.wpApiSettings?.nonce) return window.wpApiSettings.nonce;
    // Thử từ trang profile (có REST nonce)
    return null;
  });

  // Nếu không có nonce từ page, fetch từ wp-admin/admin-ajax.php
  let restNonce = nonce;
  if (!restNonce) {
    restNonce = await page.evaluate(async () => {
      try {
        const r = await fetch('/wp-admin/admin-ajax.php', { credentials: 'include' });
        const text = await r.text();
        const m = text.match(/"nonce"\s*:\s*"([a-f0-9]+)"/i) || text.match(/wpApiSettings[^}]*nonce['"]\s*:\s*['"]([^'"]+)/);
        return m ? m[1] : null;
      } catch { return null; }
    });
  }

  return { cookieHeader, nonce: restNonce, base };
}

/**
 * Gọi REST endpoint của helper.
 * Hỗ trợ 2 cách auth: Application Password hoặc cookie+nonce.
 *
 * @param {string} siteUrl
 * @param {{user: string, pass: string} | {cookieHeader: string, nonce: string}} auth
 * @param {string} endpoint — vd '/backup/run'
 * @param {object} [body]
 */
export async function callHelper(siteUrl, auth, endpoint, body = null) {
  const base = siteUrl.replace(/\/+$/, '');
  const url = `${base}/wp-json/mac/v1${endpoint}`;

  const headers = { 'Content-Type': 'application/json' };
  if (auth.user && auth.pass) {
    // Application Password
    const token = Buffer.from(`${auth.user}:${auth.pass}`).toString('base64');
    headers['Authorization'] = `Basic ${token}`;
  } else if (auth.cookieHeader) {
    // Cookie auth — cần nonce cho POST
    headers['Cookie'] = auth.cookieHeader;
    if (auth.nonce) headers['X-WP-Nonce'] = auth.nonce;
  } else {
    throw new Error('Thiếu auth: cần {user, pass} hoặc {cookieHeader, nonce}');
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60000);
  try {
    const res = await fetch(url, {
      method: body ? 'POST' : 'GET',
      signal: ctrl.signal,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = { _raw: text.slice(0, 500) }; }
    if (!res.ok) {
      const msg = data?.message || data?.code || `HTTP ${res.status}`;
      throw new Error(`Helper ${endpoint}: ${msg}`);
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Xóa helper plugin cuối job — dùng browser (wp-admin), không dùng REST
 * vì plugin không tự xóa mình qua endpoint của chính nó được.
 * @param {import('puppeteer').Page} page — đã login wp-admin
 * @param {string} siteUrl
 */
export async function removeHelper(page, siteUrl) {
  const base = siteUrl.replace(/\/+$/, '');

  // Auto-accept mọi confirm dialog (delete plugin)
  const dialogHandler = async (dialog) => {
    try { await dialog.accept(); } catch {}
  };
  page.on('dialog', dialogHandler);

  try {
    // 1. Deactivate trước
    await page.goto(`${base}/wp-admin/plugins.php`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const deactivated = await page.evaluate((pluginFile) => {
      const link = [...document.querySelectorAll('a')].find(a =>
        a.href.includes('action=deactivate') && a.href.includes(pluginFile.replace('/', '%2F'))
      );
      if (link) { link.click(); return true; }
      return false;
    }, PLUGIN_FILE);
    if (deactivated) {
      await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
      await new Promise(r => setTimeout(r, 1500));
    }

    // 2. Delete
    await page.goto(`${base}/wp-admin/plugins.php`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const deleted = await page.evaluate((pluginFile) => {
      const link = [...document.querySelectorAll('a')].find(a =>
        a.href.includes('action=delete-selected') && a.href.includes(pluginFile.replace('/', '%2F'))
      );
      if (link) { link.click(); return true; }
      // Thử link delete trực tiếp
      const delLink = [...document.querySelectorAll('a.delete')].find(a => {
        const row = a.closest(`tr[data-plugin="${pluginFile}"]`);
        return !!row;
      });
      if (delLink) { delLink.click(); return true; }
      return false;
    }, PLUGIN_FILE);

    if (deleted) {
      // Xác nhận dialog delete
      await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
      // Nếu có trang xác nhận, bấm nút Delete
      const confirmed = await page.evaluate(() => {
        const btn = document.querySelector('input#submit, button.button-primary');
        if (btn && /delete|xóa/i.test(btn.value || btn.textContent)) {
          btn.click();
          return true;
        }
        return false;
      });
      if (confirmed) {
        await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
      }
    }

    // 3. Verify đã xóa
    await page.goto(`${base}/wp-admin/plugins.php`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const stillThere = await page.evaluate((pluginFile) => {
      return !!document.querySelector(`tr[data-plugin="${pluginFile}"]`);
    }, PLUGIN_FILE);

    return stillThere
      ? { removed: false, error: 'Plugin vẫn còn sau khi xóa' }
      : { removed: true };
  } catch (e) {
    return { removed: false, error: e.message };
  } finally {
    page.off('dialog', dialogHandler);
  }
}

/** Kiểm tra helper đã cài và REST hoạt động chưa. */
export async function checkHelper(siteUrl, auth) {
  try {
    const data = await callHelper(siteUrl, auth, '/backup/status');
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}
