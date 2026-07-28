const loginPanel = document.getElementById('loginPanel');
const loginForm = document.getElementById('loginForm');
const loginBtn = document.getElementById('loginBtn');
const loginStatus = document.getElementById('loginStatus');
const loginError = document.getElementById('loginError');
const appMain = document.getElementById('appMain');
const userBar = document.getElementById('userBar');
const whoAmI = document.getElementById('whoAmI');
const logoutBtn = document.getElementById('logoutBtn');

const form = document.getElementById('jobForm');
const runBtn = document.getElementById('runBtn');
const cancelBtn = document.getElementById('cancelBtn');
const logBox = document.getElementById('logBox');
const statusBadge = document.getElementById('statusBadge');
const queueHint = document.getElementById('queueHint');
const resultPanel = document.getElementById('resultPanel');
const outLogin = document.getElementById('outLogin');
const outUser = document.getElementById('outUser');
const outPass = document.getElementById('outPass');
const outDoc = document.getElementById('outDoc');
const copyBtn = document.getElementById('copyBtn');
const stepsAllBtn = document.getElementById('stepsAllBtn');
const stepsNoneBtn = document.getElementById('stepsNoneBtn');

let currentUser = null;
let currentJobId = null;
let socket = null;
let watchJobId = null;

const doneThisRun = new Set();

function setCancelVisible(show) {
  if (!cancelBtn) return;
  cancelBtn.hidden = !show;
  if (!show) cancelBtn.disabled = false;
}

async function cancelCurrentJob() {
  const id = currentJobId;
  if (!id) {
    appendLog('⚠ Không có job đang chạy để hủy.');
    return;
  }
  if (cancelBtn) cancelBtn.disabled = true;
  try {
    const res = await fetch(`/api/queue/${encodeURIComponent(id)}/cancel`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || res.statusText);
    appendLog(
      `⏹ Đã gửi hủy job ${id.slice(0, 8)}… (${data.kind}${data.closingBrowser ? ', đóng Chrome' : ''})`
    );
    // Mở lại Run ngay — không chờ socket (tránh nút chết / “không có gì”)
    setRunBadge('idle', 'Cancelled');
    runBtn.disabled = false;
    setCancelVisible(false);
    currentJobId = null;
    watchJobId = null;
    refreshQueue();
  } catch (err) {
    appendLog(`❌ Hủy job: ${err.message}`);
    if (cancelBtn) cancelBtn.disabled = false;
    runBtn.disabled = false;
  }
}

function setBadge(el, mode, text) {
  el.className = `badge ${mode}`;
  el.textContent = text;
}

function setRunBadge(mode, text) {
  setBadge(statusBadge, mode, text);
}

function setHintTone(el, tone = 'muted') {
  if (!el) return;
  el.classList.remove('hint--muted', 'hint--ok', 'hint--warn', 'hint--accent', 'hint--error');
  const map = {
    muted: 'hint--muted',
    ok: 'hint--ok',
    warn: 'hint--warn',
    accent: 'hint--accent',
    error: 'hint--error',
  };
  el.classList.add(map[tone] || map.muted);
}

function appendLog(line) {
  if (!logBox) return;
  const row = document.createElement('div');
  row.className = 'log-line';
  const text = String(line ?? '');
  // Link ảnh lỗi: /api/errors/....png
  const parts = text.split(/(\/api\/errors\/[A-Za-z0-9._%-]+\.png)/g);
  if (parts.length === 1) {
    row.textContent = text;
  } else {
    for (const part of parts) {
      if (/^\/api\/errors\/[A-Za-z0-9._%-]+\.png$/.test(part)) {
        const a = document.createElement('a');
        a.href = part;
        a.target = '_blank';
        a.rel = 'noopener';
        a.className = 'log-shot-link';
        a.textContent = '🖼 Mở ảnh lỗi';
        row.appendChild(a);
      } else if (part) {
        row.appendChild(document.createTextNode(part));
      }
    }
  }
  logBox.appendChild(row);
  logBox.scrollTop = logBox.scrollHeight;
}

function appendScreenshotLinks(screenshots) {
  if (!Array.isArray(screenshots) || !screenshots.length) return;
  for (const s of screenshots) {
    if (!s?.url) continue;
    appendLog(`📸 Ảnh lỗi ${s.label || ''}: ${s.url}`.trim());
  }
}

function stepInputs() {
  return [...document.querySelectorAll('input[name="step"]')];
}

function getSelectedSteps() {
  return stepInputs().filter((el) => el.checked).map((el) => el.value);
}

function setAllSteps(checked) {
  for (const el of stepInputs()) {
    el.checked = checked;
    el.closest('.step-item')?.classList.remove('done', 'running');
  }
  doneThisRun.clear();
}

function clearStepStyles() {
  for (const el of stepInputs()) {
    el.closest('.step-item')?.classList.remove('done', 'running');
  }
}

