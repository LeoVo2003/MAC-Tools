import {
  fillFirst,
  clickFirst,
  clickByText,
  sleep,
  sleepExact,
  GOTO,
} from '../utils.js';

/** Điền input theo kiểu React/Vue (clear + type thật). */
async function fillNative(page, handle, value) {
  await handle.focus();
  await page.evaluate((el) => {
    el.select?.();
    el.value = '';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, handle);
  await handle.type(String(value), { delay: 15 });
  await page.evaluate((el) => {
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.blur();
  }, handle);
}

const WPM_BASE = 'https://wpm.macusaone.com';

export async function loginToWPM(page, { username, password }, log) {
  log('Mở trang login WPM...');
  await page.goto(`${WPM_BASE}/login`, GOTO);

  await fillFirst(page, [
    'input[name="username"]',
    'input[name="email"]',
    'input[type="email"]',
    'input#username',
    'input#email',
    'input[name="log"]',
  ], username);

  await fillFirst(page, [
    'input[name="password"]',
    'input[type="password"]',
    'input#password',
  ], password);

  try {
    await clickFirst(page, [
      'button[type="submit"]',
      'input[type="submit"]',
      'button.btn-primary',
      'button.login',
    ], { timeout: 4000 });
  } catch {
    await clickByText(page, 'Login', { timeout: 4000 }).catch(() =>
      clickByText(page, 'Đăng nhập', { timeout: 4000 })
    );
  }

  await page.waitForNavigation(GOTO).catch(() => {});
  await sleep(400);

  const url = page.url();
  if (url.includes('/login')) {
    throw new Error('Login WPM thất bại — vẫn ở trang /login. Kiểm tra WPM_USERNAME / WPM_PASSWORD.');
  }
  log('Đã login WPM.');
}

/**
 * Đọc Name project — đúng ô cạnh nút Split (#btnSplit):
 *   <input id="name" name="name" data-label="Name" placeholder="Enter project name" ...>
 * Không lấy Assign to (Leo 🦁).
 */
export async function readProjectName(page) {
  return page.evaluate(() => {
    // Cách chắc nhất: input cùng .input-group với #btnSplit
    const bySplit = document
      .querySelector('#btnSplit')
      ?.closest('.input-group, .form-group')
      ?.querySelector('input#name, input[name="name"]');

    const byExact =
      document.querySelector(
        'input#name[name="name"][data-label="Name"], input#name[name="name"][placeholder*="project" i]'
      ) || document.querySelector('input#name[name="name"].button-input');

    const byLabel = (() => {
      const lab = document.querySelector('label[for="name"]');
      if (!lab) return null;
      const labText = (lab.textContent || '').replace(/\s+/g, ' ').trim();
      if (!/^name\b/i.test(labText) || /assign/i.test(labText)) return null;
      return lab.closest('.form-group')?.querySelector('input#name[name="name"], input#name');
    })();

    const el = bySplit || byExact || byLabel;
    if (!el) return '';

    // Chặn nhầm Assign to
    const near = (el.closest('.form-group')?.innerText || '').slice(0, 80);
    if (/assign\s*to/i.test(near)) return '';

    return (el.value || el.getAttribute('value') || '').trim();
  });
}

/** Đọc Zip Code trên Project Information (`#zipcode`). */
export async function readProjectZipcode(page) {
  return page.evaluate(() => {
    const el =
      document.querySelector('input#zipcode[name="zipcode"]') ||
      document.querySelector('input#zipcode') ||
      document.querySelector('input[name="zipcode"]');
    if (!el) return '';
    return (el.value || el.getAttribute('value') || '').trim();
  });
}

/**
 * Mở project + Quick Login.
 * @returns {{ wpPage: import('puppeteer').Page, projectName: string, projectLabel: string }}
 */
export async function openProjectAndQuickLogin(browser, page, projectUrl, log) {
  // Bỏ ?tab=web-info — Name chỉ có ở Project Information
  const cleanUrl = (() => {
    try {
      const u = new URL(projectUrl);
      u.search = '';
      u.hash = '';
      return u.toString();
    } catch {
      return String(projectUrl).split('?')[0];
    }
  })();

  log(`Mở project: ${cleanUrl}`);
  await page.goto(cleanUrl, GOTO);
  await sleepExact(800);

  await page.evaluate(() => {
    const tab = Array.from(
      document.querySelectorAll('a.nav-link, button.nav-link, a[role="tab"], a, button')
    ).find((el) =>
      /^project information$/i.test((el.textContent || '').replace(/\s+/g, ' ').trim())
    );
    tab?.click();
  });
  await sleepExact(500);

  await page
    .waitForSelector('input#name[name="name"], #btnSplit', { timeout: 15000 })
    .catch(() => {});

  let projectName = '';
  let projectZip = '';
  for (let i = 0; i < 15; i += 1) {
    projectName = await readProjectName(page);
    projectZip = await readProjectZipcode(page);
    if (projectName) break;
    await sleepExact(300);
  }
  if (!projectZip) {
    projectZip = await readProjectZipcode(page);
  }

  if (projectName) {
    log(`Tên project (Name): ${projectName}`);
  } else {
    log('⚠ Không đọc được Name (#name + #btnSplit) — folder backup dùng tên mặc định.');
    projectName = '';
  }
  if (projectZip) {
    log(`Zip Code: ${projectZip}`);
  } else {
    log('⚠ Không đọc được Zip Code (#zipcode).');
  }

  const projectLabel = [projectZip, projectName].filter(Boolean).join(' ').trim();
  if (projectLabel) log(`Project: ${projectLabel}`);

  const pagesBefore = await browser.pages();

  log('Bấm Quick Login...');
  let clicked = false;
  try {
    await clickByText(page, 'Quick Login', { timeout: 6000 });
    clicked = true;
  } catch {
    try {
      await clickFirst(page, [
        'a[href*="quick"]',
        'button[data-action*="quick"]',
        'a.quick-login',
        '[class*="quick-login"]',
        'a[href*="auto-login"]',
      ], { timeout: 4000 });
      clicked = true;
    } catch {
      /* fallthrough */
    }
  }

  if (!clicked) {
    throw new Error('Không tìm thấy nút Quick Login trên trang project WPM.');
  }

  let wpPage = page;
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const pages = await browser.pages();
    const newer = pages.filter((p) => !pagesBefore.includes(p));
    if (newer.length) {
      wpPage = newer[newer.length - 1];
      break;
    }
    const u = page.url();
    if (u.includes('wp-admin') || u.includes('wp-login')) {
      wpPage = page;
      break;
    }
    await sleep(150);
  }

  await wpPage.bringToFront().catch(() => {});
  await wpPage.waitForNavigation(GOTO).catch(() => {});
  await sleep(500);

  if (wpPage.url().includes('wp-login')) {
    await sleep(800);
  }

  log(`Đã vào WordPress: ${wpPage.url()}`);
  return { wpPage, projectName, projectLabel };
}

