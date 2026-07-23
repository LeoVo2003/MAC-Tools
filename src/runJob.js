import fs from 'fs';
import path from 'path';
import { launchBrowser } from './browser.js';
import {
  ensureDirs,
  screenshotError,
  DOWNLOADS_DIR,
  ROOT,
  dismissBlockingAlerts,
  normalizeWpmProjectUrl,
} from './utils.js';
import { loginToWPM, openProjectAndQuickLogin, syncAccountToWPM } from './steps/wpm.js';
import { installAndBackupUpdraftPlus } from './steps/backup.js';
import { createCustomerAccount } from './steps/user.js';
import { installMacRoleViaMacCore, configureFPackageUser } from './steps/macRole.js';
import { pullWebInfoToDashboard } from './steps/webInfo.js';
import { fillTaskOutputFields } from './steps/task.js';
import {
  startLiveSession,
  stopLiveSession,
  setLivePage,
} from './liveSession.js';
import { registerLiveBrowser, unregisterLiveBrowser } from './liveBrowser.js';

/** Các bước có thể tick/bỏ tick trên UI (login WPM + Quick Login luôn chạy). */
export const SELECTABLE_STEPS = [
  { id: 'backup', label: 'Backup UpdraftPlus' },
  { id: 'createUser', label: 'Tạo tài khoản khách' },
  { id: 'syncWpm', label: 'Sync tài khoản lên WPM' },
  { id: 'macCore', label: 'Mac Core → cài Mac Role' },
  { id: 'macRole', label: 'Mac Role → F Package User' },
  { id: 'webInfo', label: 'Web Info → Dashboard' },
];

const ALL_STEP_IDS = SELECTABLE_STEPS.map((s) => s.id);

function normalizeSteps(raw) {
  if (!Array.isArray(raw) || raw.length === 0) return new Set(ALL_STEP_IDS);
  const set = new Set(raw.map(String).filter((id) => ALL_STEP_IDS.includes(id)));
  return set;
}

/**
 * @param {object} job
 * @param {(msg: string) => void} onLog
 * @param {(payload: { id: string, status: 'start'|'done' }) => void} onStep
 * @param {{ shouldCancel?: () => boolean, setBrowser?: (b: import('puppeteer').Browser) => void, jobId?: string, liveUserId?: string, reuseBrowser?: import('puppeteer').Browser, onScreencast?: (payload: object) => void }} [hooks]
 */