function markStepUi(id, status) {
  const el = document.querySelector(`input[name="step"][value="${id}"]`);
  if (!el) return;
  const row = el.closest('.step-item');
  if (status === 'start') {
    row?.classList.add('running');
    row?.classList.remove('done');
  }
  if (status === 'done') {
    doneThisRun.add(id);
    row?.classList.remove('running');
    row?.classList.add('done');
  }
}

function untickCompletedAfterError() {
  if (doneThisRun.size === 0) return;
  for (const el of stepInputs()) {
    if (doneThisRun.has(el.value)) {
      el.checked = false;
      el.closest('.step-item')?.classList.add('done');
      el.closest('.step-item')?.classList.remove('running');
    } else {
      el.closest('.step-item')?.classList.remove('running');
    }
  }
  appendLog(`↳ Đã bỏ tick ${doneThisRun.size} bước xong — tick còn lại để Run tiếp.`);
}

stepsAllBtn?.addEventListener('click', () => setAllSteps(true));
stepsNoneBtn?.addEventListener('click', () => setAllSteps(false));

function showResult(result) {
  resultPanel.hidden = false;
  const guide = result.guideFile || result.docLink || '';
  const login = result.loginUrl || '';
  outLogin.textContent = login;
  if (login) outLogin.href = login;
  else outLogin.removeAttribute('href');
  outDoc.textContent = guide;
  if (guide) outDoc.href = guide;
  else outDoc.removeAttribute('href');
  outUser.textContent = result.username || '';
  outPass.textContent =
    result.password ||
    (result.accountExists
      ? 'Đã tồn tại TK trên web — không khởi tạo mới, không có password mới'
      : '');
}

function applyRoleUi(user) {
  const isAdmin = user?.role === 'admin';
  document.querySelectorAll('[data-admin-only]').forEach((el) => {
    el.hidden = !isAdmin;
  });
  // User thường: không hiện tab (tránh nhầm với nút Run) — luôn ở màn job
  if (!isAdmin) {
    document.querySelectorAll('.tab').forEach((b) => b.classList.remove('active'));
    document.querySelector('.tab[data-tab="run"]')?.classList.add('active');
    const tabRun = document.getElementById('tab-run');
    const tabReports = document.getElementById('tab-reports');
    if (tabRun) tabRun.hidden = false;
    if (tabReports) tabReports.hidden = true;
    const mainRadio = form?.querySelector('input[name="webTargetMode"][value="main"]');
    if (mainRadio) mainRadio.checked = true;
  }
  updateWebTargetWarn();
}

function showLoggedOut() {
  currentUser = null;
  loginPanel.hidden = false;
  appMain.hidden = true;
  userBar.hidden = true;
  if (logoutBtn) logoutBtn.hidden = true;
  whoAmI.textContent = '';
  setBadge(loginStatus, 'idle', 'Guest');
  disconnectSocket();
}

function showApp(user) {
  currentUser = user;
  loginPanel.hidden = true;
  appMain.hidden = false;
  userBar.hidden = false;
  if (logoutBtn) logoutBtn.hidden = false;
  const isAdmin = user.role === 'admin';
  whoAmI.textContent = isAdmin ? `${user.username} (admin)` : user.username;
  setBadge(loginStatus, 'done', 'OK');
  applyRoleUi(user);
  connectEvents();
  refreshQueue();
  setupLiveChrome();
}

async function refreshMe() {
  const res = await fetch('/api/me');
  const data = await res.json();
  const user = data.user;
  // Session cũ (guest web / admin seed) — bắt login lại bằng WPM
  if (user && (user.username === 'web' || user.username === 'admin') && !user.wpmConfigured) {
    await fetch('/api/logout', { method: 'POST' });
    showLoggedOut();
    return;
  }
  if (user) showApp(user);
  else showLoggedOut();
}

loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  loginError.textContent = '';
  loginBtn.disabled = true;
  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: document.getElementById('loginUser').value.trim(),
        password: document.getElementById('loginPass').value,
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      loginError.textContent = data.error || 'Login thất bại';
      setBadge(loginStatus, 'error', 'Error');
      return;
    }
    document.getElementById('loginPass').value = '';
    showApp(data.user);
  } catch (err) {
    loginError.textContent = err.message;
  } finally {
    loginBtn.disabled = false;
  }
});

logoutBtn.addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST' });
  showLoggedOut();
});

function disconnectSocket() {
  watchJobId = null;
  if (socket) {
    try {
      socket.removeAllListeners();
      socket.disconnect();
    } catch {
      /* ignore */
    }
    socket = null;
  }
}

