import fs from 'fs';
import path from 'path';
import { launchBrowser, shouldRunHeaded } from './browser.js';
import {
  ensureDirs,
  screenshotError,
  DOWNLOADS_DIR,
  ROOT,
  dismissBlockingAlerts,
  normalizeWpmProjectUrl,
  sleepExact,
} from './utils.js';
import { loginToWPM, openProjectAndQuickLogin, syncAccountToWPM, syncAccountToWPMViaHttp } from './steps/wpm.js';
import { installAndBackupUpdraftPlus } from './steps/backup.js';
import { createCustomerAccount } from './steps/user.js';
import { isHttpStepsEnabled } from './http/wpSession.js';
import { installMacRoleViaMacCore, configureFPackageUser } from './steps/macRole.js';
import { pullWebInfoToDashboard } from './steps/webInfo.js';
import { fillTaskOutputFields } from './steps/task.js';
import {
  startLiveSession,
  stopLiveSession,
  setLivePage,
  isFrameLiveMode,
  getLiveMode,
  scheduleSnapshotOnLog,
} from './liveSession.js';
import { registerLiveBrowser, unregisterLiveBrowser } from './liveBrowser.js';
import { isLiveVncActive } from './liveVnc.js';

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
 * @param {{ shouldCancel?: () => boolean, setBrowser?: (b: import('puppeteer').Browser) => void, jobId?: string, liveUserId?: string, reuseBrowser?: import('puppeteer').Browser, forceHeaded?: boolean, onScreencast?: (payload: object) => void, onScreenshots?: (shots: object[]) => void }} [hooks]
 */
