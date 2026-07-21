import { sleep, sleepExact, GOTO, clickByText, clickFirst } from '../utils.js';

/**
 * Tìm input/textarea theo label — trả về true nếu điền được, false nếu không có field.
 * Không throw khi thiếu field (task thường ≠ userguide).
 */
async function fillByLabelIfPresent(page, labelNeedle, value) {
  const want = String(value ?? '');
  if (!want) return false;

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
        if (!input) continue;

        input.focus();
        input.value = '';
        input.value = val;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        input.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
        return {
          ok: true,
          value: input.value,
        };
      }
      return { ok: false };
    },
    labelNeedle,
    want
  );

  if (found?.ok && found.value === want) return true;

  // Fallback type thật nếu có handle
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
      const row = lab.closest('.form-group, .mb-3, .row, tr') || lab.parentElement;
      return row?.querySelector('input:not([type="hidden"]), textarea') || null;
    }
    return null;
  }, labelNeedle);

  const el = handle.asElement();
  if (!el) {
    await handle.dispose().catch(() => {});
    return false;
  }
  await el.click({ clickCount: 3 });
  await page.keyboard.press('Backspace').catch(() => {});
  await el.type(want, { delay: 8 });
  await handle.dispose().catch(() => {});
  return true;
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

  const loginUrl = output.loginUrl || '';
  const guideFile = output.guideFile || output.docLink || '';
  const username = output.username || '';
  const password = output.password || '';
  const note = output.note || '';

  let filled = 0;
  if (await tryFill(page, ['Login Url'], loginUrl, log, 'Login Url')) filled += 1;
  await sleep(150);
  if (await tryFill(page, ['Guide File'], guideFile, log, 'Guide File')) filled += 1;
  await sleep(150);
  if (await tryFill(page, ['User name', 'Username'], username, log, 'User name')) filled += 1;
  await sleep(150);
  if (await tryFill(page, ['Password'], password, log, 'Password')) filled += 1;
  await sleep(150);
  if (note) {
    if (await tryFill(page, ['Note'], note, log, 'Note')) filled += 1;
  } else {
    log('  ⏭ Note — không có nội dung, bỏ qua');
  }

  if (filled === 0) {
    log(
      '⏭ Task không có Output fields (userguide) — bỏ qua Save. AM lấy Login/User/Pass trên UI tool.'
    );
    return { filled: 0, skipped: true };
  }

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
    log('⚠ Đã điền một số field nhưng không tìm thấy Save — AM kiểm tra task / lấy output trên UI.');
    return { filled, saved: false };
  }

  await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
  await sleep(500);
  log(`Đã điền ${filled} Output field(s) trên task.`);
  return { filled, saved: true };
}
