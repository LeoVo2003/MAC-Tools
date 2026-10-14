import dotenv from 'dotenv';
import express from 'express';
import path from 'path';
import fs from 'fs';
import { exec } from 'child_process';
import { fileURLToPath } from 'url';
import { runJob } from './src/runJob.js';
import { getAppRoot, getEnvPath, getPublicDir } from './src/envStore.js';
import {
  normalizeWpmProjectUrl,
  sanitizeWpUsername,
  sanitizeCustomerPassword,
  DOWNLOADS_DIR,
} from './src/utils.js';
import {
  startRun,
  finishRun,
  listRuns,
  runsStats,
  runsToCsv,
  clearRuns,
  deleteRunsByIds,
  deleteRunsByStatuses,
} from './src/tracking.js';
import {
  ensureKnownUsers,
  loginWithWpm,
  toPublicUser,
  getUserWpmCredentials,
  listUsersPublic,
  resetUserPassword,
} from './src/userStore.js';
import { sessionMiddleware, requireAuth, requireAdmin, currentPublicUser } from './src/auth.js';
import { createJobQueue } from './src/jobQueue.js';
import { fillCustomerDataFromUrls } from './src/steps/fillData.js';
import { purgeOldBackups, buildHealthReport, detectStaleJobs } from './src/ops.js';
import { mountChromeLiveRoutes, attachChromeLiveWs, chromeLiveEnabled } from './src/chromeLive.js';
import { dispatchLiveInput, listLiveSessions, getLiveSession, isFrameLiveMode } from './src/liveSession.js';
import { clearLiveBrowsersForUser, takeLiveBrowser } from './src/liveBrowser.js';
import { attachRealtime } from './src/realtime.js';

dotenv.config({ path: getEnvPath() });

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3847;
const VERSION = '2.1.1';

/** Một instance session — Express + Socket.IO chung MemoryStore */
const sharedSession = sessionMiddleware();

/** Gán sau khi attachRealtime(server) */
let broadcast = (event, data, opts) => {
  /* no-op until socket ready */
};

function openBrowser(url) {
  let cmd;
  if (process.platform === 'win32') cmd = `start "" "${url}"`;
  else if (process.platform === 'darwin') cmd = `open "${url}"`;
  else cmd = `xdg-open "${url}"`;
  exec(cmd, () => {});
}

const queue = createJobQueue({
  onLog: (jobId, line) => {
    console.log(line);
    const job = queue.getJob(jobId);
    broadcast('log', { line, jobId }, { jobId, userId: job?.meta?.userId });
  },
  onChange: () => broadcast('queue', null, { refreshQueues: true }),
  maxConcurrent: process.env.MAX_CONCURRENT_JOBS,
});

