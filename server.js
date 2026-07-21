import dotenv from 'dotenv';
import express from 'express';
import path from 'path';
import fs from 'fs';
import { exec } from 'child_process';
import { fileURLToPath } from 'url';
import { runJob } from './src/runJob.js';
import {
  getAppRoot,
  getEnvPath,
  getPublicDir,
  readEnvFile,
  upsertEnvVars,
} from './src/envStore.js';
import {
  normalizeWpmProjectUrl,
  sanitizeWpUsername,
  sanitizeCustomerPassword,
} from './src/utils.js';
import { startRun, finishRun, listRuns, runsStats } from './src/tracking.js';

// Load .env cạnh exe (hoặc project root)
dotenv.config({ path: getEnvPath() });

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3847;

/** @type {{ running: boolean, logs: string[], result: object|null, error: string|null }} */
const state = {
  running: false,
  logs: [],
  result: null,
  error: null,
};

const clients = new Set();

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    res.write(payload);
  }
}

function pushLog(line) {
  state.logs.push(line);
  if (state.logs.length > 500) state.logs.shift();
  broadcast('log', { line });
  console.log(line);
}

/** Máy Mac: mở URL bằng lệnh open */
function openBrowser(url) {
  let cmd;
  if (process.platform === 'win32') {
    cmd = `start "" "${url}"`;
  } else if (process.platform === 'darwin') {
    cmd = `open "${url}"`;
  } else {
    cmd = `xdg-open "${url}"`;
  }
  exec(cmd, () => {});
}