export async function runJob(job, onLog = () => {}, onStep = () => {}, hooks = {}) {
  const liveIdEarly = hooks.jobId || 'run';
  const log = (msg) => {
    const line = `[${new Date().toLocaleTimeString('vi-VN', {
      timeZone: 'Asia/Ho_Chi_Minh',
      hour12: false,
    })}] ${msg}`;
    onLog(line);
    // Snapshot: mỗi log → hiện ảnh log trước + chụp mới
    if (getLiveMode() === 'snapshot') {
      scheduleSnapshotOnLog(liveIdEarly);
    }
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
  const forceHeaded = Boolean(hooks.forceHeaded || job.resume);
  if (hooks.reuseBrowser) {
    browser = hooks.reuseBrowser;
    hooks.setBrowser?.(browser);
    const pages = await browser.pages().catch(() => []);
    const openPages = pages.filter((p) => p && !p.isClosed?.());
    // Ưu tiên tab WPM (Resume thường còn Dashboard/project), không lấy nhầm tab WP
    wpmPage =
      openPages.find((p) => {
        try {
          return /wpm\.macusaone\.com/i.test(p.url() || '');
        } catch {
          return false;
        }
      }) ||
      openPages[0] ||
      (await browser.newPage());
    log('→ Resume: tái sử dụng Chrome đang mở.');
  } else {
    // (S6) Mỗi user chạy Chrome trên display riêng — cô lập Live VNC
    const { getUserDisplay } = await import('./liveDisplayManager.js');
    const userDisplay = hooks.liveUserId ? getUserDisplay(hooks.liveUserId) : undefined;
    ({ browser, page: wpmPage } = await launchBrowser({
      downloadPath: DOWNLOADS_DIR,
      forceHeaded,
      display: userDisplay,
    }));
    hooks.setBrowser?.(browser);
    if (process.env.CHROME_LIVE === 'true') {
      if (forceHeaded || shouldRunHeaded({ force: forceHeaded })) {
        log('→ Chrome headed trên Live (Xvfb) — xem được trên panel Live.');
      } else {
        log('→ Chạy headless (Live tắt) — nhanh hơn. Muốn xem: Mở Live rồi Resume/Run.');
      }
    }
  }

  const liveId = hooks.jobId || 'run';
  const pushFrame = (payload) => {
    try {
      hooks.onScreencast?.(payload);
    } catch {
      /* ignore */
    }
  };
  if (process.env.CHROME_LIVE === 'true' && isFrameLiveMode() && hooks.onScreencast) {
    await startLiveSession(liveId, browser, wpmPage, pushFrame).catch((e) =>
      log(`⚠ Live ${getLiveMode()}: ${e?.message || e}`)
    );
    log(
      getLiveMode() === 'snapshot'
        ? '→ Live snapshot theo Log (màn hình = ảnh của dòng log trước).'
        : '→ Live screencast — Mở Live trên UI để xem.'
    );
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
    if (process.env.CHROME_LIVE === 'true' && isFrameLiveMode() && hooks.onScreencast && wpPage) {
      await setLivePage(liveId, wpPage, pushFrame).catch(() => {});
    }
    const projectName = opened.projectName || '';
    projectLabel = opened.projectLabel || projectName;

    await dismissBlockingAlerts(wpPage, log);
    throwIfCancelled();

    // Phase 1: cài helper plugin để các bước WP dùng REST thuần
    let helperInstalled = false;
    if (isHttpStepsEnabled()) {
      try {
        const { installHelper, getRestAuth, checkHelper } = await import('./http/helperClient.js');
        const { originOf } = await import('./utils.js');
        const siteUrl = originOf(wpPage.url());
        log('▶ Cài MAC Tools Helper plugin...');
        const inst = await installHelper(wpPage, siteUrl);
        // Verify REST hoạt động thật
        const auth = await getRestAuth(wpPage, siteUrl);
        const chk = await checkHelper(siteUrl, auth);
        if (!chk.ok) {
          throw new Error(`REST không hoạt động: ${chk.error}`);
        }
        helperInstalled = true;
        log('✓ Helper đã cài + REST OK — các bước WP sẽ dùng REST.');
      } catch (err) {
        log(`⚠ Không cài được helper (${(err?.message || '').slice(0, 150)}) — dùng HTTP/DOM như cũ.`);
      }
    }

    if (enabled.has('backup')) {
      currentStep = 'wp-backup';
      mark('backup', 'start');
      log('▶ Backup: UpdraftPlus...');
      await installAndBackupUpdraftPlus(
        wpPage,
        { ...options, projectName, shouldCancel: () => hooks.shouldCancel?.() },
        log
      );
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
      log(
        isHttpStepsEnabled()
          ? '▶ Tạo tài khoản khách (HTTP ưu tiên, fallback Chrome)...'
          : '▶ Tạo tài khoản khách (Chrome)...'
      );
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
      // WPM không có API public, webs không dùng form fields — phải dùng browser
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
      log(
        isHttpStepsEnabled()
          ? '▶ Mac Core → cài Mac Role (HTTP ưu tiên, fallback Chrome)...'
          : '▶ Mac Core → cài Mac Role...'
      );
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
      log(
        isHttpStepsEnabled()
          ? '▶ Mac Role → Create F (HTTP ưu tiên, fallback Chrome)...'
          : '▶ Mac Role → Create from "F Package User"...'
      );
      await wpPage.bringToFront().catch(() => {});
      await dismissBlockingAlerts(wpPage, log);
      await configureFPackageUser(wpPage, packageTier, log);
      mark('macRole', 'done');
      // Buffer thêm trước Web Info — tránh ERR_ABORTED khi dashboard còn redirect
      await sleepExact(1500);
      await dismissBlockingAlerts(wpPage, log);
    } else {
      log('⏭ Bỏ qua Mac Role');
    }

    if (enabled.has('webInfo')) {
      currentStep = 'wp-web-info';
      mark('webInfo', 'start');
      log(
        isHttpStepsEnabled()
          ? '▶ Web Info (HTTP/DOM ưu tiên, fallback Chrome)...'
          : '▶ Web Info (Jet Engine edit web-info)...'
      );
      await pullWebInfoToDashboard(wpPage, log);
      mark('webInfo', 'done');
    } else {
      log('⏭ Bỏ qua Web Info');
    }

    const finalDoc =
      docLink ||
      'https://note.macmarketing.us/quan-ly-website-goi-f';

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

    // Phase 1: xóa helper plugin cuối job (dùng browser vì plugin không tự xóa qua REST được)
    if (helperInstalled) {
      try {
        const { removeHelper } = await import('./http/helperClient.js');
        const { originOf } = await import('./utils.js');
        const siteUrl = originOf(wpPage.url());
        log('▶ Xóa MAC Tools Helper plugin...');
        const res = await removeHelper(wpPage, siteUrl);
        log(res.removed ? '✓ Helper đã xóa.' : `⚠ Không xóa được helper: ${res.error || ''}`);
      } catch (err) {
        log(`⚠ Lỗi xóa helper: ${(err?.message || '').slice(0, 120)}`);
      }
    }

    if (process.env.HEADLESS === 'true') {
      await stopLiveSession(liveId).catch(() => {});
      log('→ Headless: đóng Chrome.');
      unregisterLiveBrowser(hooks.liveUserId, browser);
      await browser.close().catch(() => {});
      hooks.setBrowser?.(null);
    } else if (process.env.CHROME_LIVE === 'true') {
      // Resume/Live: giữ Chrome nếu đang headed (kể cả vừa force headed)
      const keepForLive =
        forceHeaded || shouldRunHeaded({ force: forceHeaded }) || isLiveVncActive();
      if (keepForLive) {
        registerLiveBrowser(hooks.liveUserId, browser);
        log('→ Live Chrome: giữ mở — xem / click trên panel Live.');
      } else {
        await stopLiveSession(liveId).catch(() => {});
        log('→ Đóng Chrome (chạy headless / Live tắt).');
        unregisterLiveBrowser(hooks.liveUserId, browser);
        await browser.close().catch(() => {});
        hooks.setBrowser?.(null);
      }
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
    if (process.env.CHROME_LIVE === 'true' && isFrameLiveMode() && hooks.onScreencast && primary) {
      await setLivePage(liveId, primary, pushFrame).catch(() => {});
    }
    const shot1 = await screenshotError(
      primary,
      onWpm ? 'job-error-wpm' : 'job-error-wp'
    );
    const shots = [];
    if (shot1?.url) {
      shots.push({ label: onWpm ? 'WPM' : 'WordPress', ...shot1 });
      log(`📸 Xem ảnh lỗi (${onWpm ? 'WPM' : 'WordPress'}, bước ${currentStep}): ${shot1.url}`);
    }

    if (secondary && secondary !== primary && !secondary.isClosed?.()) {
      const shot2 = await screenshotError(
        secondary,
        onWpm ? 'job-error-wp-ref' : 'job-error-wpm-ref'
      );
      if (shot2?.url) {
        shots.push({ label: onWpm ? 'WordPress' : 'WPM', ...shot2 });
        log(`📸 Xem ảnh tham chiếu (${onWpm ? 'WordPress' : 'WPM'}): ${shot2.url}`);
      }
    }
    if (shots.length) hooks.onScreenshots?.(shots);

    if (process.env.HEADLESS === 'true') {
      await stopLiveSession(liveId).catch(() => {});
      log('→ Headless: đóng Chrome sau lỗi.');
      unregisterLiveBrowser(hooks.liveUserId, browser);
      await browser.close().catch(() => {});
      hooks.setBrowser?.(null);
    } else if (process.env.CHROME_LIVE === 'true') {
      // Giữ Chrome sau lỗi khi Resume/Live — để xem ảnh + Resume tiếp
      if (forceHeaded || shouldRunHeaded({ force: forceHeaded }) || isLiveVncActive()) {
        registerLiveBrowser(hooks.liveUserId, browser);
        log('→ Live Chrome: giữ trang lỗi — xem trên Live rồi Resume.');
      } else {
        await stopLiveSession(liveId).catch(() => {});
        log('→ Đóng Chrome sau lỗi (headless / Live tắt). Screenshot đã lưu nếu có.');
        unregisterLiveBrowser(hooks.liveUserId, browser);
        await browser.close().catch(() => {});
        hooks.setBrowser?.(null);
      }
    } else {
      log('→ Chrome giữ mở để xem lỗi — đóng tay khi xong.');
    }
    throw err;
  }
  // Local (HEADLESS≠true): không browser.close() — để xem / debug.
}