export function createApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '1mb' }));
  app.use(sharedSession);

  app.get('/api/health', (_req, res) => {
    const snap = queue.snapshot();
    const report = buildHealthReport({
      queueSnapshot: snap,
      staleMinutes: Number(process.env.JOB_STALE_MINUTES) || 45,
      diskWarnMb: Number(process.env.DISK_WARN_MB) || 8000,
    });
    const staleJobs = detectStaleJobs(
      queue.listActiveJobs(),
      Number(process.env.JOB_STALE_MINUTES) || 45
    );
    for (const s of staleJobs) {
      report.alerts.push({
        level: 'warn',
        code: 'job_stale',
        message: `Job ${s.id.slice(0, 8)}… (${s.user || '?'}) chạy ~${s.ageMinutes} phút.`,
        jobId: s.id,
      });
    }
    report.staleJobs = staleJobs;
    const ok = report.chrome.ok && !report.alerts.some((a) => a.level === 'error');
    res.status(ok ? 200 : 503).json({ ok, version: VERSION, ...report });
  });

  app.get('/api/queue', requireAuth, (req, res) => {
    res.json(
      queue.snapshotForUser(req.user.id, { admin: req.user.role === 'admin' })
    );
  });

  app.post('/api/queue/:jobId/cancel', requireAuth, (req, res) => {
    const jobId = String(req.params.jobId || '');
    const job = queue.getJob(jobId);
    if (!job) return res.status(404).json({ error: 'Không tìm thấy job.' });
    const isOwner = job.meta?.userId === req.user.id;
    const isAdmin = req.user.role === 'admin';
    if (!isOwner && !isAdmin) {
      return res.status(403).json({ error: 'Chỉ hủy job của bạn (hoặc admin).' });
    }
    const ownerId = job.meta?.userId || req.user.id;
    const result = queue.cancel(jobId, { byUser: req.user.username });
    if (!result.ok) return res.status(404).json(result);

    // Báo UI ngay — không chờ browser đóng xong
    const msg = job.error || `Hủy bởi ${req.user.username}`;
    broadcast('job-error', { message: msg, jobId, cancelled: true }, { jobId, userId: ownerId });
    broadcast('done', { running: false, jobId, cancelled: true }, { jobId, userId: ownerId });
    broadcast('queue', null, { refreshQueues: true });
    res.json(result);
  });

  app.get('/api/me', (req, res) => {
    res.json({ user: currentPublicUser(req) });
  });

  /**
   * Login = tài khoản WPM (email + password).
   * Lần đầu tự tạo user trong data/users.json; leo.vo@macusaone.com → admin.
   */
  app.post('/api/login', async (req, res) => {
    const username = String(req.body?.username || '').trim();
    const password = String(req.body?.password || '');
    if (!username) {
      return res.status(400).json({ error: 'Thiếu email WPM.' });
    }
    if (!password) {
      return res.status(400).json({ error: 'Nhập password WPM — lần đầu tool sẽ lưu lại cho Run.' });
    }
    try {
      const user = await loginWithWpm(username, password);
      if (!user) {
        return res.status(401).json({
          error: 'Sai password. Đúng email đã từng login thì nhập đúng password đã lưu (hoặc liên hệ admin reset).',
        });
      }
      req.session.userId = user.id;
      req.session.username = user.username;
      res.json({ ok: true, user: toPublicUser(user) });
    } catch (err) {
      res.status(500).json({ error: err?.message || String(err) });
    }
  });

  app.get('/api/users', requireAuth, requireAdmin, (_req, res) => {
    res.json({ users: listUsersPublic() });
  });

  /** Gỡ password đã lưu — user login lại bằng pass WPM đúng thì tool lưu lại. */
  app.post('/api/users/:id/reset-password', requireAuth, requireAdmin, (req, res) => {
    try {
      const user = resetUserPassword(String(req.params.id || ''));
      res.json({ ok: true, user: toPublicUser(user) });
    } catch (err) {
      res.status(404).json({ error: err?.message || String(err) });
    }
  });

  app.post('/api/logout', (req, res) => {
    req.session.destroy(() => {
      res.json({ ok: true });
    });
  });

  /** Review Link: proxy sang Cloudflare Worker (tránh CORS browser). */
  app.get('/api/review-link', requireAuth, async (req, res) => {
    const url = String(req.query.url || '').trim();
    if (!url) return res.status(400).json({ ok: false, error: 'Thiếu URL.' });
    const workerBase = (process.env.REVIEW_LINK_WORKER || 'https://review-link.leo-vo.workers.dev').replace(/\/$/, '');
    try {
      const r = await fetch(`${workerBase}/api/convert?url=${encodeURIComponent(url)}`);
      const data = await r.json();
      res.status(r.ok ? 200 : 400).json(data);
    } catch (err) {
      res.status(502).json({ ok: false, error: 'Không gọi được review-link worker: ' + (err?.message || err) });
    }
  });

  /** Fill data ngầm: Project (+ Task) → website/username/password/email. */
  app.post('/api/fill-data', requireAuth, async (req, res) => {
    const body = req.body || {};
    const wpmProjectUrl = normalizeWpmProjectUrl(String(body.wpmProjectUrl || '').trim());
    const taskUrl = String(body.taskUrl || '').trim();
    const websiteUrl = String(body.websiteUrl || '').trim();
    // Non-admin luôn ép Main Web
    let webTargetMode = body.webTargetMode === 'website' ? 'website' : 'main';
    if (req.user.role !== 'admin') webTargetMode = 'main';

    if (!wpmProjectUrl) {
      return res.status(400).json({ error: 'Thiếu WPM Project URL.' });
    }
    if (webTargetMode === 'website' && !websiteUrl) {
      return res.status(400).json({
        error: 'Mode Website cần điền ô Website URL (subdomain test) trước khi Fill.',
      });
    }
    const stored = getUserWpmCredentials(req.user.id);
    if (!stored.configured) {
      return res.status(400).json({
        error: 'Chưa có WPM trên tài khoản. Đăng xuất rồi login lại bằng email/password WPM.',
      });
    }

    const logs = [];
    const fillSessionId = `fill-${req.user.id}`;
    try {
      // Fill mới: clear Chrome Live cũ (tránh lag / timeout trên Xvfb)
      const clearedReg = await clearLiveBrowsersForUser(req.user.id);
      const clearedQueue = await queue.closeBrowsersForUser(req.user.id);
      const cleared = (clearedReg.closed || 0) + (clearedQueue || 0);
      if (cleared > 0) {
        const line = `[live] Đã clear ${cleared} Chrome cũ trước Fill.`;
        logs.push(line);
        console.log(line);
        broadcast('log', { line, jobId: fillSessionId }, { userId: req.user.id });
      }

      const data = await fillCustomerDataFromUrls(
        {
          wpmProjectUrl,
          taskUrl,
          websiteUrl,
          webTargetMode,
          wpmCredentials: { username: stored.username, password: stored.password },
          liveUserId: req.user.id,
          liveSessionId:
            process.env.CHROME_LIVE === 'true' && isFrameLiveMode()
              ? fillSessionId
              : undefined,
          onScreencast:
            process.env.CHROME_LIVE === 'true' && isFrameLiveMode()
              ? (payload) =>
                  broadcast('screencast', { ...payload, jobId: fillSessionId }, { userId: req.user.id })
              : undefined,
        },
        (line) => {
          logs.push(line);
          console.log(line);
          broadcast('log', { line, jobId: fillSessionId }, { userId: req.user.id });
        }
      );
      res.json({ ...data, logs });
    } catch (err) {
      res.status(500).json({
        error: err?.message || String(err),
        logs,
      });
    }
  });

  app.post('/api/chrome-live/input', requireAuth, async (req, res) => {
    if (process.env.CHROME_LIVE !== 'true') {
      return res.status(404).json({ error: 'Chrome Live tắt.' });
    }
    const sessionId = String(req.body?.sessionId || req.body?.jobId || '').trim();
    if (!sessionId) return res.status(400).json({ error: 'Thiếu sessionId.' });
    try {
      await dispatchLiveInput(sessionId, req.body || {});
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: err?.message || String(err) });
    }
  });

  app.get('/api/chrome-live/sessions', requireAuth, (_req, res) => {
    res.json({
      sessions: listLiveSessions().map((id) => ({
        id,
        hasPage: Boolean(getLiveSession(id)?.page),
      })),
    });
  });

  app.get('/api/status', requireAuth, (req, res) => {
    const jobId = String(req.query.jobId || '');
    const job = jobId ? queue.getJob(jobId) : null;
    if (job && String(job.meta?.userId || '') !== String(req.user.id) && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Không xem được job của người khác.' });
    }
    res.json({
      queue: queue.snapshotForUser(req.user.id, { admin: req.user.role === 'admin' }),
      job: job
        ? {
            id: job.id,
            status: job.status,
            logs: job.logs?.slice(-80) || [],
            result: job.result,
            error: job.error,
          }
        : null,
    });
  });

  app.post('/api/run', requireAuth, (req, res) => {
    const body = req.body || {};
    let webTargetMode = body.webTargetMode === 'website' ? 'website' : 'main';
    if (req.user.role !== 'admin') webTargetMode = 'main';

    const jobPayload = {
      wpmProjectUrl: normalizeWpmProjectUrl(String(body.wpmProjectUrl || '').trim()),
      taskUrl: String(body.taskUrl || '').trim(),
      websiteUrl: String(body.websiteUrl || '').trim(),
      webTargetMode,
      customer: {
        username: sanitizeWpUsername(String(body.username || '').trim()),
        password: sanitizeCustomerPassword(String(body.password || '')),
        email: String(body.email || '').trim(),
      },
      packageTier: body.packageTier || 'F',
      options: {},
      docLink: String(body.docLink || '').trim() || undefined,
      steps: Array.isArray(body.steps) ? body.steps.map(String) : undefined,
    };

    if (!jobPayload.wpmProjectUrl || !jobPayload.websiteUrl) {
      return res.status(400).json({ error: 'Thiếu wpmProjectUrl hoặc websiteUrl.' });
    }
    if (
      !jobPayload.customer.username ||
      !jobPayload.customer.password ||
      !jobPayload.customer.email
    ) {
      return res.status(400).json({ error: 'Thiếu username / password / email khách.' });
    }

    const stored = getUserWpmCredentials(req.user.id);
    if (!stored.configured) {
      return res.status(400).json({
        error: 'Chưa có WPM trên tài khoản. Đăng xuất rồi login lại bằng email/password WPM.',
      });
    }
    jobPayload.wpmCredentials = {
      username: stored.username,
      password: stored.password,
    };

    const userMeta = {
      userId: req.user.id,
      username: req.user.username,
    };

    const isResume = Boolean(body.resume);
    const wantLive = Boolean(body.wantLive) || isResume;
    const ownerId = req.user.id;

    const { jobId, position } = queue.enqueue({
      meta: userMeta,
      run: async (pushLog, jobRef) => {
        const thisJobId = jobRef.id;

        // Run mới: clear Chrome Live cũ. Resume: tái sử dụng Chrome đang mở.
        let reuseBrowser = null;
        if (isResume) {
          reuseBrowser = takeLiveBrowser(ownerId) || queue.takeBrowserForUser?.(ownerId);
          if (reuseBrowser) {
            pushLog('[live] Resume — tái sử dụng Chrome đang mở (không clear).');
          } else {
            pushLog('[live] Resume — không còn Chrome cũ, mở Chrome headed mới (để xem Live).');
          }
        } else {
          const clearedReg = await clearLiveBrowsersForUser(ownerId);
          const clearedQueue = await queue.closeBrowsersForUser(ownerId);
          const cleared = (clearedReg.closed || 0) + (clearedQueue || 0);
          if (cleared > 0) {
            pushLog(`[live] Đã clear ${cleared} Chrome cũ trước Run.`);
          }
        }

        const runId = startRun({
          userId: ownerId,
          toolUser: req.user.username,
          wpmUser: stored.username,
          wpmProjectUrl: jobPayload.wpmProjectUrl,
          taskUrl: jobPayload.taskUrl || '',
          websiteUrl: jobPayload.websiteUrl,
          webTargetMode: jobPayload.webTargetMode,
          username: jobPayload.customer.username,
          steps: jobPayload.steps || [],
          jobId: thisJobId,
          edition: 'v2',
          resume: isResume,
        });

        const onStep = (payload) =>
          broadcast('step', { ...payload, jobId: thisJobId }, { jobId: thisJobId, userId: ownerId });

        try {
          pushLog('=== Bắt đầu job MAC Tools ===');
          const result = await runJob(jobPayload, pushLog, onStep, {
            shouldCancel: () => Boolean(jobRef.cancelled),
            jobId: thisJobId,
            liveUserId: ownerId,
            reuseBrowser: reuseBrowser || undefined,
            forceHeaded: wantLive && !isFrameLiveMode(),
            setBrowser: (b) => {
              jobRef.browser = b;
            },
            onScreenshots: (shots) => {
              jobRef.screenshots = shots;
            },
            onScreencast:
              isFrameLiveMode()
                ? (payload) => {
                    broadcast('screencast', { ...payload, jobId: thisJobId }, {
                      jobId: thisJobId,
                      userId: ownerId,
                    });
                  }
                : undefined,
          });
          if (jobRef.cancelled) throw new Error('Job đã bị hủy.');
          finishRun(runId, { status: 'success', result });
          broadcast('result', { ...result, jobId: thisJobId }, { jobId: thisJobId, userId: ownerId });
          pushLog('=== Hoàn tất ===');
          broadcast('done', { running: false, jobId: thisJobId }, { jobId: thisJobId, userId: ownerId });
          broadcast('queue', null, { refreshQueues: true });
          return result;
        } catch (err) {
          const message = err?.message || String(err);
          const cancelled = Boolean(jobRef.cancelled) || /đã bị hủy/i.test(message);
          const screenshots = Array.isArray(jobRef.screenshots) ? jobRef.screenshots : [];
          finishRun(runId, { status: cancelled ? 'cancelled' : 'error', error: message });
          broadcast(
            'job-error',
            { message, jobId: thisJobId, cancelled, screenshots },
            { jobId: thisJobId, userId: ownerId }
          );
          broadcast('done', { running: false, jobId: thisJobId }, { jobId: thisJobId, userId: ownerId });
          broadcast('queue', null, { refreshQueues: true });
          throw err;
        }
      },
      onDone: () => {
        broadcast('queue', null, { refreshQueues: true });
      },
    });

    const userSnap = queue.snapshotForUser(req.user.id, { admin: req.user.role === 'admin' });
    const maxJobs = userSnap.maxConcurrent;
    broadcast('queue', null, { refreshQueues: true });
    res.json({
      ok: true,
      jobId,
      position,
      message:
        maxJobs > 0 && position > maxJobs
          ? `Đã xếp hàng (vị trí ${position}). Tối đa ${maxJobs} job chạy cùng lúc.`
          : 'Job đã bắt đầu (hoặc sắp chạy).',
      queue: userSnap,
    });
  });

  app.get('/api/output', requireAuth, (_req, res) => {
    const file = path.join(getAppRoot(), 'output-latest.json');
    if (!fs.existsSync(file)) return res.status(404).json({ error: 'Chưa có output.' });
    res.sendFile(file);
  });

  /** Ảnh screenshot lỗi job — bấm link trong Log để xem */
  app.get('/api/errors/:name', requireAuth, (req, res) => {
    const name = path.basename(String(req.params.name || ''));
    if (!/^[a-zA-Z0-9._-]+\.png$/i.test(name)) {
      return res.status(400).json({ error: 'Tên file không hợp lệ.' });
    }
    const file = path.join(getAppRoot(), 'errors', name);
    if (!fs.existsSync(file)) return res.status(404).json({ error: 'Không tìm thấy ảnh.' });
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.type('png');
    res.sendFile(file);
  });

  app.get('/api/errors', requireAuth, (_req, res) => {
    const dir = path.join(getAppRoot(), 'errors');
    if (!fs.existsSync(dir)) return res.json({ files: [] });
    const files = fs
      .readdirSync(dir)
      .filter((f) => /\.png$/i.test(f))
      .map((f) => {
        const st = fs.statSync(path.join(dir, f));
        return {
          name: f,
          url: `/api/errors/${encodeURIComponent(f)}`,
          mtime: st.mtimeMs,
          size: st.size,
        };
      })
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, 40);
    res.json({ files });
  });

  app.get('/api/runs', requireAuth, requireAdmin, (req, res) => {
    const limit = Math.min(500, Number(req.query.limit) || 100);
    const user = String(req.query.user || '').trim();
    const from = String(req.query.from || '').trim();
    const to = String(req.query.to || '').trim();
    const status = String(req.query.status || '').trim();
    const runs = listRuns({ limit, user, from, to, status });
    res.json({ stats: runsStats(runs), runs, filters: { user, from, to, status, limit } });
  });

  app.get('/api/runs.csv', requireAuth, requireAdmin, (req, res) => {
    const limit = Math.min(2000, Number(req.query.limit) || 500);
    const user = String(req.query.user || '').trim();
    const from = String(req.query.from || '').trim();
    const to = String(req.query.to || '').trim();
    const status = String(req.query.status || '').trim();
    const runs = listRuns({ limit, user, from, to, status });
    const csv = runsToCsv(runs);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="runs.csv"');
    res.send(csv);
  });

  app.delete('/api/runs', requireAuth, requireAdmin, (_req, res) => {
    try {
      const result = clearRuns();
      res.json({ ok: true, ...result });
    } catch (err) {
      res.status(500).json({ error: err?.message || String(err) });
    }
  });

  /** Xóa từng bản ghi: { ids: string[] } hoặc dọn status: { statuses: ['error','cancelled'] } */
  app.post('/api/runs/delete', requireAuth, requireAdmin, (req, res) => {
    try {
      const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
      const statuses = Array.isArray(req.body?.statuses) ? req.body.statuses : [];
      if (ids.length) {
        return res.json({ ok: true, ...deleteRunsByIds(ids) });
      }
      if (statuses.length) {
        return res.json({ ok: true, ...deleteRunsByStatuses(statuses) });
      }
      return res.status(400).json({ error: 'Thiếu ids hoặc statuses.' });
    } catch (err) {
      res.status(500).json({ error: err?.message || String(err) });
    }
  });

  app.post('/api/backups/purge', requireAuth, requireAdmin, (req, res) => {
    const days = Number(req.body?.days) || Number(process.env.BACKUP_RETENTION_DAYS) || 7;
    const result = purgeOldBackups(days);
    res.json({ ok: true, ...result });
  });

  mountChromeLiveRoutes(app);

  app.use(express.static(getPublicDir()));

  return app;
}

