import {
  originOf,
  clickFirst,
  clickByText,
  sleep,
  sanitizeWpUsername,
  sanitizeCustomerPassword,
} from '../utils.js';
import {
  cookieHeaderFromPage,
  extractInputValue,
  isHttpStepsEnabled,
  stripHtmlText,
  wpFetch,
} from '../http/wpSession.js';

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
 * Kiểm tra email đã có user — HTTP (cookie sau Quick Login).
 */
async function emailAlreadyRegisteredHttp(session, emailClean, log) {
  const url = `${session.origin}/wp-admin/users.php?s=${encodeURIComponent(emailClean)}`;
  log(`Kiểm tra email (HTTP): ${emailClean}`);
  const res = await wpFetch(url, { cookieHeader: session.cookieHeader });
  if (/wp-login\.php/i.test(res.url) || /name=["']log["']/i.test(res.text)) {
    throw new Error('Cookie WP hết hạn / chưa login — HTTP users.php bị đẩy về login.');
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
  // Fallback: email xuất hiện trong bảng users
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
    throw new Error(`WP từ chối email: kiểm tra lại ô Email trên form. (${emailClean})`);
  }

  if (
    /already exists|đã tồn tại|already been registered|already used|sorry, that email/i.test(
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

/**
 * Tạo user WP qua HTTP POST user-new.php (cookie từ Quick Login).
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

  const session = await cookieHeaderFromPage(page);
  const existing = await emailAlreadyRegisteredHttp(session, emailClean, log);
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

  const formUrl = `${session.origin}/wp-admin/user-new.php`;
  log(`Tạo user (HTTP): ${username} (${emailClean}) — role Editor...`);

  const formPage = await wpFetch(formUrl, { cookieHeader: session.cookieHeader });
  if (/wp-login\.php/i.test(formPage.url) || /name=["']log["']/i.test(formPage.text)) {
    throw new Error('Cookie WP hết hạn — không mở được user-new.php qua HTTP.');
  }

  let nonce = extractInputValue(formPage.text, '_wpnonce_create-user');
  if (!nonce) {
    nonce = extractInputValue(formPage.text, '_wpnonce');
  }
  if (!nonce) {
    throw new Error('Không tìm thấy _wpnonce_create-user trên user-new.php (HTTP).');
  }

  const referer = extractInputValue(formPage.text, '_wp_http_referer') || '/wp-admin/user-new.php';

  async function postCreate(userLogin) {
    const body = new URLSearchParams();
    body.set('action', 'createuser');
    body.set('_wpnonce_create-user', nonce);
    body.set('_wp_http_referer', referer);
    body.set('user_login', userLogin);
    body.set('email', emailClean);
    body.set('first_name', '');
    body.set('last_name', '');
    body.set('url', '');
    body.set('pass1', password);
    body.set('pass2', password);
    body.set('pw_weak', 'on');
    body.set('role', 'editor');
    // Không gửi send_user_notification → không mail khách
    body.set('createuser', 'Add New User');

    return wpFetch(formUrl, {
      method: 'POST',
      cookieHeader: session.cookieHeader,
      body,
      headers: { Referer: formUrl, Origin: session.origin },
    });
  }

  let res = await postCreate(username);
  let errText = parseCreateUserErrorFromHtml(res.text);

  // Thành công: redirect users.php?update=add&id=
  const successUrl =
    /users\.php/i.test(res.url) && /update=add|id=\d+/i.test(res.url);
  const successBody =
    /New user created|User added|đã tạo|User created/i.test(res.text) ||
    /class=["'][^"']*notice-success/i.test(res.text);

  let verdict = interpretCreateUserError(errText, username, emailClean);

  if (verdict.kind === 'invalid_user') {
    const retryUser = sanitizeWpUsername(username);
    log(
      `⚠ WP báo username invalid ("${errText.split('\n')[0].slice(0, 100)}") — thử lại HTTP với "${retryUser}"...`
    );
    username = retryUser;
    // Nonce 1 lần — lấy form mới
    const form2 = await wpFetch(formUrl, { cookieHeader: session.cookieHeader });
    nonce = extractInputValue(form2.text, '_wpnonce_create-user') || nonce;
    res = await postCreate(username);
    errText = parseCreateUserErrorFromHtml(res.text);
    verdict = interpretCreateUserError(errText, username, emailClean);
  }

  if (verdict.kind === 'exists') {
    log(`⏭ WP báo email/user đã tồn tại — bỏ qua tạo user và sync WPM.`);
    const again = await emailAlreadyRegisteredHttp(session, emailClean, log);
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
    // Không rõ — kiểm tra lại list users
    const check = await emailAlreadyRegisteredHttp(session, emailClean, log);
    if (!check.found) {
      throw new Error(
        `HTTP tạo user không xác nhận được thành công (status ${res.status}, url ${res.url}).`
      );
    }
    log(`Đã tạo tài khoản khách (Editor) qua HTTP — xác nhận trên Users.`);
    return {
      username: check.username || username,
      password,
      email: emailClean,
      skipped: false,
      via: 'http',
    };
  }

  log('Đã tạo tài khoản khách (Editor) qua HTTP.');
  return { username, password, email: emailClean, skipped: false, via: 'http' };
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
      log(`⚠ HTTP tạo user thất bại (${msg.slice(0, 160)}) — fallback Chrome...`);
      return createCustomerAccountViaBrowser(page, customer, log);
    }
  }
  return createCustomerAccountViaBrowser(page, customer, log);
}