function connectEvents(jobId) {
  if (typeof io !== 'function') {
    console.error('Socket.IO client chưa load');
    return;
  }

  watchJobId = jobId || null;

  if (!socket) {
    socket = io({
      path: '/socket.io',
      withCredentials: true,
      transports: ['websocket', 'polling'],
    });

    socket.on('connect', () => {
      if (watchJobId) socket.emit('watch-job', watchJobId);
      refreshQueue();
    });

    socket.on('hello', (data) => {
      if (data?.queue) renderQueue(data.queue);
    });

    socket.on('log', (data) => {
      if (watchJobId && data.jobId && data.jobId !== watchJobId) return;
      if (data?.line) appendLog(data.line);
    });

    socket.on('step', (data) => {
      if (data?.id && data?.status) markStepUi(data.id, data.status);
    });

    socket.on('result', (data) => {
      if (watchJobId && data.jobId && data.jobId !== watchJobId) return;
      showResult(data);
      setRunBadge('done', 'Done');
      runBtn.disabled = false;
      setCancelVisible(false);
      currentJobId = null;
      watchJobId = null;
      if (resumeBtn) resumeBtn.hidden = true;
      clearStepStyles();
      doneThisRun.clear();
      queueHint.textContent = '';
      refreshQueue();
    });

    socket.on('job-error', (data) => {
      try {
        if (!data?.message) return;
        if (watchJobId && data.jobId && data.jobId !== watchJobId) return;
        const cancelled = Boolean(data.cancelled) || /đã bị hủy|hủy bởi/i.test(data.message || '');
        appendLog(cancelled ? `⏹ ${data.message}` : `❌ ${data.message}`);
        if (!cancelled) {
          appendScreenshotLinks(data.screenshots);
          untickCompletedAfterError();
        }
        setRunBadge(cancelled ? 'idle' : 'error', cancelled ? 'Cancelled' : 'Error');
        runBtn.disabled = false;
        setCancelVisible(false);
        currentJobId = null;
        watchJobId = null;
        if (resumeBtn) {
          if (cancelled) {
            resumeBtn.hidden = true;
          } else {
            resumeBtn.hidden = false;
            appendLog('↳ Bấm Resume để chạy các bước còn tick (hoặc tick lại rồi Run).');
          }
        }
        queueHint.textContent = '';
        refreshQueue();
      } catch {
        /* ignore */
      }
    });

    socket.on('queue', (q) => {
      renderQueue(q);
    });

    socket.on('done', (data) => {
      if (watchJobId && data?.jobId && data.jobId !== watchJobId) return;
      runBtn.disabled = false;
      setCancelVisible(false);
      refreshQueue();
    });

    socket.on('connect_error', (err) => {
      console.warn('[socket]', err?.message || err);
    });
  } else if (socket.connected) {
    socket.emit('watch-job', watchJobId);
  }
}

function normalizeWpmProjectUrl(raw) {
  const s = String(raw || '').trim();
  if (!s) return s;
  try {
    const u = new URL(s);
    const m = u.pathname.match(/^\/projects\/(\d+)(?:\/(.*))?$/i);
    if (m) {
      u.pathname = `/projects/${m[1]}/edit`;
      return u.toString();
    }
  } catch {
    /* ignore */
  }
  if (/\/projects\/\d+/i.test(s) && !/\/projects\/\d+\/edit/i.test(s)) {
    return s.replace(/(\/projects\/\d+)\/?/i, '$1/edit');
  }
  return s;
}