export async function startServer({ openBrowser: shouldOpen } = {}) {
  await ensureKnownUsers();

  const retentionDays = Number(process.env.BACKUP_RETENTION_DAYS) || 7;
  try {
    const purged = purgeOldBackups(retentionDays);
    if (purged.deleted.length) {
      console.log(`[retention] Đã xóa ${purged.deleted.length} folder backup > ${retentionDays} ngày.`);
    }
  } catch (err) {
    console.warn('[retention]', err?.message || err);
  }
  // Chạy lại mỗi 24h
  setInterval(() => {
    try {
      const purged = purgeOldBackups(retentionDays);
      if (purged.deleted.length) {
        console.log(`[retention] Đã xóa ${purged.deleted.length} folder backup cũ.`);
      }
    } catch (err) {
      console.warn('[retention]', err?.message || err);
    }
  }, 24 * 60 * 60 * 1000).unref?.();

  const app = createApp();

  const openFlag = process.env.OPEN_BROWSER;
  const autoOpen =
    shouldOpen !== undefined
      ? shouldOpen
      : openFlag === 'false'
        ? false
        : openFlag === 'true'
          ? true
          : process.env.NODE_ENV !== 'production';

  const server = app.listen(PORT, () => {
    const url = `http://localhost:${PORT}`;
    console.log(`MAC Tools UI: ${url}`);
    console.log(`Thư mục app: ${getAppRoot()}`);
    console.log(`Download dir: ${DOWNLOADS_DIR}`);
    console.log(`Health: ${url}/api/health`);
    if (chromeLiveEnabled()) console.log(`Live Chrome: ${url}/chrome-live/`);
    if (autoOpen) setTimeout(() => openBrowser(url), 400);
  });

  const rt = attachRealtime(server, { sessionMiddleware: sharedSession, queue });
  broadcast = rt.broadcast;

  attachChromeLiveWs(server);

  server.on('error', (err) => {
    if (err?.code === 'EADDRINUSE') {
      console.error(`\n[ERROR] Port ${PORT} đang bị chiếm.`);
      console.error(`Mở: http://localhost:${PORT}\n`);
    } else {
      console.error('[ERROR] Server:', err?.message || err);
    }
    process.exit(1);
  });
  return server;
}

function isMainModule() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    const self = path.normalize(fileURLToPath(import.meta.url)).toLowerCase();
    const arg = path.normalize(path.resolve(entry)).toLowerCase();
    return self === arg || arg.endsWith(`${path.sep}server.js`);
  } catch {
    return true;
  }
}

if (isMainModule()) {
  startServer().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
