import {
  originOf,
  clickFirst,
  clickByText,
  sleep,
  sanitizeWpUsername,
  sanitizeCustomerPassword,
} from '../utils.js';

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

/**
 * Kiểm tra email đã có user trên WP (Users → search).
 * @returns {Promise<boolean>}
 */
export async function emailAlreadyRegistered(page, email, log = () => {}) {
  const base = originOf(page.url());
  const emailClean = String(email || '').trim();
  if (!emailClean) return false;

  const url = `${base}/wp-admin/users.php?s=${encodeURIComponent(emailClean)}`;
  log(`Kiểm tra email đã có user chưa: ${emailClean}`);
  await page.goto(url, GOTO);
  await sleep(500);

  const found = await page.evaluate((needle) => {
    const want = String(needle || '')
      .trim()
      .toLowerCase();
    if (!want) return false;

    const noItems = document.querySelector('#the-list tr.no-items');
    if (noItems) return false;

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
      if (mail === want) return true;

      const blob = (row.innerText || '').toLowerCase();
      if (blob.includes(want)) return true;
    }
    return false;
  }, emailClean);

  return found;
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

/**
 * Tạo user WP:
 * - Auto bỏ ' trong username/password (tia's-nails → tias-nails)
 * - Nếu email đã có → bỏ tạo + sync
 * - Accept dialog "Leave site?"
 */
export async function createCustomerAccount(page, customer, log) {
  const base = originOf(page.url());
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
  if (username !== String(rawUser).trim()) {
    log(`Username format: "${rawUser}" → "${username}" (bỏ ' / ký tự WP không cho)`);
  }
  if (password !== String(rawPass)) {
    log(`Password format: đã bỏ dấu nháy '`);
  }

  // Email đã có TK → bỏ tạo user + bỏ sync WPM
  if (await emailAlreadyRegistered(page, emailClean, log)) {
    log(
      `⏭ Email đã có tài khoản trên WP (${emailClean}) — bỏ qua tạo user và sync WPM.`
    );
    return {
      username: '',
      password: '',
      email: emailClean,
      skipped: true,
      reason: 'email_exists',
    };
  }

  // Leave site? → luôn Leave để không kẹt khi chuyển trang
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
    log(`Tạo user: ${username} (${emailClean}) — role Editor...`);
    await page.goto(`${base}/wp-admin/user-new.php`, GOTO);
    await sleep(400);

    let errText = await fillAndSubmitNewUser(
      page,
      { username, password, emailClean },
      log
    );

    // Username vẫn báo invalid → sanitize lần nữa + retry 1 lần
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

    if (/email address is not correct|email.*not correct|email.*không hợp lệ/i.test(errText)) {
      throw new Error(`WP từ chối email: kiểm tra lại ô Email trên form. (${emailClean})`);
    }

    if (
      /already exists|đã tồn tại|already been registered|already used|sorry, that email/i.test(
        errText
      )
    ) {
      log(`⏭ WP báo email/user đã tồn tại — bỏ qua tạo user và sync WPM.`);
      return {
        username: '',
        password: '',
        email: emailClean,
        skipped: true,
        reason: 'email_exists',
      };
    }

    if (/username is invalid|illegal|illeg/i.test(errText)) {
      throw new Error(
        `Username WP không hợp lệ sau khi format: "${username}". Đổi username (chỉ chữ/số/.-_@).`
      );
    }

    if (/notice-error|^Error:/i.test(errText) && /user|username|email|password/i.test(errText)) {
      log(`⚠ WP báo lỗi khi tạo user: ${errText.split('\n')[0].slice(0, 160)}`);
      throw new Error(`Không tạo được user WP: ${errText.split('\n')[0].slice(0, 200)}`);
    }

    log('Đã tạo tài khoản khách (Editor).');
    return { username, password, email: emailClean, skipped: false };
  } finally {
    page.off('dialog', onDialog);
  }
}
