/**
 * Smoke / calibrate: Chrome + stealth, kiểm tra navigator.webdriver.
 * Chạy: node scripts/calibrate.js
 */
import 'dotenv/config';
import { launchBrowser, findChromePath } from '../src/browser.js';

async function main() {
  console.log('Chrome path:', findChromePath());
  const { browser, page } = await launchBrowser();

  await page.goto('data:text/html,<html><body>ok</body></html>');
  const flags = await page.evaluate(() => ({
    webdriver: navigator.webdriver,
    webdriverType: typeof navigator.webdriver,
    hasChrome: !!(window.chrome && window.chrome.runtime),
    ua: navigator.userAgent,
  }));

  console.log('navigator.webdriver =', flags.webdriver);
  console.log('typeof navigator.webdriver =', flags.webdriverType);
  console.log('window.chrome.runtime =', flags.hasChrome);
  console.log('UA:', flags.ua);

  // Thử vào một trang public nhẹ
  await page.goto('https://example.com', { waitUntil: 'domcontentloaded', timeout: 30000 });
  const title = await page.title();
  console.log('example.com title:', title);

  const ok =
    flags.webdriver === undefined ||
    flags.webdriver === false ||
    flags.webdriverType === 'undefined';

  if (!ok) {
    console.error('FAIL: webdriver vẫn lộ =', flags.webdriver);
    await browser.close();
    process.exit(1);
  }

  console.log('PASS: stealth OK (webdriver không lộ true).');
  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
