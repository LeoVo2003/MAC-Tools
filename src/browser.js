import fs from 'fs';
import path from 'path';
import os from 'os';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

puppeteer.use(StealthPlugin());

const DEFAULT_CHROME_PATHS = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
].filter(Boolean);

export function findChromePath() {
  for (const p of DEFAULT_CHROME_PATHS) {
    try {
      if (p && fs.existsSync(p)) return p;
    } catch {
      /* skip */
    }
  }
  throw new Error(
    'Không tìm thấy Google Chrome. Cài Chrome hoặc set CHROME_PATH trong .env'
  );
}

/**
 * Launch system Chrome with stealth — tránh navigator.webdriver lộ như Playwright CDP.
 * @param {{ downloadPath?: string, headless?: boolean }} [opts]
 */
export async function launchBrowser({ downloadPath, headless: headlessOpt } = {}) {
  const executablePath = findChromePath();
  // CHROME_LIVE / DISPLAY (Docker Xvfb): luôn headed để noVNC xem + tương tác
  const chromeLive =
    process.env.CHROME_LIVE === 'true' || Boolean(String(process.env.DISPLAY || '').trim());
  const headless =
    headlessOpt !== undefined
      ? Boolean(headlessOpt)
      : chromeLive
        ? false
        : process.env.HEADLESS === 'true';
  const userDataDir = process.env.CHROME_USER_DATA_DIR || undefined;

  const args = [
    '--disable-blink-features=AutomationControlled',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-infobars',
    '--window-size=1440,900',
  ];

  if (chromeLive && !headless) {
    args.push('--start-maximized', '--window-position=0,0');
  }

  // Docker/Linux chạy Chromium thường là root → bắt buộc --no-sandbox
  // (crbug.com/638180). --disable-dev-shm-usage tránh crash /dev/shm nhỏ.
  const needNoSandbox =
    process.env.CHROME_NO_SANDBOX === 'true' ||
    process.platform === 'linux' ||
    (typeof process.getuid === 'function' && process.getuid() === 0);
  if (needNoSandbox) {
    args.push('--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage');
    // Headed trên Xvfb vẫn dùng GPU software; disable-gpu giúp ổn định container
    if (headless || chromeLive) args.push('--disable-gpu');
  }

  const screenW = Number(process.env.CHROME_SCREEN_W) || 1440;
  const screenH = Number(process.env.CHROME_SCREEN_H) || 900;

  const browser = await puppeteer.launch({
    executablePath,
    headless: headless ? 'new' : false,
    defaultViewport: headless ? { width: screenW, height: screenH } : null,
    args,
    ignoreDefaultArgs: ['--enable-automation'],
    ignoreHTTPSErrors: true,
    userDataDir,
  });

  const page = await browser.newPage();
  page.setDefaultTimeout(45000);
  page.setDefaultNavigationTimeout(60000);

  // Live: ép cửa sổ full Xvfb — tránh cửa sổ nhỏ giữa desktop
  // Không setViewport (headed) — viewport giả sẽ làm trang nhỏ trong cửa sổ.
  if (chromeLive && !headless) {
    try {
      const session = await page.createCDPSession();
      const { windowId } = await session.send('Browser.getWindowForTarget');
      await session.send('Browser.setWindowBounds', {
        windowId,
        bounds: {
          left: 0,
          top: 0,
          width: screenW,
          height: screenH,
          windowState: 'normal',
        },
      });
    } catch {
      /* ignore */
    }
  }

  // Patch sớm trước mọi document (bổ sung stealth plugin)
  await page.evaluateOnNewDocument(() => {
    try {
      Object.defineProperty(navigator, 'webdriver', {
        get: () => undefined,
        configurable: true,
      });
    } catch {
      /* ignore */
    }
    if (!window.chrome) {
      window.chrome = { runtime: {} };
    } else if (!window.chrome.runtime) {
      window.chrome.runtime = {};
    }
  });

  if (downloadPath) {
    const client = await page.createCDPSession();
    await client.send('Page.setDownloadBehavior', {
      behavior: 'allow',
      downloadPath,
    });
  }

  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36'
  );

  return { browser, page };
}

export async function newPage(browser, { downloadPath } = {}) {
  const page = await browser.newPage();
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', {
      get: () => undefined,
    });
    window.chrome = window.chrome || { runtime: {} };
  });
  if (downloadPath) {
    const client = await page.createCDPSession();
    await client.send('Page.setDownloadBehavior', {
      behavior: 'allow',
      downloadPath,
    });
  }
  return page;
}
