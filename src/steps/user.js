import {
  originOf,
  clickFirst,
  clickByText,
  sleep,
  sanitizeWpUsername,
  sanitizeCustomerPassword,
  clearUnloadGuard,
  evaluateSafe,
} from '../utils.js';
import { isHttpStepsEnabled, stripHtmlText } from '../http/wpSession.js';

const GOTO = { waitUntil: 'domcontentloaded', timeout: 60000 };

/** Ghi thẳng value + event — tránh type() bị cắt giữa chừng (WP password UI / focus). */
async function setInputValue(page, selectors, value) {
  const ok = await page.evaluate(
    (sels, val) => {
      for (const sel of sels) {
        const el = document.querySelector(sel);
        if (!el) continue;
        el.focus();
        el.value = '';
        el.value = String(val);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
        return el.value === String(val);
      }
      return false;
    },
    selectors,
    value
  );
  return ok;
}

async function readInputValue(page, selectors) {
  return page.evaluate((sels) => {
    for (const sel of sels) {
      const el = document.querySelector(sel);
      if (el) return (el.value || '').trim();
    }
    return '';
  }, selectors);
}

async function readCreateUserError(page) {
  return page.evaluate(() => {
    const notice =
      document.querySelector('#message.notice-error, .notice-error, #login_error, .error') ||
      document.querySelector('.wp-die-message');
    const t = (notice?.innerText || '').trim();
    if (t) return t.slice(0, 500);
    const body = (document.body?.innerText || '').trim();
    if (/Error:\s*.*(username|email|password)/i.test(body)) {
      const m = body.match(/Error:\s*[^\n]{0,200}/i);
      return (m?.[0] || body).slice(0, 500);
    }
    return '';
  });
}

function parseCreateUserErrorFromHtml(html) {
  const noticeMatch =
    html.match(
      /<(?:div|p)[^>]*(?:notice-error|error|wp-die-message)[^>]*>([\s\S]*?)<\/(?:div|p)>/i
    ) || html.match(/id=["']message["'][^>]*class=["'][^"']*notice-error[^"']*["'][^>]*>([\s\S]*?)<\/div>/i);
  if (noticeMatch?.[1]) {
    const t = stripHtmlText(noticeMatch[1]);
    if (t) return t.slice(0, 500);
  }
  const text = stripHtmlText(html);
  if (/Error:\s*.*(username|email|password)/i.test(text)) {
    const m = text.match(/Error:\s*[^\n.]{0,200}/i);
    return (m?.[0] || text).slice(0, 500);
  }
  return '';
}

/**
 * Kiểm tra email đã có user trên WP (Users → search) — browser.
 * @returns {Promise<{ found: boolean, username: string }>}
 */
export async function emailAlreadyRegistered(page, email, log = () => {}) {
  const base = originOf(page.url());
  const emailClean = String(email || '').trim();
  if (!emailClean) return { found: false, username: '' };

  const url = `${base}/wp-admin/users.php?s=${encodeURIComponent(emailClean)}`;
  log(`Kiểm tra email đã có user chưa: ${emailClean}`);
  await page.goto(url, GOTO);
  await sleep(500);

  const hit = await page.evaluate((needle) => {
    const want = String(needle || '')
      .trim()
      .toLowerCase();
    if (!want) return { found: false, username: '' };

    const noItems = document.querySelector('#the-list tr.no-items');
    if (noItems) return { found: false, username: '' };

    const rows = Array.from(document.querySelectorAll('#the-list > tr'));
    for (const row of rows) {
      if (row.classList.contains('no-items')) continue;
      const emailEl =
        row.querySelector('td.email a, td.column-email a, .email a') ||
        row.querySelector('td.email, td.column-email, .column-email');
      const mail = (emailEl?.textContent || emailEl?.getAttribute('href') || '')
        .replace(/^mailto:/i, '')
        .trim()
        .toLowerCase();
      const blob = (row.innerText || '').toLowerCase();
      const match = mail === want || blob.includes(want);
      if (!match) continue;

      const userEl =
        row.querySelector('td.username a, td.column-username a, .username strong a, .column-username strong a') ||
        row.querySelector('td.username strong, td.column-username strong, .username a');
      const username = (userEl?.textContent || '').trim();
      return { found: true, username };
    }
    return { found: false, username: '' };
  }, emailClean);

  return hit;
}