function stripApostrophes(raw) {
  return String(raw ?? '').replace(/[''`´′’‘]/g, '');
}

function sanitizeWpUsername(raw) {
  let s = stripApostrophes(raw).trim().toLowerCase();
  s = s.replace(/\s+/g, '-');
  s = s.replace(/[^a-z0-9._\-@]/g, '');
  return s.replace(/-+/g, '-').replace(/^\-+|\-+$/g, '');
}

function sanitizeCustomerPassword(raw) {
  return stripApostrophes(raw);
}

const projectUrlInput = form?.querySelector('[name="wpmProjectUrl"]');
projectUrlInput?.addEventListener('blur', () => {
  const next = normalizeWpmProjectUrl(projectUrlInput.value);
  if (next) projectUrlInput.value = next;
});

for (const name of ['username', 'password']) {
  const el = form?.querySelector(`[name="${name}"]`);
  if (!el) continue;
  const apply = () => {
    const next =
      name === 'username' ? sanitizeWpUsername(el.value) : sanitizeCustomerPassword(el.value);
    if (next !== el.value) el.value = next;
  };
  el.addEventListener('blur', apply);
  el.addEventListener('change', apply);
}

const fillDataBtn = document.getElementById('fillDataBtn');
const fillDataHint = document.getElementById('fillDataHint');
const fillFieldStatus = document.getElementById('fillFieldStatus');
const resumeBtn = document.getElementById('resumeBtn');
const webTargetWarn = document.getElementById('webTargetWarn');

function getWebTargetMode() {
  if (currentUser?.role !== 'admin') return 'main';
  const checked = form?.querySelector('input[name="webTargetMode"]:checked');
  return checked?.value === 'website' ? 'website' : 'main';
}

function updateWebTargetWarn() {
  if (!webTargetWarn) return;
  const mode = getWebTargetMode();
  webTargetWarn.hidden = mode !== 'website';
}

form?.querySelectorAll('input[name="webTargetMode"]').forEach((el) => {
  el.addEventListener('change', updateWebTargetWarn);
});

function clearFieldWarns() {
  for (const id of ['fieldWebsiteUrl', 'fieldUsername', 'fieldPassword', 'fieldEmail']) {
    document.getElementById(id)?.classList.remove('field-warn');
  }
}

function markFieldWarn(name, bad) {
  const map = {
    websiteUrl: 'fieldWebsiteUrl',
    username: 'fieldUsername',
    password: 'fieldPassword',
    email: 'fieldEmail',
  };
  const el = document.getElementById(map[name]);
  if (!el) return;
  el.classList.toggle('field-warn', Boolean(bad));
}

function renderFillStatus(fields = {}, needManual = []) {
  if (!fillFieldStatus) return;
  const keys = ['websiteUrl', 'username', 'password', 'email', 'state', 'zip'];
  fillFieldStatus.hidden = false;
  fillFieldStatus.innerHTML = keys
    .map((k) => {
      const f = fields[k] || {};
      const ok = f.ok === true && Boolean(String(f.value || '').trim());
      const label = k === 'websiteUrl' ? 'Website' : k;
      const text = ok ? `${label}: OK` : `${label}: thiếu`;
      const title = String(f.hint || (ok ? 'OK' : 'Cần sửa tay')).replace(/"/g, '&quot;');
      return `<span class="fill-chip ${ok ? 'ok' : 'bad'}" title="${title}">${text}</span>`;
    })
    .join('');
  clearFieldWarns();
  for (const k of needManual) markFieldWarn(k, true);
}

fillDataBtn?.addEventListener('click', async () => {
  const projectInput = form?.querySelector('[name="wpmProjectUrl"]');
  const taskInput = form?.querySelector('[name="taskUrl"]');
  const websiteInput = form?.querySelector('[name="websiteUrl"]');
  const wpmProjectUrl = normalizeWpmProjectUrl(projectInput?.value || '');
  if (projectInput && wpmProjectUrl) projectInput.value = wpmProjectUrl;
  if (!wpmProjectUrl) {
    fillDataHint.textContent = 'Nhập WPM Project URL trước.';
    setHintTone(fillDataHint, 'error');
    return;
  }

  const webTargetMode = getWebTargetMode();
  const websiteUrl = (websiteInput?.value || '').trim();
  if (webTargetMode === 'website' && !websiteUrl) {
    fillDataHint.textContent = 'Mode Website: điền ô Website (subdomain) trước rồi Fill.';
    setHintTone(fillDataHint, 'error');
    markFieldWarn('websiteUrl', true);
    return;
  }

  fillDataBtn.disabled = true;
  runBtn.disabled = true;
  setHintTone(fillDataHint, 'muted');
  fillDataHint.textContent =
    webTargetMode === 'website'
      ? 'Đang lấy data (khớp Website + footer)…'
      : 'Đang lấy data (Main Web + footer)…';
  if (fillFieldStatus) fillFieldStatus.hidden = true;
  clearFieldWarns();
  logBox.textContent = '';
  appendLog('=== Fill data ===');
  resetLiveFrameBlank();
  appendLog('[live] Clear Live → Fill mới…');
  if (webTargetMode === 'website') {
    appendLog(`Target web = khớp Website (${websiteUrl})`);
  }
  setRunBadge('running', 'Fill…');

  try {
    const res = await fetch('/api/fill-data', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        wpmProjectUrl,
        taskUrl: (taskInput?.value || '').trim(),
        websiteUrl,
        webTargetMode,
      }),
    });
    const data = await res.json();
    for (const line of data.logs || []) appendLog(line);

    if (!res.ok) {
      appendLog(`❌ ${data.error || res.statusText}`);
      fillDataHint.textContent = data.error || 'Fill data thất bại';
      setHintTone(fillDataHint, 'error');
      setRunBadge('error', 'Error');
      return;
    }

    const setVal = (name, val) => {
      const el = form.querySelector(`[name="${name}"]`);
      if (el && val != null) el.value = val;
    };
    setVal('websiteUrl', data.websiteUrl || '');
    setVal('username', data.username || '');
    setVal('password', data.password || '');
    setVal('email', data.email || '');

    const warns = data.warnings || [];
    for (const w of warns) appendLog(`⚠ ${w}`);
    renderFillStatus(data.fields || {}, data.needManual || []);

    if (data.needManual?.length) {
      fillDataHint.textContent = `Thiếu: ${data.needManual.join(', ')} — sửa tay ô vàng rồi Run.`;
      setHintTone(fillDataHint, 'warn');
      setRunBadge('warn', 'Sửa tay');
    } else if (warns.length) {
      fillDataHint.textContent = `Đã fill — ${warns.length} cảnh báo (xem Log). Có thể Run.`;
      setHintTone(fillDataHint, 'warn');
      setRunBadge('done', 'Filled');
    } else {
      fillDataHint.textContent = 'Đã fill xong — kiểm tra rồi bấm Run.';
      setHintTone(fillDataHint, 'ok');
      setRunBadge('done', 'Filled');
    }
    appendLog('=== Fill data xong ===');
  } catch (err) {
    appendLog(`❌ ${err.message}`);
    fillDataHint.textContent = err.message;
    setHintTone(fillDataHint, 'error');
    setRunBadge('error', 'Error');
  } finally {
    fillDataBtn.disabled = false;
    runBtn.disabled = false;
  }
});

let pendingResume = false;
let liveChromeOpen = false;
let liveChromeSrc = '';
/** @type {null | (() => Promise<void>)} */
let openLiveChromeFn = null;

resumeBtn?.addEventListener('click', async () => {
  appendLog('↳ Resume = mở Live + Chrome headed (để xem được).');
  pendingResume = true;
  try {
    if (openLiveChromeFn && !liveChromeOpen) {
      appendLog('[live] Đang bật Live trước Resume…');
      await openLiveChromeFn();
    }
  } catch (err) {
    appendLog(`⚠ Live: ${err?.message || err} — vẫn Resume (headed).`);
  }
  form?.requestSubmit();
});

function resetLiveFrameBlank() {
  const frame = document.getElementById('liveChromeFrame');
  const wrap = document.getElementById('liveChromeFrameWrap');
  if (!frame || !liveChromeOpen) return;
  // Về trắng trước khi job mới — rồi reload embed
  frame.src = 'about:blank';
  if (wrap) wrap.hidden = false;
  const src = liveChromeSrc.startsWith('http')
    ? liveChromeSrc
    : `${window.location.origin}${liveChromeSrc || '/chrome-live/embed'}`;
  setTimeout(() => {
    if (!liveChromeOpen) return;
    frame.src = `${src}${src.includes('?') ? '&' : '?'}_=${Date.now()}`;
  }, 400);
}

form?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const isResume = pendingResume;
  pendingResume = false;
  const fd = new FormData(form);
  const steps = getSelectedSteps();
  if (steps.length === 0) {
    appendLog('❌ Chưa chọn bước nào. Tick ít nhất 1 bước.');
    setRunBadge('error', 'Error');
    return;
  }

  const projectInput = form.querySelector('[name="wpmProjectUrl"]');
  const normalizedProject = normalizeWpmProjectUrl(fd.get('wpmProjectUrl'));
  if (projectInput && normalizedProject) projectInput.value = normalizedProject;

  const userEl = form.querySelector('[name="username"]');
  const passEl = form.querySelector('[name="password"]');
  const cleanUser = sanitizeWpUsername(fd.get('username'));
  const cleanPass = sanitizeCustomerPassword(fd.get('password'));
  if (userEl) userEl.value = cleanUser;
  if (passEl) passEl.value = cleanPass;

  const payload = {
    wpmProjectUrl: normalizedProject,
    taskUrl: fd.get('taskUrl'),
    websiteUrl: fd.get('websiteUrl'),
    username: cleanUser,
    password: cleanPass,
    email: fd.get('email'),
    docLink: fd.get('docLink'),
    packageTier: 'F',
    steps,
    webTargetMode: getWebTargetMode(),
    resume: isResume,
    wantLive: Boolean(isResume || liveChromeOpen),
  };

  logBox.textContent = '';
  resultPanel.hidden = true;
  doneThisRun.clear();
  clearStepStyles();
  runBtn.disabled = true;
  setRunBadge('running', isResume ? 'Resume' : 'Running');
  if (!isResume) {
    resetLiveFrameBlank();
    appendLog('[live] Clear Live → chạy Run mới…');
  }
  if (payload.webTargetMode === 'website') {
    appendLog(`⚠ Target web = khớp Website (${payload.websiteUrl})`);
  }
  try {
    const res = await fetch('/api/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) {
      appendLog(`❌ ${data.error || res.statusText}`);
      setRunBadge('error', 'Error');
      runBtn.disabled = false;
      setCancelVisible(false);
      return;
    }
    currentJobId = data.jobId;
    setCancelVisible(true);
    queueHint.textContent = data.message || '';
    if (data.queue) renderQueue(data.queue);
    connectEvents(data.jobId);
    refreshQueue();
    if (data.position > 1) setRunBadge('running', `Queue #${data.position}`);
  } catch (err) {
    appendLog(`❌ ${err.message}`);
    setRunBadge('error', 'Error');
    runBtn.disabled = false;
    setCancelVisible(false);
  }
});