/**
 * Đồng bộ tài khoản khách lên WPM:
 * project URL?tab=tab-web-info
 * → mở Web card → endpoint đầu
 * → Add Account → điền username/password, Role=Editor, Notes="chủ tiệm"
 * → Submit/Save nếu có → verify username hiện trên form
 */
export async function syncAccountToWPM(page, projectUrl, account, log) {
  log('Quay lại WPM → tab Website Information...');
  await page.bringToFront().catch(() => {});

  const u = new URL(projectUrl);
  u.searchParams.set('tab', 'tab-web-info');
  const candidates = [
    u.toString(),
    `${projectUrl.replace(/\/$/, '')}?tab=tab-web-info`,
    projectUrl,
  ];

  let landed = false;
  for (const url of candidates) {
    await page.goto(url, GOTO);
    await sleep(400);

    await page.evaluate(() => {
      const tab =
        document.querySelector(
          'a[href="#tab-web-info"], a[href*="tab-web-info"], [data-bs-target="#tab-web-info"], [data-toggle="tab"][href="#tab-web-info"]'
        ) ||
        Array.from(document.querySelectorAll('a, button')).find((el) =>
          /website information|web info/i.test((el.textContent || '').trim())
        );
      tab?.click();
    });
    await sleep(250);

    const ok = await page.evaluate(() => {
      const pane = document.querySelector('#tab-web-info');
      return (
        !!document.querySelector('#web-info, #websContainer, .web-item') ||
        (pane && pane.classList.contains('active')) ||
        /website information|web:/i.test(document.body?.innerText || '')
      );
    });
    if (ok) {
      landed = true;
      break;
    }
  }

  if (!landed) {
    throw new Error('Không mở được tab Website Information trên WPM.');
  }

  log('Mở card header Web...');
  const openedWeb = await page.evaluate(() => {
    const header =
      document.querySelector('#web_0 .card-header, .web-item .card-header, #websContainer .card-header') ||
      Array.from(
        document.querySelectorAll(
          '.card-header[data-toggle="collapse"], .card-header[data-bs-toggle="collapse"]'
        )
      )[0];
    if (!header) return false;
    header.click();
    return true;
  });
  if (!openedWeb) {
    throw new Error('Không tìm thấy card-header Web để expand.');
  }
  await sleepExact(500);

  log('Mở endpoint đầu tiên...');
  const openedEndpoint = await page.evaluate(() => {
    const root =
      document.querySelector('#webContent_0.show, #webContent_0.collapse.show, #webContent_0') ||
      document.querySelector('#web_0, .web-item');

    const endpointHeader =
      root?.querySelector(
        '.endpoint .card-header, .endpoint-item .card-header, [id*="endpoint"] .card-header, .card-header[data-target*="endpoint"], .card-header[data-bs-target*="endpoint"]'
      ) ||
      Array.from(
        root?.querySelectorAll('.card-header, [data-toggle="collapse"], [role="button"]') || []
      ).find(
        (el) =>
          /endpoint|server|host|ftp|sftp|ssh/i.test(el.textContent || '') ||
          el !== root.querySelector('.card-header')
      );

    const headers = Array.from(
      root?.querySelectorAll(
        '.card-header[data-toggle="collapse"], .card-header[data-bs-toggle="collapse"], .card-header'
      ) || []
    );
    const target = endpointHeader || headers[1] || headers[0];
    if (!target) return false;
    if (headers.length > 1 && target === headers[0]) {
      headers[1].click();
      return true;
    }
    target.click();
    return true;
  });
  if (!openedEndpoint) {
    log('⚠ Không rõ endpoint header — thử Add Account trực tiếp trong web content.');
  }
  await sleepExact(500);

  // Đếm theo label "Username" — password WPM hay là type=text
  const countBefore = await page.evaluate(() =>
    Array.from(document.querySelectorAll('label, .form-label, span, div, p')).filter((el) => {
      if ((el.children?.length || 0) > 3) return false;
      const t = (el.childNodes?.[0]?.textContent || el.textContent || '')
        .replace(/\s+/g, ' ')
        .trim();
      return /^username\s*\*?$/i.test(t);
    }).length
  );
  log(`Add Account... (đang có ~${countBefore} account)`);

  const added = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('a, button, span, div[role="button"]'));
    const hit = btns.find((el) => {
      const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
      return /^add account\s*\+?$/i.test(t);
    });
    if (hit) {
      hit.scrollIntoView?.({ block: 'center' });
      hit.click();
      return true;
    }
    return false;
  });
  if (!added) {
    throw new Error('Không tìm thấy nút Add Account trên WPM.');
  }

  let appeared = false;
  const waitUntil = Date.now() + 12000;
  while (Date.now() < waitUntil) {
    const info = await page.evaluate((before) => {
      const labelCount = Array.from(
        document.querySelectorAll('label, .form-label, span, div, p')
      ).filter((el) => {
        if ((el.children?.length || 0) > 3) return false;
        const t = (el.childNodes?.[0]?.textContent || el.textContent || '')
          .replace(/\s+/g, ' ')
          .trim();
        return /^username\s*\*?$/i.test(t);
      }).length;

      const blocks = Array.from(
        document.querySelectorAll('.card, [class*="account"], .border, section, div')
      ).filter((el) => {
        const t = el.innerText || '';
        if (t.length > 2500) return false;
        return (
          /username/i.test(t) &&
          /role/i.test(t) &&
          (/password/i.test(t) || /account notes/i.test(t)) &&
          /quick login|generate|copy/i.test(t)
        );
      });
      const deepest = blocks.filter(
        (el) => !blocks.some((other) => other !== el && el.contains(other))
      );

      const emptyUser = deepest.some((b) => {
        const inputs = Array.from(b.querySelectorAll('input')).filter(
          (el) =>
            el.offsetParent !== null &&
            el.type !== 'hidden' &&
            el.type !== 'checkbox' &&
            el.type !== 'radio'
        );
        // Username thường là input text đầu tiên trong block
        const userInp = inputs.find((el) => el.type !== 'password') || inputs[0];
        return userInp && !String(userInp.value || '').trim();
      });

      return { labelCount, emptyUser, grew: labelCount > before };
    }, countBefore);

    if (info.grew || info.emptyUser) {
      appeared = true;
      log(
        info.grew
          ? `Đã thêm account mới (${countBefore} → ${info.labelCount}).`
          : 'Thấy ô Username trống — điền vào đó.'
      );
      break;
    }
    await sleepExact(250);
  }
  if (!appeared) {
    throw new Error('Bấm Add Account rồi nhưng không thấy form account mới.');
  }
  await sleepExact(500);

  log('Điền Username, Password, Role=Editor, Notes="chủ tiệm"...');

  const fieldIds = await page.evaluate(() => {
    const mark = (el, key) => {
      if (!el) return null;
      const id = `afp-wpm-${key}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      el.setAttribute('data-afp', id);
      el.scrollIntoView?.({ block: 'center' });
      return id;
    };

    const pickNearLabel = (root, labelRe, opts = {}) => {
      const nodes = Array.from(
        root.querySelectorAll('label, .form-label, span, div, p, strong')
      );
      const lab = nodes.find((el) => {
        if ((el.children?.length || 0) > 2) return false;
        const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
        return labelRe.test(t) && t.length < 40;
      });
      const scope = lab?.closest('.mb-3, .form-group, .col, .row, .form-floating, div') || root;
      const inputs = Array.from(scope.querySelectorAll('input, textarea, select')).filter(
        (el) => el.offsetParent !== null
      );
      if (opts.select) return inputs.find((el) => el.tagName === 'SELECT');
      if (opts.textarea) {
        return (
          inputs.find((el) => el.tagName === 'TEXTAREA') ||
          inputs.find((el) => /note/i.test(el.placeholder || ''))
        );
      }
      if (opts.password) {
        return (
          inputs.find((el) => el.type === 'password') ||
          inputs.find((el) => el.tagName === 'INPUT' && el.type !== 'checkbox')
        );
      }
      return inputs.find(
        (el) => el.tagName === 'INPUT' && el.type !== 'checkbox' && el.type !== 'password'
      );
    };

    const candidates = Array.from(
      document.querySelectorAll('.card, [class*="account"], .border, section, div')
    ).filter((el) => {
      const t = el.innerText || '';
      if (t.length > 2500) return false;
      return (
        /username/i.test(t) &&
        /role/i.test(t) &&
        (/password/i.test(t) || /account notes/i.test(t)) &&
        /quick login|generate|copy/i.test(t)
      );
    });
    const blocks = candidates.filter(
      (el) => !candidates.some((other) => other !== el && el.contains(other))
    );

    let block =
      blocks.find((b) => {
        const u = pickNearLabel(b, /^username\s*\*?$/i);
        return u && !String(u.value || '').trim();
      }) || blocks[blocks.length - 1];

    if (!block) {
      const addBtn = Array.from(document.querySelectorAll('a, button, span')).find((el) =>
        /^add account/i.test((el.textContent || '').trim())
      );
      block = addBtn?.parentElement || document.body;
    }

    const usernameEl = pickNearLabel(block, /^username\s*\*?$/i);
    let passwordEl = pickNearLabel(block, /^password\s*\*?$/i, { password: true });
    // Password WPM thường type=text — nếu pick nhầm username thì lấy input thứ 2
    if (passwordEl && passwordEl === usernameEl) {
      const inputs = Array.from(block.querySelectorAll('input')).filter(
        (el) => el.offsetParent !== null && el.type !== 'checkbox' && el.type !== 'hidden'
      );
      passwordEl = inputs.find((el) => el !== usernameEl) || passwordEl;
    }
    const notesEl = pickNearLabel(block, /account notes/i, { textarea: true });
    let roleEl = pickNearLabel(block, /^role$/i, { select: true });
    if (!roleEl) {
      roleEl = Array.from(block.querySelectorAll('select')).find((el) =>
        Array.from(el.options || []).some((o) => /editor|admin|tech/i.test(o.text || ''))
      );
    }

    return {
      username: mark(usernameEl, 'user'),
      password: mark(passwordEl, 'pass'),
      notes: mark(notesEl, 'notes'),
      role: mark(roleEl, 'role'),
      blockCount: blocks.length,
    };
  });

  if (!fieldIds.username || !fieldIds.password) {
    throw new Error(
      `Không tìm thấy ô Username/Password của account mới (user=${!!fieldIds.username}, pass=${!!fieldIds.password}, blocks=${fieldIds.blockCount}).`
    );
  }

  const userHandle = await page.$(`[data-afp="${fieldIds.username}"]`);
  const passHandle = await page.$(`[data-afp="${fieldIds.password}"]`);
  if (!userHandle || !passHandle) {
    throw new Error('Không gắn được handle Username/Password trên WPM.');
  }

  await fillNative(page, userHandle, account.username);
  await fillNative(page, passHandle, account.password);

  if (fieldIds.notes) {
    const notesHandle = await page.$(`[data-afp="${fieldIds.notes}"]`);
    if (notesHandle) await fillNative(page, notesHandle, 'chủ tiệm');
  }

  let roleOk = false;
  if (fieldIds.role) {
    roleOk = await page.evaluate((sel) => {
      const roleEl = document.querySelector(`[data-afp="${sel}"]`);
      if (!roleEl) return false;
      if (roleEl.tagName === 'SELECT') {
        const opt = Array.from(roleEl.options).find(
          (o) => /editor/i.test((o.text || '').trim()) || /^editor$/i.test(o.value)
        );
        if (!opt) return false;
        roleEl.value = opt.value;
        roleEl.dispatchEvent(new Event('input', { bubbles: true }));
        roleEl.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      }
      return false;
    }, fieldIds.role);

    if (!roleOk) {
      roleOk = await page.evaluate((sel) => {
        const roleEl = document.querySelector(`[data-afp="${sel}"]`);
        const wrap = roleEl?.closest('div') || roleEl;
        wrap?.click();
        const opt = Array.from(
          document.querySelectorAll('li, option, .dropdown-item, [role="option"]')
        ).find((el) => /^editor$/i.test((el.textContent || '').trim()));
        if (opt) {
          opt.click();
          return true;
        }
        return false;
      }, fieldIds.role);
    }
  }
  log(`Đã điền form (role=${roleOk}, notes=${!!fieldIds.notes}). Lưu...`);

  // Đọc lại value vừa type (trước Submit) — xác nhận điền được
  const typedOk = await page.evaluate(
    (userSel, user) => {
      const el = document.querySelector(`[data-afp="${userSel}"]`);
      return el && String(el.value || '').trim() === user;
    },
    fieldIds.username,
    account.username
  );
  if (!typedOk) {
    log('⚠ Ô Username chưa giữ đúng giá trị sau khi type — vẫn Submit thử...');
  }

  const submitted = await page.evaluate(() => {
    const texts = [/^\s*submit\s*$/i, /^\s*save\s*$/i, /^\s*update\s*$/i, /^\s*create\s*$/i];
    const btns = Array.from(
      document.querySelectorAll('button, input[type="submit"], a.btn, [role="button"]')
    );
    for (const re of texts) {
      const hit = btns.find((el) => {
        const t = (el.innerText || el.value || el.textContent || '').replace(/\s+/g, ' ').trim();
        return re.test(t) && el.offsetParent !== null;
      });
      if (hit) {
        hit.scrollIntoView?.({ block: 'center' });
        hit.click();
        return (hit.innerText || hit.value || '').trim();
      }
    }
    return null;
  });

  if (submitted) {
    log(`Đã bấm "${submitted}" trên WPM (sync account).`);
  } else {
    try {
      await clickByText(page, 'Submit', { timeout: 2500 });
      log('Đã bấm Submit trên WPM (fallback).');
    } catch {
      log('⚠ Không thấy Submit/Save — WPM có thể tự lưu khi đổi field.');
    }
  }

  await sleepExact(2000);

  // Verify: reload tab Website Information rồi tìm username (kể cả input ẩn / text)
  const checkUserOnWpm = async () =>
    page.evaluate((user) => {
      const inInputs = Array.from(document.querySelectorAll('input, textarea')).some(
        (el) => String(el.value || '').trim() === user
      );
      const inText = (document.body?.innerText || '').includes(user);
      return inInputs || inText;
    }, account.username);

  let verified = await checkUserOnWpm();
  if (!verified) {
    log('Chưa thấy username trên form sau Submit — reload tab Website Information kiểm tra...');
    const u = new URL(projectUrl);
    u.searchParams.set('tab', 'tab-web-info');
    await page.goto(u.toString(), GOTO);
    await sleepExact(800);
    await page.evaluate(() => {
      const tab =
        document.querySelector(
          'a[href="#tab-web-info"], a[href*="tab-web-info"], [data-bs-target="#tab-web-info"]'
        ) ||
        Array.from(document.querySelectorAll('a, button')).find((el) =>
          /website information/i.test((el.textContent || '').trim())
        );
      tab?.click();
    });
    await sleepExact(400);
    // Mở Web + Endpoint để account hiện lại
    await page.evaluate(() => {
      document
        .querySelector('#web_0 .card-header, .web-item .card-header, #websContainer .card-header')
        ?.click();
    });
    await sleepExact(400);
    await page.evaluate(() => {
      const root =
        document.querySelector('#webContent_0, #web_0, .web-item') || document.body;
      const headers = Array.from(root.querySelectorAll('.card-header'));
      (headers[1] || headers[0])?.click();
    });
    await sleepExact(600);
    verified = await checkUserOnWpm();
  }

  if (verified) {
    log(`Đã sync tài khoản "${account.username}" lên WPM (Website Information).`);
    return;
  }

  // Đã Submit + đã điền — WP user tạo riêng ở bước trước; không fail cả job vì verify DOM WPM
  if (submitted || typedOk) {
    log(
      `⚠ Sau Submit chưa thấy "${account.username}" trên DOM WPM (có thể form đã đóng). ` +
        'Coi như đã sync — kiểm tra tay tab Website Information nếu cần.'
    );
    return;
  }

  throw new Error(
    `Không sync được account "${account.username}" lên WPM (chưa Submit / chưa thấy trên form).`
  );
}