export async function runJob(job, onLog = () => {}, onStep = () => {}, hooks = {}) {
  const log = (msg) => {
    const line = `[${new Date().toLocaleTimeString('vi-VN')}] ${msg}`;
    onLog(line);
  };

  const throwIfCancelled = () => {
    if (hooks.shouldCancel?.()) throw new Error('Job đã bị hủy.');
  };

  const mark = (id, status) => {
    try {
      onStep({ id, status });
    } catch {
      /* ignore */
    }
  };

  ensureDirs();

  const {
    wpmProjectUrl: rawProjectUrl,
    taskUrl,
    websiteUrl,
    customer,
    packageTier = 'F',
    options = {},
    docLink,
    steps: rawSteps,
    webTargetMode: rawWebTargetMode,
  } = job;

  const wpmProjectUrl = normalizeWpmProjectUrl(rawProjectUrl);
  const webTargetMode = rawWebTargetMode === 'website' ? 'website' : 'main';
  const targetOpts = { webTargetMode, preferUrl: websiteUrl };

  const enabled = normalizeSteps(rawSteps);
  if (enabled.size === 0) {
    throw new Error('Chưa chọn bước nào. Tick ít nhất 1 bước rồi Run.');
  }

  if (!wpmProjectUrl || !websiteUrl) {
    throw new Error('Thiếu wpmProjectUrl hoặc websiteUrl.');
  }
  if (rawProjectUrl && wpmProjectUrl !== String(rawProjectUrl).trim()) {
    log(`Project URL → ${wpmProjectUrl}`);
  }
  if (!customer?.username || !customer?.password || !customer?.email) {
    throw new Error('Thiếu customer.username / password / email.');
  }

  const wpmCreds = job.wpmCredentials || {};
  const wpmUser = wpmCreds.username || process.env.WPM_USERNAME;
  const wpmPass = wpmCreds.password || process.env.WPM_PASSWORD;
  if (!wpmUser || !wpmPass || String(wpmUser).includes('your_wpm')) {
    throw new Error('Chưa cấu hình tài khoản WPM. Đăng nhập tool → lưu WPM Username/Password.');
  }

  log(`Bước đã chọn: ${[...enabled].join(', ')}`);
  if (webTargetMode === 'website') {
    log(`⚠ Target web = khớp Website URL (${websiteUrl}) — không ép Main Web.`);
  } else {
    log('Target web = Main Web (mặc định).');
  }
  throwIfCancelled();

  let browser;
  let wpmPage;
  if (hooks.reuseBrowser) {
    browser = hooks.reuseBrowser;
    hooks.setBrowser?.(browser);
    const pages = await browser.pages().catch(() => []);
    wpmPage =
      pages.find((p) => p && !p.isClosed?.()) ||
      (await browser.newPage());
    log('→ Resume: tái sử dụng Chrome Live đang mở.');
  } else {
    ({ browser, page: wpmPage } = await launchBrowser({
      downloadPath: DOWNLOADS_DIR,
    }));
    hooks.setBrowser?.(browser);
  }

  const liveId = hooks.jobId || 'run';
  const pushFrame = (payload) => {
    try {
      hooks.onScreencast?.(payload);
    } catch {
      /* ignore */
    }
  };
  if (
    process.env.CHROME_LIVE === 'true' &&
    process.env.CHROME_LIVE_MODE === 'screencast' &&
    hooks.onScreencast
  ) {
    await startLiveSession(liveId, browser, wpmPage, pushFrame).catch((e) =>
      log(`⚠ Live screencast: ${e?.message || e}`)
    );
    log('→ Live screencast bật — mở panel Live Chrome trên UI.');
  } else if (process.env.CHROME_LIVE === 'true') {
    log('→ Live noVNC: mở panel Live /chrome-live để xem + tương tác.');
  }

  let wpPage = null;
  /** Bước đang chạy — để chụp đúng tab khi lỗi */
  let currentStep = 'init';
  let projectLabel = '';
  let account = {
    username: customer.username,
    password: customer.password,
    email: customer.email,
  };

  try {
    throwIfCancelled();
    // Luôn login + Quick Login (mỗi lần Run mở browser mới)
    currentStep = 'wpm-login';
    log('▶ Login WPM...');
    await loginToWPM(wpmPage, { username: wpmUser, password: wpmPass }, log);
    throwIfCancelled();

    currentStep = 'wpm-quick-login';
    log('▶ Mở project + Quick Login...');
    const opened = await openProjectAndQuickLogin(browser, wpmPage, wpmProjectUrl, log, targetOpts);
    wpPage = opened.wpPage;
    if (
      process.env.CHROME_LIVE === 'true' &&
      process.env.CHROME_LIVE_MODE === 'screencast' &&
      hooks.onScreencast &&
      wpPage
    ) {
      await setLivePage(liveId, wpPage, pushFrame).catch(() => {});
    }
    const projectName = opened.projectName || '';
    projectLabel = opened.projectLabel || projectName;

    await dismissBlockingAlerts(wpPage, log);
    throwIfCancelled();

    if (enabled.has('backup')) {
      currentStep = 'wp-backup';
      mark('backup', 'start');
      log('▶ Backup: UpdraftPlus...');
      await installAndBackupUpdraftPlus(wpPage, { ...options, projectName }, log);
      await dismissBlockingAlerts(wpPage, log);
      mark('backup', 'done');
    } else {
      log('⏭ Bỏ qua Backup');
    }
    throwIfCancelled();

    let accountExistsOnWeb = false;

    if (enabled.has('createUser')) {
      currentStep = 'wp-create-user';
      mark('createUser', 'start');
      log('▶ Tạo tài khoản khách...');
      account = await createCustomerAccount(wpPage, customer, log);
      if (account.skipped && account.reason === 'email_exists') {
        accountExistsOnWeb = true;
        log('→ Email đã có TK trên web — bỏ tạo user + bỏ sync WPM.');
        mark('createUser', 'done');
        if (enabled.has('syncWpm')) {
          mark('syncWpm', 'done');
          log('⏭ Bỏ qua sync WPM (email đã tồn tại).');
        }
      } else {
        mark('createUser', 'done');
      }
    } else {
      log('⏭ Bỏ qua tạo user — dùng username/password trên form');
    }
    throwIfCancelled();

    if (enabled.has('syncWpm') && !accountExistsOnWeb) {
      currentStep = 'wpm-sync-account';
      mark('syncWpm', 'start');
      log('▶ Sync tài khoản lên WPM...');
      await syncAccountToWPM(wpmPage, wpmProjectUrl, account, log, targetOpts);
      mark('syncWpm', 'done');
    } else if (enabled.has('syncWpm') && accountExistsOnWeb) {
      /* đã log ở trên */
    } else if (!enabled.has('syncWpm')) {
      log('⏭ Bỏ qua sync WPM');
    }
    throwIfCancelled();

    if (enabled.has('macCore')) {
      currentStep = 'wp-mac-core';
      mark('macCore', 'start');
      log('▶ Mac Core → cài Mac Role...');
      await wpPage.bringToFront().catch(() => {});
      await dismissBlockingAlerts(wpPage, log);
      await installMacRoleViaMacCore(wpPage, log);
      mark('macCore', 'done');
    } else {
      log('⏭ Bỏ qua Mac Core');
    }
    throwIfCancelled();

    if (enabled.has('macRole')) {
      currentStep = 'wp-mac-role';
      mark('macRole', 'start');
      log('▶ Mac Role → Create from "F Package User"...');
      await wpPage.bringToFront().catch(() => {});
      await dismissBlockingAlerts(wpPage, log);
      await configureFPackageUser(wpPage, packageTier, log);
      mark('macRole', 'done');
    } else {
      log('⏭ Bỏ qua Mac Role');
    }

    if (enabled.has('webInfo')) {
      currentStep = 'wp-web-info';
      mark('webInfo', 'start');
      log('▶ Web Info (Jet Engine edit web-info)...');
      await pullWebInfoToDashboard(wpPage, log);
      mark('webInfo', 'done');
    } else {
      log('⏭ Bỏ qua Web Info');
    }

    const finalDoc =
      docLink ||
      'https://docs.google.com/document/d/1pMuhxjAfY4i6jOyk2CcAUYWBp8CdLbJ-7IpQaiYG0wo/edit?usp=sharing';

    const loginUrl = `${websiteUrl.replace(/\/$/, '')}/mac-login`;
    const existsPassNote =
      'Đã tồn tại TK trên web — không khởi tạo mới, không có password mới';

    const output = accountExistsOnWeb
      ? {
          project: projectLabel,
          loginUrl,
          guideFile: finalDoc,
          docLink: finalDoc,
          username: account.username || customer.username || '',
          password: existsPassNote,
          accountExists: true,
          notice: existsPassNote,
          taskUrl,
          finishedAt: new Date().toISOString(),
        }
      : {
          project: projectLabel,
          loginUrl,
          guideFile: finalDoc,
          docLink: finalDoc,
          username: account.username,
          password: account.password,
          accountExists: false,
          taskUrl,
          finishedAt: new Date().toISOString(),
        };

    if (accountExistsOnWeb) {
      log(`▶ Output: TK đã có trên web — username=${output.username || '—'}; ${existsPassNote}`);
    }

    const outPath = path.join(ROOT, 'output-latest.json');
    fs.writeFileSync(outPath, JSON.stringify(output, null, 2), 'utf-8');
    log('▶ Đã lưu output-latest.json');

    // Có Task URL → điền Output fields (kể cả khi TK đã tồn tại: vẫn có login + user)
    if (taskUrl && output.loginUrl && output.username) {
      currentStep = 'wpm-fill-task';
      mark('fillTask', 'start');
      await fillTaskOutputFields(wpmPage, taskUrl, output, log);
      mark('fillTask', 'done');
    } else if (!taskUrl) {
      log('⏭ Không có Task URL — bỏ qua điền Output fields.');
    } else {
      log('⏭ Bỏ qua điền Task Output fields (thiếu loginUrl / username).');
    }

    log('▶ Xong.');
    if (process.env.HEADLESS === 'true') {
      await stopLiveSession(liveId).catch(() => {});
      log('→ Headless: đóng Chrome.');
      unregisterLiveBrowser(hooks.liveUserId, browser);
      await browser.close().catch(() => {});
      hooks.setBrowser?.(null);
    } else if (process.env.CHROME_LIVE === 'true') {
      registerLiveBrowser(hooks.liveUserId, browser);
      log('→ Live Chrome: panel Live vẫn mở — click/gõ trên Live để tương tác.');
    } else {
      log('→ Chrome giữ mở — đóng tay khi xem xong.');
    }

    return output;
  } catch (err) {
    const onWpm = currentStep.startsWith('wpm-');
    const primary = onWpm ? wpmPage : wpPage || wpmPage;
    const secondary = onWpm ? wpPage : wpmPage;

    try {
      await primary?.bringToFront?.();
    } catch {
      /* ignore */
    }
    if (
      process.env.CHROME_LIVE === 'true' &&
      process.env.CHROME_LIVE_MODE === 'screencast' &&
      hooks.onScreencast &&
      primary
    ) {
      await setLivePage(liveId, primary, pushFrame).catch(() => {});
    }
    const shot1 = await screenshotError(
      primary,
      onWpm ? 'job-error-wpm' : 'job-error-wp'
    );
    if (shot1) log(`Screenshot lỗi (${onWpm ? 'WPM' : 'WordPress'}, bước ${currentStep}): ${shot1}`);

    if (secondary && secondary !== primary && !secondary.isClosed?.()) {
      const shot2 = await screenshotError(
        secondary,
        onWpm ? 'job-error-wp-ref' : 'job-error-wpm-ref'
      );
      if (shot2) log(`Screenshot tham chiếu (${onWpm ? 'WordPress' : 'WPM'}): ${shot2}`);
    }

    if (process.env.HEADLESS === 'true') {
      await stopLiveSession(liveId).catch(() => {});
      log('→ Headless: đóng Chrome sau lỗi.');
      unregisterLiveBrowser(hooks.liveUserId, browser);
      await browser.close().catch(() => {});
      hooks.setBrowser?.(null);
    } else if (process.env.CHROME_LIVE === 'true') {
      registerLiveBrowser(hooks.liveUserId, browser);
      log('→ Live Chrome: panel Live vẫn xem được trang lỗi — tương tác trên Live.');
    } else {
      log('→ Chrome giữ mở để xem lỗi — đóng tay khi xong.');
    }
    throw err;
  }
  // Local (HEADLESS≠true): không browser.close() — để xem / debug.
}