cancelBtn?.addEventListener('click', () => {
  cancelCurrentJob();
});

copyBtn?.addEventListener('click', async () => {
  const text = [
    `1. Login Url: ${outLogin.textContent}`,
    `2. Guide File: ${outDoc.textContent}`,
    `3. User name: ${outUser.textContent}`,
    `4. Password: ${outPass.textContent}`,
  ].join('\n');
  await navigator.clipboard.writeText(text);
  copyBtn.textContent = 'Đã copy';
  setTimeout(() => {
    copyBtn.textContent = 'Copy tất cả';
  }, 1500);
});

resultPanel?.addEventListener('click', async (e) => {
  const btn = e.target.closest('.copy-one');
  if (!btn || !resultPanel.contains(btn)) return;
  const id = btn.getAttribute('data-copy');
  const el = id ? document.getElementById(id) : null;
  if (!el) return;
  const val = String(el.textContent || '').trim();
  if (!val) return;
  await navigator.clipboard.writeText(val);
  btn.classList.add('copied');
  setTimeout(() => btn.classList.remove('copied'), 1200);
});

/* Tabs */
document.querySelectorAll('.tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    const tab = btn.getAttribute('data-tab');
    document.getElementById('tab-run').hidden = tab !== 'run';
    const reports = document.getElementById('tab-reports');
    if (reports) reports.hidden = tab !== 'reports';
    if (tab === 'reports') {
      loadReports();
      loadHealth();
    }
  });
});

