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
import { startRun, finishRun, listRuns, runsStats } from './src/tracking.js';
import {
  ensureKnownUsers,
  loginWithWpm,
  toPublicUser,
  getUserWpmCredentials,
} from './src/userStore.js';
import { sessionMiddleware, requireAuth, requireAdmin, currentPublicUser } from './src/auth.js';
import { createJobQueue } from './src/jobQueue.js';
import { listBackupFolders, listBackupFiles, resolveBackupFile } from './src/backupsApi.js';

dotenv.config({ path: getEnvPath() });

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3847;
const VERSION = '2.0.0-dev';

/** SSE clients: Map<res, { jobId?: string }> */
const clients = new Map();

function broadcast(event, data, { jobId } = {}) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const [res, meta] of clients) {
    if (jobId && meta.jobId && meta.jobId !== jobId) continue;
    try {
      res.write(payload);
    } catch {
      /* ignore */
    }
  }
}

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
    broadcast('log', { line, jobId }, { jobId });
  },
  onChange: (snap) => broadcast('queue', snap),
  maxConcurrent: Number(process.env.MAX_CONCURRENT_JOBS) || 4,
});

export function createApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '1mb' }));
  app.use(sessionMiddleware());

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, version: VERSION, queue: queue.snapshot() });
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

  app.post('/api/logout', (req, res) => {
    req.session.destroy(() => {
      res.json({ ok: true });
    });
  });

  app.get('/api/status', requireAuth, (req, res) => {
    const jobId = String(req.query.jobId || '');
    const job = jobId ? queue.getJob(jobId) : queue.active;
    res.json({
      queue: queue.snapshot(),
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

  app.get('/api/events', requireAuth, (req, res) => {
    const jobId = String(req.query.jobId || '') || undefined;
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    clients.set(res, { jobId, userId: req.user.id });
    res.write(
      `event: hello\ndata: ${JSON.stringify({ ok: true, jobId: jobId || null, queue: queue.snapshot() })}\n\n`
    );

    if (jobId) {
      const job = queue.getJob(jobId);
      if (job) {
        for (const line of (job.logs || []).slice(-80)) {
          res.write(`event: log\ndata: ${JSON.stringify({ line, jobId })}\n\n`);
        }
        if (job.result) {
          res.write(`event: result\ndata: ${JSON.stringify({ ...job.result, jobId })}\n\n`);
        }
        if (job.error && job.status === 'error') {
          res.write(`event: error\ndata: ${JSON.stringify({ message: job.error, jobId })}\n\n`);
        }
      }
    }

    req.on('close', () => {
      clients.delete(res);
    });
  });

  app.post('/api/run', requireAuth, (req, res) => {
    const body = req.body || {};
    const jobPayload = {
      wpmProjectUrl: normalizeWpmProjectUrl(String(body.wpmProjectUrl || '').trim()),
      taskUrl: String(body.taskUrl || '').trim(),
      websiteUrl: String(body.websiteUrl || '').trim(),
      customer: {
        username: sanitizeWpUsername(String(body.username || '').trim()),
        password: sanitizeCustomerPassword(String(body.password || '')),
        email: String(body.email || '').trim(),
      },
      packageTier: body.packageTier || 'F',
      options: {
        downloadBackup: Boolean(body.downloadBackup),
      },
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

    const { jobId, position, queue: qSnap } = queue.enqueue({
      meta: userMeta,
      run: async (pushLog, jobRef) => {
        const thisJobId = jobRef.id;
        for (const [, meta] of clients) {
          if (meta.userId === req.user.id && !meta.jobId) {
            meta.jobId = thisJobId;
          }
        }

        const runId = startRun({
          userId: req.user.id,
          toolUser: req.user.username,
          wpmUser: stored.username,
          wpmProjectUrl: jobPayload.wpmProjectUrl,
          taskUrl: jobPayload.taskUrl || '',
          websiteUrl: jobPayload.websiteUrl,
          username: jobPayload.customer.username,
          steps: jobPayload.steps || [],
          jobId: thisJobId,
          edition: 'v2',
        });

        const onStep = (payload) =>
          broadcast('step', { ...payload, jobId: thisJobId }, { jobId: thisJobId });

        try {
          pushLog('=== Bắt đầu job F User Guide Tool v2 ===');
          const result = await runJob(jobPayload, pushLog, onStep);
          finishRun(runId, { status: 'success', result });
          broadcast('result', { ...result, jobId: thisJobId }, { jobId: thisJobId });
          pushLog('=== Hoàn tất ===');
          broadcast('done', { running: false, jobId: thisJobId }, { jobId: thisJobId });
          broadcast('queue', queue.snapshot());
          return result;
        } catch (err) {
          const message = err?.message || String(err);
          finishRun(runId, { status: 'error', error: message });
          broadcast('error', { message, jobId: thisJobId }, { jobId: thisJobId });
          broadcast('done', { running: false, jobId: thisJobId }, { jobId: thisJobId });
          broadcast('queue', queue.snapshot());
          throw err;
        }
      },
      onDone: () => {
        broadcast('queue', queue.snapshot());
      },
    });

    const maxJobs = Number(process.env.MAX_CONCURRENT_JOBS) || 4;
    broadcast('queue', qSnap);
    res.json({
      ok: true,
      jobId,
      position,
      message:
        position > maxJobs
          ? `Đã xếp hàng (vị trí ${position}). Tối đa ${maxJobs} job chạy cùng lúc.`
          : 'Job đã bắt đầu (hoặc sắp chạy).',
      queue: qSnap,
    });
  });

  app.get('/api/output', requireAuth, (_req, res) => {
    const file = path.join(getAppRoot(), 'output-latest.json');
    if (!fs.existsSync(file)) return res.status(404).json({ error: 'Chưa có output.' });
    res.sendFile(file);
  });

  app.get('/api/runs', requireAuth, requireAdmin, (req, res) => {
    const limit = Math.min(500, Number(req.query.limit) || 100);
    const runs = listRuns({ limit }).slice(0, limit);
    res.json({ stats: runsStats(), runs });
  });

  app.get('/api/backups', requireAuth, (_req, res) => {
    try {
      res.json({
        downloadDir: DOWNLOADS_DIR,
        folders: listBackupFolders(),
      });
    } catch (err) {
      res.status(500).json({ error: err?.message || String(err) });
    }
  });

  app.get('/api/backups/:name/files', requireAuth, (req, res) => {
    try {
      res.json({
        name: req.params.name,
        files: listBackupFiles(req.params.name),
      });
    } catch (err) {
      res.status(404).json({ error: err?.message || String(err) });
    }
  });

  app.get('/api/backups/:name/file', requireAuth, (req, res) => {
    try {
      const filePath = resolveBackupFile(req.params.name, req.query.f);
      res.download(filePath, path.basename(filePath));
    } catch (err) {
      res.status(404).json({ error: err?.message || String(err) });
    }
  });

  app.use(express.static(getPublicDir()));

  return app;
}

export async function startServer({ openBrowser: shouldOpen } = {}) {
  await ensureKnownUsers();
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
    console.log(`F User Guide Tool v2 UI: ${url}`);
    console.log(`Thư mục app: ${getAppRoot()}`);
    console.log(`Download dir: ${DOWNLOADS_DIR}`);
    console.log(`Health: ${url}/api/health`);
    if (autoOpen) setTimeout(() => openBrowser(url), 400);
  });

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