/**
 * Kiểm tra email đã có user — in-page fetch (cookie tab WP, có timeout).
 * Node wpFetch hay bị WAF giữ / 404 giả → job đứng hoặc miss “đã có mail”.
 */
async function emailAlreadyRegisteredInPage(page, emailClean, log) {
  const base = originOf(page.url());
  if (!base) throw new Error('Không xác định origin WP để check email.');
  const url = `${base}/wp-admin/users.php?s=${encodeURIComponent(emailClean)}`;
  log(`Kiểm tra email (in-page): ${emailClean}`);

  const res = await evaluateSafe(page, async (u) => {
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), 25000) : null;
    try {
      const r = await fetch(u, {
        method: 'GET',
        credentials: 'include',
        redirect: 'follow',
        headers: {
          Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
        },
        signal: ctrl?.signal,
      });
      const text = await r.text();
      return { ok: r.ok, status: r.status, url: r.url, text, aborted: false };
    } catch (e) {
      return {
        ok: false,
        status: 0,
        url: u,
        text: String(e?.message || e),
        aborted: /abort/i.test(String(e?.name || e?.message || e)),
      };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }, url);

  if (res.aborted) {
    throw new Error('Check email timeout 25s (users.php).');
  }
  if (/wp-login\.php/i.test(res.url) || /name=["']log["']/i.test(res.text)) {
    throw new Error('Cookie WP hết hạn / chưa login — users.php bị đẩy về login.');
  }
  // HTML không phải Users list → không kết luận “chưa có”
  if (
    !res.ok ||
    (!/id=["']the-list["']/i.test(res.text) &&
      !/wp-list-table[^\n]*users/i.test(res.text) &&
      !/Search Results/i.test(res.text))
  ) {
    throw new Error(
      `users.php không đọc được list user (HTTP ${res.status}) — fallback Chrome.`
    );
  }

  if (/tr[^>]*class=["'][^"']*no-items/i.test(res.text) || /No users found/i.test(res.text)) {
    return { found: false, username: '' };
  }

  const want = emailClean.toLowerCase();
  const rowRe = /<tr[^>]*id=["']user-(\d+)["'][^>]*>([\s\S]*?)<\/tr>/gi;
  let m;
  while ((m = rowRe.exec(res.text))) {
    const rowHtml = m[2];
    const rowText = stripHtmlText(rowHtml).toLowerCase();
    const mailMatch = rowHtml.match(/mailto:([^"'>\s]+)/i);
    const mail = (mailMatch?.[1] || '').toLowerCase();
    if (mail !== want && !rowText.includes(want)) continue;
    const userMatch =
      rowHtml.match(/class=["'][^"']*username[^"']*["'][\s\S]*?<a[^>]*>([^<]+)</i) ||
      rowHtml.match(/<strong>\s*<a[^>]*>([^<]+)</i);
    return { found: true, username: (userMatch?.[1] || '').trim() };
  }
  if (res.text.toLowerCase().includes(want) && /id=["']the-list["']/i.test(res.text)) {
    const loose = res.text.match(
      new RegExp(
        `id=["']user-\\d+["'][\\s\\S]{0,800}${want.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}[\\s\\S]{0,400}`,
        'i'
      )
    );
    if (loose) {
      const userMatch = loose[0].match(/<strong>\s*<a[^>]*>([^<]+)</i);
      return { found: true, username: (userMatch?.[1] || '').trim() };
    }
  }
  return { found: false, username: '' };
}

/** Check email trước tạo user: in-page → fail thì Chrome Users search. */
async function ensureEmailNotRegistered(page, emailClean, log) {
  try {
    return await emailAlreadyRegisteredInPage(page, emailClean, log);
  } catch (e) {
    log(`⚠ Check email in-page lỗi (${String(e?.message || e).slice(0, 100)}) — dùng Chrome Users...`);
    return emailAlreadyRegistered(page, emailClean, log);
  }
}

async function fillAndSubmitNewUser(page, { username, password, emailClean }, log) {
  await page.waitForSelector('#user_login, input[name="user_login"]', { timeout: 20000 });
  await page.waitForSelector('#email, input[name="email"]', { timeout: 20000 });

  if (
    !(await setInputValue(page, ['#user_login', 'input[name="user_login"]'], username))
  ) {
    throw new Error('Không điền được Username trên user-new.php');
  }

  let emailOk = false;
  for (let i = 0; i < 3; i += 1) {
    await setInputValue(page, ['#email', 'input[name="email"]'], emailClean);
    await sleep(150);
    const got = await readInputValue(page, ['#email', 'input[name="email"]']);
    if (got === emailClean) {
      emailOk = true;
      break;
    }
    log(`⚠ Email trên form bị lệch ("${got}") — điền lại lần ${i + 2}...`);
  }
  if (!emailOk) {
    const got = await readInputValue(page, ['#email', 'input[name="email"]']);
    throw new Error(
      `Không điền đủ Email trên WP. Mong đợi "${emailClean}" nhưng form có "${got}".`
    );
  }

  const passSelectors = [
    '#pass1-text',
    '#pass1',
    'input[name="pass1"]',
    'input[name="pass1-text"]',
  ];
  await setInputValue(page, passSelectors, password);
  await setInputValue(page, ['#pass2', 'input[name="pass2"]'], password);
  await sleep(100);
  await setInputValue(page, passSelectors, password);
  await setInputValue(page, ['#pass2', 'input[name="pass2"]'], password);

  await page.evaluate(() => {
    const sel = document.querySelector('#role');
    if (!sel) return;
    const opt = Array.from(sel.options).find(
      (o) => o.value === 'editor' || /^editor$/i.test(o.text)
    );
    if (opt) {
      sel.value = opt.value;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    }
  });

  await page.evaluate(() => {
    const candidates = Array.from(document.querySelectorAll('input[type="checkbox"]'));
    for (const cb of candidates) {
      const id = (cb.id || '').toLowerCase();
      const name = (cb.name || '').toLowerCase();
      const label =
        document.querySelector(`label[for="${cb.id}"]`)?.innerText ||
        cb.closest('label')?.innerText ||
        cb.parentElement?.innerText ||
        '';
      const blob = `${id} ${name} ${label}`.toLowerCase();
      if (
        /pw_weak|weak|mật khẩu yếu|chấp nhận|confirm.*weak|ignore.*weak/.test(blob)
      ) {
        if (!cb.checked) cb.click();
        return;
      }
    }
    const pwWeak = document.querySelector('#pw_weak');
    if (pwWeak && !pwWeak.checked) pwWeak.click();
  });

  await page.evaluate(() => {
    const cb = document.querySelector('#send_user_notification');
    if (cb && cb.checked) cb.click();
  });

  const emailBeforeSubmit = await readInputValue(page, ['#email', 'input[name="email"]']);
  if (emailBeforeSubmit !== emailClean) {
    throw new Error(
      `Email bị đổi trước khi Submit: "${emailBeforeSubmit}" (cần "${emailClean}").`
    );
  }

  try {
    await clickFirst(page, ['#createusersub', 'input#createusersub'], { timeout: 5000 });
  } catch {
    await clickByText(page, 'Add New User', { timeout: 5000 });
  }

  await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  await sleep(400);
  return readCreateUserError(page);
}

function normalizeCustomer(customer) {
  const rawUser = customer?.username;
  const rawPass = customer?.password;
  const email = customer?.email;

  if (!rawUser || !rawPass || !email) {
    throw new Error('Thiếu username / password / email khách.');
  }

  const emailClean = String(email).trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailClean)) {
    throw new Error(`Email khách không hợp lệ: "${emailClean}"`);
  }

  let username = sanitizeWpUsername(rawUser);
  let password = sanitizeCustomerPassword(rawPass);

  if (!username) {
    throw new Error(`Username không hợp lệ sau khi bỏ ký tự lạ: "${rawUser}"`);
  }
  if (!password) {
    throw new Error(`Password trống sau khi bỏ dấu nháy: kiểm tra lại.`);
  }

  return { rawUser, rawPass, emailClean, username, password };
}

function interpretCreateUserError(errText, username, emailClean) {
  if (/email address is not correct|email.*not correct|email.*không hợp lệ/i.test(errText)) {
    // "already registered" cũng chứa "email" — ưu tiên exists trước (xem bên dưới)
    if (!/already\s+(been\s+)?registered|already\s+used|already\s+exists/i.test(errText)) {
      throw new Error(`WP từ chối email: kiểm tra lại ô Email trên form. (${emailClean})`);
    }
  }

  if (
    /already exists|đã tồn tại|already\s+(been\s+)?registered|already used|sorry, that email|email is already|email address is already|this email.*(already|registered)|username.*(already|exists)|login name.*(already|exists)/i.test(
      errText
    )
  ) {
    return { kind: 'exists' };
  }

  if (/username is invalid|illegal|illeg/i.test(errText)) {
    return { kind: 'invalid_user' };
  }

  if (/notice-error|^Error:/i.test(errText) && /user|username|email|password/i.test(errText)) {
    throw new Error(`Không tạo được user WP: ${errText.split('\n')[0].slice(0, 200)}`);
  }

  return { kind: 'ok' };
}

function isEmailExistsError(msg) {
  return /already\s+(been\s+)?registered|already exists|đã tồn tại|already used|sorry, that email|email is already|email address is already|this email.*(already|registered)|username.*(already|exists)|login name.*(already|exists)/i.test(
    String(msg || '')
  );
}

/**
 * Đọc form user-new từ DOM Chrome (tránh Node fetch bị WAF/HTML khác).
 * @returns {Promise<{ nonce: string, nonceName: string, referer: string, origin: string, formUrl: string }>}
 */
async function loadCreateUserFormFromPage(page, log) {
  const base = originOf(page.url());
  if (!base) throw new Error('Không xác định origin WP.');
  const formUrl = `${base}/wp-admin/user-new.php`;
  await page.goto(formUrl, GOTO);
  await sleep(350);

  const info = await page.evaluate(() => {
    const pick = (name) => {
      const el =
        document.querySelector(`input[name="${name}"]`) ||
        document.getElementById(name);
      return (el?.value || '').trim();
    };

    let nonceName = '_wpnonce_create-user';
    let nonce = pick(nonceName);
    if (!nonce) {
      const hit = Array.from(document.querySelectorAll('input[type="hidden"]')).find((el) => {
        const n = (el.name || '').toLowerCase();
        return n.includes('nonce') && (n.includes('create') || n.includes('user'));
      });
      if (hit?.value) {
        nonce = hit.value.trim();
        nonceName = hit.name;
      }
    }
    if (!nonce) {
      nonce = pick('_wpnonce');
      if (nonce) nonceName = '_wpnonce';
    }

    return {
      nonce,
      nonceName,
      referer: pick('_wp_http_referer') || '/wp-admin/user-new.php',
      hasLoginField: Boolean(document.querySelector('#user_login, input[name="user_login"]')),
      url: location.href,
      title: document.title || '',
    };
  });

  if (/wp-login\.php/i.test(info.url)) {
    throw new Error('Bị đẩy về wp-login — session WP không còn.');
  }
  if (!info.hasLoginField) {
    throw new Error(
      `Không thấy form tạo user trên page (title="${info.title.slice(0, 60)}").`
    );
  }
  if (!info.nonce) {
    throw new Error('Không tìm thấy nonce trên form user-new.php (DOM).');
  }

  log(`✓ Nonce form OK (${info.nonceName})`);
  return {
    nonce: info.nonce,
    nonceName: info.nonceName,
    referer: info.referer,
    origin: base,
    formUrl,
  };
}

/**
 * POST tạo user từ trong Chrome (credentials include) — nhanh hơn điền từng ô.
 */
async function postCreateUserInPage(page, form, { username, password, emailClean }) {
  return evaluateSafe(
    page,
    async (payload) => {
      const body = new URLSearchParams();
      body.set('action', 'createuser');
      body.set(payload.nonceName, payload.nonce);
      body.set('_wp_http_referer', payload.referer);
      body.set('user_login', payload.username);
      body.set('email', payload.emailClean);
      body.set('first_name', '');
      body.set('last_name', '');
      body.set('url', '');
      body.set('pass1', payload.password);
      body.set('pass2', payload.password);
      body.set('pw_weak', 'on');
      body.set('role', 'editor');
      body.set('createuser', 'Add New User');

      const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
      const timer = ctrl ? setTimeout(() => ctrl.abort(), 45000) : null;
      try {
        const res = await fetch(payload.formUrl, {
          method: 'POST',
          credentials: 'include',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
          },
          body: body.toString(),
          redirect: 'follow',
          signal: ctrl?.signal,
        });
        const text = await res.text();
        return { status: res.status, url: res.url, text, aborted: false };
      } catch (e) {
        return {
          status: 0,
          url: payload.formUrl,
          text: String(e?.message || e),
          aborted: /abort/i.test(String(e?.name || e?.message || e)),
        };
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
    {
      formUrl: form.formUrl,
      nonce: form.nonce,
      nonceName: form.nonceName,
      referer: form.referer,
      username,
      password,
      emailClean,
    }
  );
}

/**
 * Tạo user WP qua POST (nonce lấy từ DOM Chrome — tránh Node fetch miss nonce).
 */
export async function createCustomerAccountViaHttp(page, customer, log) {
  const { rawUser, rawPass, emailClean, username: user0, password } = normalizeCustomer(customer);
  let username = user0;

  if (username !== String(rawUser).trim()) {
    log(`Username format: "${rawUser}" → "${username}" (bỏ ' / ký tự WP không cho)`);
  }
  if (password !== String(rawPass)) {
    log(`Password format: đã bỏ dấu nháy '`);
  }

  // Check email TRƯỚC khi POST: in-page (+ timeout) → Chrome Users search
  const existing = await ensureEmailNotRegistered(page, emailClean, log);

  if (existing.found) {
    const existingUser = existing.username || username;
    log(
      `⏭ Email đã có tài khoản trên WP (${emailClean}` +
        (existingUser ? ` → user "${existingUser}"` : '') +
        ') — bỏ qua tạo user và sync WPM.'
    );
    return {
      username: existingUser,
      password: '',
      email: emailClean,
      skipped: true,
      reason: 'email_exists',
      via: 'http',
    };
  }

  log(`Tạo user (HTTP/DOM): ${username} (${emailClean}) — role Editor...`);
  let form = await loadCreateUserFormFromPage(page, log);

  let res = await postCreateUserInPage(page, form, { username, password, emailClean });
  if (res.aborted) {
    throw new Error('POST tạo user timeout 45s — thử lại hoặc fallback Chrome.');
  }
  let errText = parseCreateUserErrorFromHtml(res.text);
  // WP đôi khi chỉ để lỗi trong body / title mà không có notice-error chuẩn
  if (!errText && isEmailExistsError(stripHtmlText(res.text))) {
    errText = stripHtmlText(res.text).slice(0, 200);
  }

  const successUrl =
    /users\.php/i.test(res.url) && /update=add|id=\d+/i.test(res.url);
  const successBody =
    /New user created|User added|đã tạo|User created/i.test(res.text) ||
    /class=["'][^"']*notice-success/i.test(res.text);

  let verdict = interpretCreateUserError(errText, username, emailClean);

  if (verdict.kind === 'invalid_user') {
    const retryUser = sanitizeWpUsername(username);
    log(
      `⚠ WP báo username invalid ("${errText.split('\n')[0].slice(0, 100)}") — thử lại với "${retryUser}"...`
    );
    username = retryUser;
    form = await loadCreateUserFormFromPage(page, log);
    res = await postCreateUserInPage(page, form, { username, password, emailClean });
    if (res.aborted) {
      throw new Error('POST tạo user (retry) timeout 45s.');
    }
    errText = parseCreateUserErrorFromHtml(res.text);
    if (!errText && isEmailExistsError(stripHtmlText(res.text))) {
      errText = stripHtmlText(res.text).slice(0, 200);
    }
    verdict = interpretCreateUserError(errText, username, emailClean);
  }

  if (verdict.kind === 'exists') {
    log(`⏭ WP báo email/user đã tồn tại — bỏ qua tạo user và sync WPM.`);
    const again = await ensureEmailNotRegistered(page, emailClean, log).catch(() => ({
      found: true,
      username: '',
    }));
    await leaveUserNewForm(page, log);
    return {
      username: again.username || username,
      password: '',
      email: emailClean,
      skipped: true,
      reason: 'email_exists',
      via: 'http',
    };
  }

  if (verdict.kind === 'invalid_user') {
    throw new Error(
      `Username WP không hợp lệ sau khi format: "${username}". Đổi username (chỉ chữ/số/.-_@).`
    );
  }

  if (!successUrl && !successBody && errText) {
    throw new Error(`Không tạo được user WP (HTTP): ${errText.split('\n')[0].slice(0, 200)}`);
  }

  if (!successUrl && !successBody) {
    const check = await emailAlreadyRegistered(page, emailClean, log);
    if (!check.found) {
      throw new Error(
        `HTTP tạo user không xác nhận được thành công (status ${res.status}, url ${res.url}).`
      );
    }
    log(`Đã tạo tài khoản khách (Editor) qua HTTP — xác nhận trên Users.`);
    await leaveUserNewForm(page, log);
    return {
      username: check.username || username,
      password,
      email: emailClean,
      skipped: false,
      via: 'http',
    };
  }

  log('Đã tạo tài khoản khách (Editor) qua HTTP.');
  await leaveUserNewForm(page, log);
  return { username, password, email: emailClean, skipped: false, via: 'http' };
}

/** Rời user-new.php — tránh kẹt popup "Leave site?" khi sang Mac Core. */
async function leaveUserNewForm(page, log) {
  await clearUnloadGuard(page);
  const onDialog = async (dialog) => {
    const msg = dialog.message() || '';
    log(`Leave site?: "${msg.slice(0, 60)}" → Leave`);
    try {
      await dialog.accept();
    } catch {
      /* ignore */
    }
  };
  page.on('dialog', onDialog);
  try {
    const base = originOf(page.url());
    await page.goto(`${base}/wp-admin/users.php`, {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    }).catch(() => {});
    await clearUnloadGuard(page);
  } finally {
    page.off('dialog', onDialog);
  }
}

/**
 * Tạo user WP qua Chrome (điền form).
 */
export async function createCustomerAccountViaBrowser(page, customer, log) {
  const { rawUser, rawPass, emailClean, username: user0, password } = normalizeCustomer(customer);
  let username = user0;

  if (username !== String(rawUser).trim()) {
    log(`Username format: "${rawUser}" → "${username}" (bỏ ' / ký tự WP không cho)`);
  }
  if (password !== String(rawPass)) {
    log(`Password format: đã bỏ dấu nháy '`);
  }

  const base = originOf(page.url());

  const existing = await emailAlreadyRegistered(page, emailClean, log);
  if (existing.found) {
    const existingUser = existing.username || username;
    log(
      `⏭ Email đã có tài khoản trên WP (${emailClean}` +
        (existingUser ? ` → user "${existingUser}"` : '') +
        ') — bỏ qua tạo user và sync WPM.'
    );
    return {
      username: existingUser,
      password: '',
      email: emailClean,
      skipped: true,
      reason: 'email_exists',
      via: 'browser',
    };
  }

  const onDialog = async (dialog) => {
    const msg = dialog.message() || '';
    log(`Dialog: "${msg.slice(0, 60)}" → Leave/OK`);
    try {
      await dialog.accept();
    } catch {
      /* ignore */
    }
  };
  page.on('dialog', onDialog);

  try {
    log(`Tạo user (Chrome): ${username} (${emailClean}) — role Editor...`);
    await page.goto(`${base}/wp-admin/user-new.php`, GOTO);
    await sleep(400);

    let errText = await fillAndSubmitNewUser(
      page,
      { username, password, emailClean },
      log
    );

    if (/username is invalid|illegal|illeg|không hợp lệ/i.test(errText)) {
      const retryUser = sanitizeWpUsername(username);
      log(
        `⚠ WP báo username invalid ("${errText.split('\n')[0].slice(0, 100)}") — thử lại với "${retryUser}"...`
      );
      await page.goto(`${base}/wp-admin/user-new.php`, GOTO);
      await sleep(400);
      username = retryUser;
      errText = await fillAndSubmitNewUser(
        page,
        { username, password, emailClean },
        log
      );
    }

    const verdict = interpretCreateUserError(errText, username, emailClean);
    if (verdict.kind === 'exists') {
      log(`⏭ WP báo email/user đã tồn tại — bỏ qua tạo user và sync WPM.`);
      const again = await emailAlreadyRegistered(page, emailClean, log);
      return {
        username: again.username || username,
        password: '',
        email: emailClean,
        skipped: true,
        reason: 'email_exists',
        via: 'browser',
      };
    }
    if (verdict.kind === 'invalid_user') {
      throw new Error(
        `Username WP không hợp lệ sau khi format: "${username}". Đổi username (chỉ chữ/số/.-_@).`
      );
    }

    log('Đã tạo tài khoản khách (Editor).');
    return { username, password, email: emailClean, skipped: false, via: 'browser' };
  } finally {
    page.off('dialog', onDialog);
  }
}

/**
 * Tạo user WP:
 * - 2.1: ưu tiên HTTP (USE_HTTP_STEPS), fail → fallback Chrome
 * - Auto bỏ ' trong username/password
 * - Nếu email đã có → bỏ tạo + sync
 */
export async function createCustomerAccount(page, customer, log) {
  if (isHttpStepsEnabled()) {
    try {
      return await createCustomerAccountViaHttp(page, customer, log);
    } catch (err) {
      const msg = err?.message || String(err);
      // Rule: email đã có → bỏ tạo + sync, KHÔNG fallback Chrome
      if (isEmailExistsError(msg)) {
        const emailClean = String(customer?.email || '').trim();
        log(
          `⏭ WP báo email đã tồn tại (${emailClean}) — bỏ qua tạo user và sync WPM (không fallback Chrome).`
        );
        await leaveUserNewForm(page, log).catch(() => {});
        const again = await emailAlreadyRegistered(page, emailClean, log).catch(() => ({
          found: false,
          username: '',
        }));
        return {
          username: again.username || sanitizeWpUsername(customer?.username) || '',
          password: '',
          email: emailClean,
          skipped: true,
          reason: 'email_exists',
          via: 'http',
        };
      }
      log(`⚠ HTTP tạo user thất bại (${msg.slice(0, 160)}) — fallback Chrome...`);
      return createCustomerAccountViaBrowser(page, customer, log);
    }
  }
  return createCustomerAccountViaBrowser(page, customer, log);
}