function formatDuration(ms) {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return '—';
  const totalSec = Math.round(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

/** ISO UTC → `YYYY-MM-DD HH:mm:ss` theo giờ Việt Nam (UTC+7). */
function formatVnDateTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) {
    return String(iso).replace('T', ' ').replace(/\.\d+Z?$/, '').slice(0, 19);
  }
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Ho_Chi_Minh',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(d);
  const get = (type) => parts.find((p) => p.type === type)?.value || '';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get('second')}`;
}

function runDurationMs(r) {
  if (r.durationMs != null && Number.isFinite(Number(r.durationMs))) return Number(r.durationMs);
  if (!r.startedAt || !r.finishedAt) return null;
  const a = Date.parse(r.startedAt);
  const b = Date.parse(r.finishedAt);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, b - a);
}

function renderQueue(q) {
  const max = q?.maxConcurrent || 4;
  if (q?.runningCount > 0 || q?.pendingCount > 0) {
    queueHint.textContent = `Đang chạy ${q.runningCount || 0}/${max}${q.pendingCount ? ` · chờ ${q.pendingCount}` : ''}`;
  } else {
    queueHint.textContent = '';
  }
  const box = document.getElementById('queueList');
  if (!box) return;
  const items = q?.queue || [];
  if (!items.length) {
    box.innerHTML = '<p class="hint">Trống.</p>';
    return;
  }
  box.innerHTML = '';
  for (const item of items) {
    const row = document.createElement('div');
    row.className = 'queue-row';
    const short = String(item.id || '').slice(0, 8);
    const who = String(item.user || item.username || '').trim() || '—';
    const when = item.startedAt
      ? formatVnDateTime(item.startedAt)
      : item.createdAt
        ? formatVnDateTime(item.createdAt)
        : '';
    const statusLabel = item.status === 'running' ? '▶ Running' : `#${item.position || '?'} Waiting`;
    const statusClass = item.status === 'running' ? 'is-running' : 'is-waiting';
    const metaBits = [short ? `${short}…` : '', when].filter(Boolean).join(' · ');
    row.innerHTML = `
      <div class="queue-main">
        <div class="queue-top">
          <span class="queue-status ${statusClass}">${statusLabel}</span>
          <button type="button" class="secondary tiny queue-cancel" data-id="${item.id}">Hủy</button>
        </div>
        <div class="queue-user" title="${who.replace(/"/g, '&quot;')}">${who}</div>
        <div class="meta">${metaBits}</div>
      </div>`;
    box.appendChild(row);
  }
  box.querySelectorAll('.queue-cancel').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.getAttribute('data-id');
      if (!id) return;
      btn.disabled = true;
      try {
        const res = await fetch(`/api/queue/${encodeURIComponent(id)}/cancel`, { method: 'POST' });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || res.statusText);
        appendLog(`⏹ Đã hủy job ${id.slice(0, 8)}… (${data.kind})`);
        if (id === currentJobId) {
          setRunBadge('idle', 'Cancelled');
          runBtn.disabled = false;
          setCancelVisible(false);
          currentJobId = null;
          watchJobId = null;
        }
        refreshQueue();
      } catch (err) {
        appendLog(`❌ Hủy job: ${err.message}`);
        btn.disabled = false;
      }
    });
  });
}

async function refreshQueue() {
  try {
    const res = await fetch('/api/queue');
    if (!res.ok) return;
    renderQueue(await res.json());
  } catch {
    /* ignore */
  }
}

