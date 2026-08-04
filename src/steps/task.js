import { sleep, sleepExact, GOTO, clickByText, clickFirst } from '../utils.js';

/**
 * Điền input/textarea theo kiểu React/Vue (clear + type thật) — giống sync WPM.
 * Gán .value trực tiếp thường hiện chữ nhưng model không nhận → Save không lưu.
 */
async function fillNativeHandle(page, handle, value) {
  const want = String(value ?? '');
  await handle.focus();
  await page.evaluate((el) => {
    el.select?.();
    el.value = '';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, handle);
  await handle.type(want, { delay: 5 });
  await page.evaluate((el) => {
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.blur();
  }, handle);
}

/**
 * Tìm input/textarea theo label — trả về true nếu điền được, false nếu không có field.
 * Không throw khi thiếu field (task thường ≠ userguide).
 */
async function fillByLabelIfPresent(page, labelNeedle, value) {
  const want = String(value ?? '');
  if (!want) return false;

  const handle = await page.evaluateHandle((needle) => {
    const norm = (s) =>
      String(s || '')
        .replace(/\s+/g, ' ')
        .replace(/\*/g, '')
        .trim()
        .toLowerCase();
    const target = norm(needle);

    const labels = Array.from(
      document.querySelectorAll('label, .form-label, .col-form-label, span, div, p, th, td')
    );

    for (const lab of labels) {
      if (lab.children?.length > 4) continue;
      const t = norm(lab.textContent);
      if (!t) continue;
      if (t !== target && !t.startsWith(target) && t !== `${target}:`) continue;

      let input =
        lab.control ||
        (lab.getAttribute('for') ? document.getElementById(lab.getAttribute('for')) : null);

      if (!input) {
        const row =
          lab.closest(
            '.form-group, .mb-3, .row, tr, .field, .form-field, .output-field, [class*="field"]'
          ) || lab.parentElement;
        input = row?.querySelector('input:not([type="hidden"]), textarea');
      }
      if (!input) {
        let n = lab.nextElementSibling;
        while (n && !input) {
          if (n.matches?.('input, textarea')) input = n;
          else input = n.querySelector?.('input:not([type="hidden"]), textarea');
          n = n.nextElementSibling;
        }
      }
      if (input) return input;
    }
    return null;
  }, labelNeedle);

  const el = handle.asElement();
  if (!el) {
    await handle.dispose().catch(() => {});
    return false;
  }

  try {
    await fillNativeHandle(page, el, want);
    const got = await page.evaluate((node) => String(node?.value || ''), el);
    return got === want || got.includes(want.slice(0, Math.min(40, want.length)));
  } finally {
    await handle.dispose().catch(() => {});
  }
}

async function tryFill(page, labels, value, log, displayName) {
  for (const label of labels) {
    const ok = await fillByLabelIfPresent(page, label, value);
    if (ok) {
      log(`  ${displayName} ✓`);
      return true;
    }
  }
  log(`  ⏭ ${displayName} — không có field, bỏ qua`);
  return false;
}

async function clickTaskSave(page, log) {
  // WPM task edit: <button type="submit" form="taskEditForm" id="submitEditBtn">…Save</button>
  try {
    await clickFirst(
      page,
      [
        '#submitEditBtn',
        'button#submitEditBtn[type="submit"]',
        'button[type="submit"][form="taskEditForm"]',
        'button.btn-success[form="taskEditForm"]',
      ],
      { timeout: 5000 }
    );
    log('Đã bấm Save (#submitEditBtn).');
    return true;
  } catch {
    /* fallback bên dưới */
  }

  const scoped = await page.evaluate(() => {
    const btn =
      document.querySelector('#submitEditBtn') ||
      document.querySelector('button[type="submit"][form="taskEditForm"]');
    if (btn) {
      btn.click();
      return { clicked: true, how: '#submitEditBtn' };
    }

    const form = document.querySelector('#taskEditForm, form#taskEditForm');
    const roots = form ? [form, document] : [document];
    for (const root of roots) {
      const candidates = Array.from(
        root.querySelectorAll(
          'button[type="submit"], input[type="submit"], button.btn-success, button'
        )
      );
      const exact = candidates.find((el) => {
        const t = (el.innerText || el.value || el.textContent || '').replace(/\s+/g, ' ').trim();
        return /^(save|update|submit|done)$/i.test(t) || el.id === 'submitEditBtn';
      });
      if (exact) {
        exact.click();
        return { clicked: true, how: (exact.id || exact.innerText || 'submit').trim() };
      }
    }
    return { clicked: false, how: '' };
  });

  if (scoped.clicked) {
    log(`Đã bấm Save (${scoped.how}).`);
    return true;
  }

  for (const text of ['Save', 'Update', 'Submit', 'Done']) {
    try {
      await clickByText(page, text, { exact: true, timeout: 2000 });
      log(`Đã bấm ${text}.`);
      return true;
    } catch {
      /* try next */
    }
  }

  try {
    await clickFirst(
      page,
      [
        'button[type="submit"]',
        'input[type="submit"]',
        'button.btn-primary',
        'button.btn-success',
      ],
      { timeout: 4000 }
    );
    log('Đã bấm nút submit.');
    return true;
  } catch {
    return false;
  }
}

async function readOutputFieldValues(page) {
  return page.evaluate(() => {
    const norm = (s) =>
      String(s || '')
        .replace(/\s+/g, ' ')
        .replace(/\*/g, '')
        .trim()
        .toLowerCase();

    const read = (needles) => {
      const labels = Array.from(
        document.querySelectorAll('label, .form-label, .col-form-label, span, div, p, th, td')
      );
      for (const needle of needles) {
        const target = norm(needle);
        for (const lab of labels) {
          if (lab.children?.length > 4) continue;
          const t = norm(lab.textContent);
          if (!t || (t !== target && !t.startsWith(target) && t !== `${target}:`)) continue;
          let input =
            lab.control ||
            (lab.getAttribute('for') ? document.getElementById(lab.getAttribute('for')) : null);
          if (!input) {
            const row =
              lab.closest(
                '.form-group, .mb-3, .row, tr, .field, .form-field, .output-field, [class*="field"]'
              ) || lab.parentElement;
            input = row?.querySelector('input:not([type="hidden"]), textarea');
          }
          if (input?.value) return String(input.value);
        }
      }
      return '';
    };

    return {
      loginUrl: read(['Login Url']),
      guideFile: read(['Guide File']),
      username: read(['User name', 'Username']),
      password: read(['Password']),
    };
  });
}

async function fillAllOutputFields(page, output, log) {
  const loginUrl = output.loginUrl || '';
  const guideFile = output.guideFile || output.docLink || '';
  const username = output.username || '';
  const password =
    output.accountExists || /đã tồn tại|không có password/i.test(String(output.password || ''))
      ? ''
      : output.password || '';

  let filled = 0;
  if (await tryFill(page, ['Login Url'], loginUrl, log, 'Login Url')) filled += 1;
  await sleep(150);
  if (await tryFill(page, ['Guide File'], guideFile, log, 'Guide File')) filled += 1;
  await sleep(150);
  if (await tryFill(page, ['User name', 'Username'], username, log, 'User name')) filled += 1;
  await sleep(150);
  if (password) {
    if (await tryFill(page, ['Password'], password, log, 'Password')) filled += 1;
  } else {
    log('  ⏭ Password — bỏ qua (không có / TK đã tồn tại)');
  }
  log('  ⏭ Note — bỏ qua (không điền tự động)');
  return { filled, loginUrl, username };
}

/**
 * Sau pipeline: mở task URL → điền Output fields nếu có → Save.
 * Task thường (không userguide) có thể thiếu field → skip, AM lấy output trên UI tool.
 */
export async function fillTaskOutputFields(page, taskUrl, output, log) {
  if (!taskUrl) {
    log('⏭ Không có Task URL — bỏ qua điền Output fields.');
    return { filled: 0, skipped: true };
  }

  log(`▶ Điền Output fields trên task (có field mới điền): ${taskUrl}`);
  await page.bringToFront().catch(() => {});
  await page.goto(taskUrl, GOTO);
  await sleepExact(800);

  await page
    .waitForFunction(
      () => {
        const body = document.body?.innerText || '';
        return /output fields|login\s*url|guide\s*file|customer requirement/i.test(body);
      },
      { timeout: 15000 }
    )
    .catch(() => {});

  const first = await fillAllOutputFields(page, output, log);
  if (first.filled === 0) {
    log(
      '⏭ Task không có Output fields (userguide) — bỏ qua Save. AM lấy Login/User/Pass trên UI tool.'
    );
    return { filled: 0, skipped: true };
  }

  const saved = await clickTaskSave(page, log);
  if (!saved) {
    log('⚠ Đã điền một số field nhưng không tìm thấy Save — AM kiểm tra task / lấy output trên UI.');
    return { filled: first.filled, saved: false };
  }

  await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
  await sleep(800);

  // Xác nhận persist: reload và đọc lại
  await page.goto(taskUrl, GOTO);
  await sleepExact(700);
  const after = await readOutputFieldValues(page);
  const loginOk =
    !first.loginUrl ||
    (after.loginUrl &&
      (after.loginUrl === first.loginUrl || after.loginUrl.includes(first.loginUrl.slice(0, 40))));
  const userOk =
    !first.username ||
    (after.username &&
      (after.username === first.username || after.username.includes(first.username)));

  if (loginOk && userOk) {
    log(
      `✓ Đã lưu Output trên task (verify OK): login=${after.loginUrl ? '✓' : '—'} user=${after.username ? '✓' : '—'}`
    );
    log(`Đã điền ${first.filled} Output field(s) trên task.`);
    return { filled: first.filled, saved: true, verified: true };
  }

  log(
    `⚠ Save xong nhưng field chưa thấy sau reload (login="${(after.loginUrl || '').slice(0, 40)}", user="${(after.username || '').slice(0, 40)}") — điền lại 1 lần...`
  );
  const second = await fillAllOutputFields(page, output, log);
  const saved2 = await clickTaskSave(page, log);
  if (!saved2) {
    log('⚠ Retry: không bấm được Save.');
    return { filled: second.filled, saved: false, verified: false };
  }
  await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
  await sleep(800);
  await page.goto(taskUrl, GOTO);
  await sleepExact(700);
  const after2 = await readOutputFieldValues(page);
  const ok2 =
    (!first.loginUrl || after2.loginUrl) && (!first.username || after2.username);
  if (ok2) {
    log(`✓ Retry lưu Output trên task OK.`);
    return { filled: second.filled, saved: true, verified: true };
  }

  log(
    '⚠ Vẫn chưa verify được field sau Save — AM kiểm tra task tay / lấy output trên UI tool.'
  );
  return { filled: second.filled, saved: true, verified: false };
}
