import { sleep, sleepExact, GOTO, clickByText, clickFirst } from '../utils.js';

/**
 * Điền field theo label text trên trang task edit (Output fields).
 * Hỗ trợ input + textarea, React/Vue-friendly.
 */
async function fillByLabel(page, labelNeedle, value) {
  const want = String(value ?? '');
  const found = await page.evaluate(
    (needle, val) => {
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
        // Chỉ lấy node gần như là label (ít con)
        if (lab.children?.length > 4) continue;
        const t = norm(lab.textContent);
        if (!t) continue;
        // Exact hoặc bắt đầu bằng (Login Url, User name, …)
        if (t !== target && !t.startsWith(target) && t !== `${target}:`) continue;

        let input =
          lab.control ||
          (lab.getAttribute('for')
            ? document.getElementById(lab.getAttribute('for'))
            : null);

        if (!input) {
          const row =
            lab.closest(
              '.form-group, .mb-3, .row, tr, .field, .form-field, .output-field, [class*="field"]'
            ) || lab.parentElement;
          input = row?.querySelector('input:not([type="hidden"]), textarea');
        }
        if (!input) {
          // next sibling
          let n = lab.nextElementSibling;
          while (n && !input) {
            if (n.matches?.('input, textarea')) input = n;
            else input = n.querySelector?.('input:not([type="hidden"]), textarea');
            n = n.nextElementSibling;
          }
        }
        if (!input) continue;

        input.focus();
        input.value = '';
        input.value = val;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        input.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
        return {
          ok: true,
          tag: input.tagName,
          name: input.name || input.id || '',
          value: input.value,
        };
      }
      return { ok: false };
    },
    labelNeedle,
    want
  );

  if (!found?.ok) {
    // Fallback: type thật nếu tìm được handle
    const handle = await page.evaluateHandle((needle) => {
      const norm = (s) =>
        String(s || '')
          .replace(/\s+/g, ' ')
          .replace(/\*/g, '')
          .trim()
          .toLowerCase();
      const target = norm(needle);
      for (const lab of document.querySelectorAll('label, .form-label, .col-form-label')) {
        const t = norm(lab.textContent);
        if (t !== target && !t.startsWith(target)) continue;
        const row =
          lab.closest('.form-group, .mb-3, .row, tr') || lab.parentElement;
        return row?.querySelector('input:not([type="hidden"]), textarea') || null;
      }
      return null;
    }, labelNeedle);

    const el = handle.asElement();
    if (!el) {
      await handle.dispose().catch(() => {});
      throw new Error(`Không tìm thấy field "${labelNeedle}" trên task.`);
    }
    await el.click({ clickCount: 3 });
    await el.type(want, { delay: 8 });
    await handle.dispose().catch(() => {});
    return;
  }

  if (found.value !== want) {
    // set lại bằng type nếu React nuốt value
    const handle = await page.evaluateHandle((needle) => {
      const norm = (s) =>
        String(s || '')
          .replace(/\s+/g, ' ')
          .replace(/\*/g, '')
          .trim()
          .toLowerCase();
      const target = norm(needle);
      for (const lab of document.querySelectorAll('label, .form-label, .col-form-label')) {
        const t = norm(lab.textContent);
        if (t !== target && !t.startsWith(target)) continue;
        const row =
          lab.closest('.form-group, .mb-3, .row, tr') || lab.parentElement;
        return row?.querySelector('input:not([type="hidden"]), textarea') || null;
      }
      return null;
    }, labelNeedle);
    const el = handle.asElement();
    if (el) {
      await el.click({ clickCount: 3 });
      await page.keyboard.press('Backspace');
      await el.type(want, { delay: 8 });
    }
    await handle.dispose().catch(() => {});
  }
}

/**
 * Sau khi xong pipeline: mở task URL → điền Output fields → Save.
 * @param {import('puppeteer').Page} page — tab WPM đã login
 * @param {string} taskUrl
 * @param {{ loginUrl: string, guideFile: string, username: string, password: string, note?: string }} output
 */
export async function fillTaskOutputFields(page, taskUrl, output, log) {
  if (!taskUrl) {
    log('⏭ Không có Task URL — bỏ qua điền Output fields.');
    return;
  }

  log(`▶ Điền Output fields trên task: ${taskUrl}`);
  await page.bringToFront().catch(() => {});
  await page.goto(taskUrl, GOTO);
  await sleepExact(800);

  // Chờ section Output fields hoặc field Login Url
  await page
    .waitForFunction(
      () => {
        const body = document.body?.innerText || '';
        return /output fields/i.test(body) || /login\s*url/i.test(body);
      },
      { timeout: 20000 }
    )
    .catch(() => {});

  const loginUrl = output.loginUrl || '';
  const guideFile = output.guideFile || output.docLink || '';
  const username = output.username || '';
  const password = output.password || '';
  const note = output.note || (password ? `password: ${password}` : 'password:');

  await fillByLabel(page, 'Login Url', loginUrl);
  log(`  Login Url ✓`);
  await sleep(200);

  await fillByLabel(page, 'Guide File', guideFile);
  log(`  Guide File ✓`);
  await sleep(200);

  // Label trên form: "User name"
  try {
    await fillByLabel(page, 'User name', username);
  } catch {
    await fillByLabel(page, 'Username', username);
  }
  log(`  User name ✓`);
  await sleep(200);

  await fillByLabel(page, 'Password', password);
  log(`  Password ✓`);
  await sleep(200);

  try {
    await fillByLabel(page, 'Note', note);
    log(`  Note ✓`);
  } catch {
    log('⚠ Không tìm thấy Note — bỏ qua.');
  }

  // Save / Update / Done
  let saved = false;
  for (const text of ['Save', 'Update', 'Submit', 'Done']) {
    try {
      await clickByText(page, text, { timeout: 2500 });
      saved = true;
      log(`Đã bấm ${text}.`);
      break;
    } catch {
      /* try next */
    }
  }
  if (!saved) {
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
      saved = true;
      log('Đã bấm nút submit.');
    } catch {
      /* fallthrough */
    }
  }
  if (!saved) {
    throw new Error('Đã điền Output fields nhưng không tìm thấy nút Save/Update.');
  }

  await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
  await sleep(500);
  log('Đã điền xong Output fields trên task.');
}