function reportQuery() {
  const p = new URLSearchParams();
  p.set('limit', '200');
  const user = document.getElementById('filterUser')?.value?.trim();
  const from = document.getElementById('filterFrom')?.value;
  const to = document.getElementById('filterTo')?.value;
  const status = document.getElementById('filterStatus')?.value;
  if (user) p.set('user', user);
  if (from) p.set('from', from);
  if (to) p.set('to', to);
  if (status) p.set('status', status);
  return p;
}

async function loadReports() {
  const res = await fetch(`/api/runs?${reportQuery()}`);
  if (!res.ok) return;
  const data = await res.json();
  document.getElementById('statTotal').textContent = data.stats?.total ?? 0;
  document.getElementById('statOk').textContent = data.stats?.success ?? 0;
  document.getElementById('statErr').textContent = data.stats?.error ?? 0;
  const avgEl = document.getElementById('statAvg');
  if (avgEl) avgEl.textContent = formatDuration(data.stats?.avgDurationMs);
  const tbody = document.querySelector('#runsTable tbody');
  tbody.innerHTML = '';
  for (const r of data.runs || []) {
    const tr = document.createElement('tr');
    const noteRaw =
      r.error ||
      r.resultSummary?.username ||
      (r.resultSummary?.accountExists ? 'account exists' : '');
    const note = String(noteRaw || '—').replace(/\s+/g, ' ').trim();
    const dur = formatDuration(runDurationMs(r));
    const started = formatVnDateTime(r.startedAt);
    const [datePart, timePart] = started.includes(' ')
      ? started.split(' ')
      : [started, ''];
    const url = r.websiteUrl || '—';
    const user = r.toolUser || r.username || '—';
    const statusClass =
      r.status === 'success'
        ? 'done'
        : r.status === 'error'
          ? 'error'
          : r.status === 'cancelled'
            ? 'cancelled'
            : 'running';

    const tdTime = document.createElement('td');
    tdTime.className = 'col-time';
    tdTime.innerHTML = `${escapeHtml(datePart)}${timePart ? `<br><span class="muted">${escapeHtml(timePart)}</span>` : ''}`;

    const tdUser = document.createElement('td');
    tdUser.className = 'col-user';
    tdUser.title = user;
    tdUser.textContent = user;

    const tdUrl = document.createElement('td');
    tdUrl.className = 'col-url mono';
    tdUrl.title = url;
    tdUrl.textContent = url;

    const tdDur = document.createElement('td');
    tdDur.className = 'col-dur mono';
    tdDur.textContent = dur;

    const tdStatus = document.createElement('td');
    tdStatus.className = 'col-status';
    const badge = document.createElement('span');
    badge.className = `badge ${statusClass}`;
    badge.textContent = r.status || '—';
    tdStatus.appendChild(badge);

    const tdNote = document.createElement('td');
    tdNote.className = 'col-note';
    tdNote.title = note;
    const noteSpan = document.createElement('span');
    noteSpan.className = 'note-text';
    noteSpan.textContent = note;
    tdNote.appendChild(noteSpan);

    tr.append(tdTime, tdUser, tdUrl, tdDur, tdStatus, tdNote);
    tbody.appendChild(tr);
  }
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function loadHealth() {
  const box = document.getElementById('healthBox');
  if (!box) return;
  try {
    const res = await fetch('/api/health');
    const data = await res.json();
    const lines = [
      `ok=${data.ok} · chrome=${data.chrome?.ok ? 'OK' : 'MISSING'} ${data.chrome?.path || data.chrome?.error || ''}`,
      `downloads≈${data.disk?.mb ?? '?'} MB (${data.disk?.path || ''})`,
      `queue running=${data.queue?.runningCount || 0} pending=${data.queue?.pendingCount || 0}`,
    ];
    for (const a of data.alerts || []) {
      lines.push(`[${a.level}] ${a.message}`);
    }
    if (!(data.alerts || []).length) lines.push('Không có alert.');
    box.textContent = lines.join('\n');
  } catch (err) {
    box.textContent = err.message;
  }
}

document.getElementById('refreshReportsBtn')?.addEventListener('click', loadReports);
document.getElementById('exportCsvBtn')?.addEventListener('click', () => {
  window.location.href = `/api/runs.csv?${reportQuery()}`;
});
document.getElementById('clearReportsBtn')?.addEventListener('click', async () => {
  if (!confirm('Xóa toàn bộ lịch sử báo cáo? Không hoàn tác được.')) return;
  try {
    const res = await fetch('/api/runs', { method: 'DELETE' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || res.statusText);
    await loadReports();
    alert(`Đã xóa ${data.cleared ?? 0} bản ghi.`);
  } catch (err) {
    alert(err?.message || 'Xóa báo cáo thất bại.');
  }
});
document.getElementById('refreshHealthBtn')?.addEventListener('click', loadHealth);
['filterUser', 'filterFrom', 'filterTo', 'filterStatus'].forEach((id) => {
  document.getElementById(id)?.addEventListener('change', loadReports);
});

async function setupLiveChrome() {
  const panel = document.getElementById('liveChromePanel');
  const toggle = document.getElementById('liveChromeToggle');
  const badge = document.getElementById('liveChromeBadge');
  const wrap = document.getElementById('liveChromeFrameWrap');
  const frame = document.getElementById('liveChromeFrame');
  const newTab = document.getElementById('liveChromeNewTab');
  const hintEl = panel?.querySelector('.live-chrome-hint');
  if (!panel || !toggle) return;

  let starting = false;

  const stopLiveBackend = () => {
    try {
      fetch('/api/chrome-live/stop', {
        method: 'POST',
        credentials: 'same-origin',
        keepalive: true,
      }).catch(() => {});
    } catch {
      /* ignore */
    }
  };

  const setUiClosed = () => {
    liveChromeOpen = false;
    document.body.classList.remove('live-layout');
    if (frame) frame.src = 'about:blank';
    if (wrap) wrap.hidden = true;
    toggle.disabled = false;
    toggle.textContent = 'Mở Live';
    if (badge) {
      badge.textContent = 'OFF';
      badge.classList.remove('on');
    }
  };

  const setUiOpen = () => {
    liveChromeOpen = true;
    document.body.classList.add('live-layout');
    const src = liveChromeSrc.startsWith('http')
      ? liveChromeSrc
      : `${window.location.origin}${liveChromeSrc}`;
    if (frame) {
      frame.removeAttribute('sandbox');
      frame.src = 'about:blank';
      requestAnimationFrame(() => {
        frame.src = `${src}${src.includes('?') ? '&' : '?'}_=${Date.now()}`;
      });
    }
    if (wrap) wrap.hidden = false;
    toggle.disabled = false;
    toggle.textContent = 'Đóng Live';
    if (badge) {
      badge.textContent = 'LIVE';
      badge.classList.add('on');
    }
  };

  const openLive = async () => {
    if (liveChromeOpen || starting) return;
    starting = true;
    toggle.disabled = true;
    toggle.textContent = 'Đang bật…';
    if (hintEl) hintEl.textContent = 'Đang bật x11vnc — đợi vài giây…';
    try {
      const res = await fetch('/api/chrome-live/start', {
        method: 'POST',
        credentials: 'same-origin',
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      setUiOpen();
      if (hintEl) {
        hintEl.textContent =
          'Live đang bật (x11vnc). Đóng Live khi không xem để tiết kiệm CPU.';
      }
    } catch (err) {
      setUiClosed();
      if (hintEl) {
        hintEl.textContent = `Không bật được Live: ${err.message || err}`;
      }
      throw err;
    } finally {
      starting = false;
    }
  };

  openLiveChromeFn = openLive;

  const closeLive = () => {
    if (!liveChromeOpen && !starting) return;
    setUiClosed();
    stopLiveBackend();
    if (hintEl) {
      hintEl.textContent =
        'Live tắt — tiết kiệm CPU. Bấm Mở Live khi cần xem/click Chrome.';
    }
  };

  try {
    const res = await fetch('/api/chrome-live');
    if (!res.ok) {
      panel.hidden = true;
      document.body.classList.remove('live-layout');
      return;
    }
    const data = await res.json();
    if (!data.enabled) {
      panel.hidden = true;
      document.body.classList.remove('live-layout');
      return;
    }
    panel.hidden = false;
    liveChromeSrc = data.iframeSrc || '/chrome-live/embed';
    if (hintEl) {
      hintEl.textContent =
        data.hint ||
        'Live mặc định tắt (tiết kiệm CPU). Bấm Mở Live khi cần xem/click Chrome.';
    }
    if (newTab) {
      newTab.hidden = false;
      newTab.href = '/chrome-live/';
      newTab.addEventListener('click', async (e) => {
        e.preventDefault();
        try {
          await fetch('/api/chrome-live/start', {
            method: 'POST',
            credentials: 'same-origin',
          });
        } catch {
          /* vẫn thử mở */
        }
        window.open('/chrome-live/', '_blank', 'noopener');
      });
    }
    // Mặc định ĐÓNG — user tự bật khi cần (không auto-open, không live-layout)
    setUiClosed();
  } catch {
    panel.hidden = true;
    document.body.classList.remove('live-layout');
    return;
  }

  toggle.onclick = () => {
    if (liveChromeOpen) closeLive();
    else openLive();
  };

  window.addEventListener('pagehide', () => {
    if (liveChromeOpen) stopLiveBackend();
  });
}

refreshMe().catch((err) => {
  console.error(err);
  showLoggedOut();
  loginError.textContent = err.message || 'Lỗi kết nối — F5 thử lại';
});
