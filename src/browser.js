import fs from 'fs';
import path from 'path';
import os from 'os';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { isLiveVncActive } from './liveVnc.js';

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
 * Headed chỉ khi cần xem Live; còn lại headless cho nhanh.
 * - force=true (Resume / wantLive) → headed
 * - Live panel đang mở → headed (noVNC)
 * - FORCE_HEADED=true → headed
 * - HEADLESS=true → luôn headless
 * - CHROME_LIVE + Live tắt → headless (không vẽ Xvfb)
 * - Local không CHROME_LIVE → theo HEADLESS (mặc định headed để debug)
 * @param {{ force?: boolean }} [opts]
 */
export function shouldRunHeaded(opts = {}) {
  if (opts.force) return true;
  if (process.env.FORCE_HEADED === 'true') return true;
  if (process.env.HEADLESS === 'true') return false;
  if (process.env.CHROME_LIVE === 'true') {
    try {
      return isLiveVncActive();
    } catch {
      return false;
    }
  }
  return process.env.HEADLESS !== 'true';
}

/**
 * Launch system Chrome with stealth — tránh navigator.webdriver lộ như Playwright CDP.
 * @param {{ downloadPath?: string, headless?: boolean, forceHeaded?: boolean }} [opts]
 */
export async function launchBrowser({
  downloadPath,
  headless: headlessOpt,
  forceHeaded = false,
  display, // (S6) Display riêng cho user — cô lập Live VNC
} = {}) {
  const executablePath = findChromePath();
  const chromeLiveEnv = process.env.CHROME_LIVE === 'true';
  const headless =
    headlessOpt !== undefined
      ? Boolean(headlessOpt)
      : !shouldRunHeaded({ force: forceHeaded });
  const userDataDir = process.env.CHROME_USER_DATA_DIR || undefined;

  const args = [
    '--disable-blink-features=AutomationControlled',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-infobars',
    '--window-size=1440,900',
  ];

  if (chromeLiveEnv && !headless) {
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
  }

  // Headless nhanh hơn: tắt nền / extension / sync không cần cho automation
  if (headless) {
    args.push(
      '--disable-background-networking',
      '--disable-extensions',
      '--disable-sync',
      '--metrics-recording-only',
      '--mute-audio',
      '--no-pings'
    );
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
    // (S6) Chạy Chrome trên display riêng của user nếu có
    ...(display ? { env: { ...process.env, DISPLAY: display } } : {}),
  });

  const page = await browser.newPage();
  page.setDefaultTimeout(45000);
  page.setDefaultNavigationTimeout(60000);

  // Live: ép cửa sổ full Xvfb — tránh cửa sổ nhỏ giữa desktop
  // Không setViewport (headed) — viewport giả sẽ làm trang nhỏ trong cửa sổ.
  if (!headless && chromeLiveEnv) {
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