export function createApp() {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use(express.static(getPublicDir()));

  app.get('/api/status', (_req, res) => {
    res.json({
      running: state.running,
      logs: state.logs,
      result: state.result,
      error: state.error,
    });
  });

  /** Trạng thái đăng nhập WPM đã lưu trong .env (không trả password thật). */
  app.get('/api/wpm-credentials', (_req, res) => {
    const { map } = readEnvFile();
    const username = map.WPM_USERNAME || process.env.WPM_USERNAME || '';
    const password = map.WPM_PASSWORD || process.env.WPM_PASSWORD || '';
    const configured =
      Boolean(username) &&
      Boolean(password) &&
      !String(username).includes('your_wpm');
    res.json({
      username: configured ? username : username.includes('your_wpm') ? '' : username,
      hasPassword: Boolean(password) && !String(password).includes('your_wpm'),
      configured,
      envPath: getEnvPath(),
    });
  });

  /** Lưu WPM username/password xuống file .env ngay. */
  app.post('/api/wpm-credentials', (req, res) => {
    const username = String(req.body?.username || '').trim();
    const password = String(req.body?.password ?? '');
    if (!username || !password) {
      return res.status(400).json({ error: 'Thiếu username hoặc password WPM.' });
    }
    try {
      const envPath = upsertEnvVars({
        WPM_USERNAME: username,
        WPM_PASSWORD: password,
      });
      res.json({
        ok: true,
        message: `Đã lưu vào ${envPath}`,
        envPath,
        username,
      });
    } catch (err) {
      res.status(500).json({ error: err?.message || String(err) });
    }
  });

  app.get('/api/events', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    clients.add(res);
    res.write(`event: hello\ndata: ${JSON.stringify({ ok: true })}\n\n`);

    for (const line of state.logs.slice(-80)) {
      res.write(`event: log\ndata: ${JSON.stringify({ line })}\n\n`);
    }
    if (state.result) {
      res.write(`event: result\ndata: ${JSON.stringify(state.result)}\n\n`);
    }
    if (state.error && !state.running) {
      res.write(`event: error\ndata: ${JSON.stringify({ message: state.error })}\n\n`);
    }

    req.on('close', () => {
      clients.delete(res);
    });
  });

  app.post('/api/run', async (req, res) => {
    if (state.running) {
      return res.status(409).json({ error: 'Đang chạy một job khác. Đợi xong rồi chạy lại.' });
    }

    // Reload .env trước mỗi job (đồng nghiệp vừa đổi TK)
    dotenv.config({ path: getEnvPath(), override: true });

    const body = req.body || {};
    const job = {
      wpmProjectUrl: normalizeWpmProjectUrl(String(body.wpmProjectUrl || '').trim()),
      taskUrl: String(body.taskUrl || '').trim(),
      websiteUrl: String(body.websiteUrl || '').trim(),
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

    if (!job.wpmProjectUrl || !job.websiteUrl) {
      return res.status(400).json({ error: 'Thiếu wpmProjectUrl hoặc websiteUrl.' });
    }
    if (!job.customer.username || !job.customer.password || !job.customer.email) {
      return res.status(400).json({ error: 'Thiếu username / password / email khách.' });
    }

    const wpmUser = process.env.WPM_USERNAME || '';
    const wpmPass = process.env.WPM_PASSWORD || '';
    if (!wpmUser || !wpmPass || wpmUser.includes('your_wpm')) {
      return res.status(400).json({
        error: 'Chưa lưu tài khoản WPM. Điền Username/Password WPM phía trên rồi bấm Lưu.',
      });
    }

    state.running = true;
    state.logs = [];
    state.result = null;
    state.error = null;

    res.json({ ok: true, message: 'Job đã bắt đầu.' });

    const runId = startRun({
      wpmUser: process.env.WPM_USERNAME || '',
      wpmProjectUrl: job.wpmProjectUrl,
      taskUrl: job.taskUrl || '',
      websiteUrl: job.websiteUrl,
      username: job.customer.username,
      steps: job.steps || [],
      edition: 'v2',
    });

    try {
      pushLog('=== Bắt đầu job F User Guide Tool v2 ===');
      const onStep = (payload) => broadcast('step', payload);
      const result = await runJob(job, pushLog, onStep);
      state.result = result;
      finishRun(runId, { status: 'success', result });
      broadcast('result', result);
      pushLog('=== Hoàn tất ===');
    } catch (err) {
      const message = err?.message || String(err);
      state.error = message;
      finishRun(runId, { status: 'error', error: message });
      pushLog(`❌ Lỗi: ${message}`);
      broadcast('error', { message });
    } finally {
      state.running = false;
      broadcast('done', { running: false });
    }
  });

  app.get('/api/output', (_req, res) => {
    const file = path.join(getAppRoot(), 'output-latest.json');
    if (!fs.existsSync(file)) return res.status(404).json({ error: 'Chưa có output.' });
    res.sendFile(file);
  });

  app.get('/api/runs', (req, res) => {
    const limit = Math.min(500, Number(req.query.limit) || 100);
    res.json({ stats: runsStats(), runs: listRuns({ limit }) });
  });

  return app;
}

export function startServer({ openBrowser: shouldOpen = true } = {}) {
  const app = createApp();
  const server = app.listen(PORT, () => {
    const url = `http://localhost:${PORT}`;
    console.log(`F User Guide Tool UI: ${url}`);
    console.log(`Thư mục app: ${getAppRoot()}`);
    console.log(`File .env: ${getEnvPath()}`);
    const { map } = readEnvFile();
    if (!map.WPM_USERNAME || String(map.WPM_USERNAME).includes('your_wpm')) {
      console.log('⚠ Chưa lưu WPM — mở UI → mục "Tài khoản WPM" → Lưu.');
    }
    if (shouldOpen) {
      setTimeout(() => openBrowser(url), 400);
    }
  });
  server.on('error', (err) => {
    if (err?.code === 'EADDRINUSE') {
      console.error(`\n[ERROR] Port ${PORT} đang bị chiếm — có thể F User Guide Tool đã chạy.`);
      console.error(`Mở trình duyệt: http://localhost:${PORT}`);
      console.error('Hoặc đóng process cũ rồi chạy lại.\n');
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
  startServer({ openBrowser: true });
}
