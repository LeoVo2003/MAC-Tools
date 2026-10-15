const loginPanel = document.getElementById('loginPanel');
const loginForm = document.getElementById('loginForm');
const loginBtn = document.getElementById('loginBtn');
const loginStatus = document.getElementById('loginStatus');
const loginError = document.getElementById('loginError');
const appMain = document.getElementById('appMain');
const sidebar = document.getElementById('sidebar');
const whoAmI = document.getElementById('whoAmI');
const logoutBtn = document.getElementById('logoutBtn');
const pageTitle = document.getElementById('pageTitle');
const headerSub = document.getElementById('headerSub');

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

const kpiRunning = document.getElementById('kpiRunning');
const kpiWaiting = document.getElementById('kpiWaiting');
const kpiSteps = document.getElementById('kpiSteps');

function setKpi(el, text, active = false) {
  if (!el) return;
  el.textContent = String(text);
  el.closest('.kpi')?.classList.toggle('is-active', Boolean(active));
}

function updateStepsKpi() {
  const all = stepInputs();
  const picked = all.filter((el) => el.checked).length;
  setKpi(kpiSteps, `${picked}/${all.length}`);
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
  updateStepsKpi();
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
  updateStepsKpi();
  appendLog(`↳ Đã bỏ tick ${doneThisRun.size} bước xong — tick còn lại để Run tiếp.`);
}

stepsAllBtn?.addEventListener('click', () => setAllSteps(true));
stepsNoneBtn?.addEventListener('click', () => setAllSteps(false));
document.getElementById('stepsList')?.addEventListener('change', updateStepsKpi);
updateStepsKpi();

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
  // Admin vào Dashboard, user thường vào User Guide
  switchSection(isAdmin ? 'dashboard' : 'run');
  if (!isAdmin) {
    const mainRadio = form?.querySelector('input[name="webTargetMode"][value="main"]');
    if (mainRadio) mainRadio.checked = true;
  }
  updateWebTargetWarn();
}

const SECTION_TITLES = {
  dashboard: ['Dashboard', 'Theo dõi mọi tool, queue và lỗi.'],
  run: ['User Guide', 'F Package — Fill data, Run, Live Chrome trên một màn hình.'],
  qr: ['QR Tool', 'Tạo QR landing page tự động.'],
  reviewlink: ['Review Link', 'Tạo direct review link Google / Yelp.'],
  accounts: ['Tài khoản', 'Quản lý tài khoản tool.'],
};

function switchSection(tab) {
  document.querySelectorAll('.nav-item').forEach((b) => {
    b.classList.remove('is-active');
    b.removeAttribute('aria-current');
  });
  const activeNav = document.querySelector(`.nav-item[data-tab="${tab}"]`);
  activeNav?.classList.add('is-active');
  activeNav?.setAttribute('aria-current', 'page');
  for (const name of ['dashboard', 'run', 'qr', 'reviewlink', 'accounts']) {
    const el = document.getElementById(`tab-${name}`);
    if (el) el.hidden = name !== tab;
  }
  const [title, sub] = SECTION_TITLES[tab] || ['MAC Tools', ''];
  if (pageTitle) pageTitle.textContent = title;
  if (headerSub) headerSub.textContent = sub;
  syncLiveLayoutClass();
  if (tab === 'accounts') loadAccounts();
  if (tab === 'dashboard') loadDashboard();
}

function showLoggedOut() {
  currentUser = null;
  loginPanel.hidden = false;
  appMain.hidden = true;
  if (sidebar) sidebar.hidden = true;
  if (logoutBtn) logoutBtn.hidden = true;
  whoAmI.textContent = '';
  setBadge(loginStatus, 'idle', 'Guest');
  disconnectSocket();
}

function showApp(user) {
  currentUser = user;
  loginPanel.hidden = true;
  appMain.hidden = false;
  if (logoutBtn) logoutBtn.hidden = false;
  const isAdmin = user.role === 'admin';
  whoAmI.textContent = isAdmin ? `${user.username} (admin)` : user.username;
  setBadge(loginStatus, 'done', 'OK');
  if (sidebar) sidebar.hidden = false;
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
      reconnection: true,
      reconnectionAttempts: 20,
      reconnectionDelay: 1000,
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

    socket.on('screencast', (data) => {
      if (!data?.image) return;
      if (watchJobId && data.jobId && data.jobId !== watchJobId) return;
      applyLiveShot(data.image);
    });

    socket.on('result', (data) => {
      if (watchJobId && data.jobId && data.jobId !== watchJobId) return;
      clearLiveShots();
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
        clearLiveShots();
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
      clearLiveShots();
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
let liveChromeMode = 'snapshot'; // snapshot | screencast | novnc
let liveSnapshotMs = 1500;
let runSubmitting = false;
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
  const shot = document.getElementById('liveShot');
  const empty = document.getElementById('liveShotEmpty');
  const wrap = document.getElementById('liveChromeFrameWrap');
  if (!liveChromeOpen) return;
  if (wrap) wrap.hidden = false;
  if (liveChromeMode === 'novnc') {
    if (!frame) return;
    frame.hidden = false;
    frame.src = 'about:blank';
    const src = liveChromeSrc.startsWith('http')
      ? liveChromeSrc
      : `${window.location.origin}${liveChromeSrc || '/chrome-live/embed'}`;
    setTimeout(() => {
      if (!liveChromeOpen) return;
      frame.src = `${src}${src.includes('?') ? '&' : '?'}_=${Date.now()}`;
    }, 400);
    return;
  }
  if (shot) {
    shot.hidden = true;
    shot.removeAttribute('src');
  }
  if (empty) empty.hidden = false;
  if (frame) {
    frame.hidden = true;
    frame.src = 'about:blank';
  }
}

function applyLiveShot(imageB64) {
  if (!liveChromeOpen || !imageB64) return;
  if (liveChromeMode === 'novnc') return;
  const shot = document.getElementById('liveShot');
  const empty = document.getElementById('liveShotEmpty');
  if (!shot) return;
  shot.src = `data:image/jpeg;base64,${imageB64}`;
  shot.hidden = false;
  if (empty) empty.hidden = true;
}

/** Xóa ảnh Live khi job xong / lỗi / hủy */
function clearLiveShots() {
  if (liveChromeMode === 'novnc') return;
  const shot = document.getElementById('liveShot');
  const empty = document.getElementById('liveShotEmpty');
  if (shot) {
    shot.hidden = true;
    shot.removeAttribute('src');
  }
  if (empty && liveChromeOpen) empty.hidden = false;
}

form?.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (runSubmitting) {
    appendLog('⚠ Đang gửi Run rồi — bỏ qua lần bấm trùng.');
    return;
  }
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

  runSubmitting = true;
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
  } finally {
    runSubmitting = false;
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
  const btn = e.target.closest('[data-copy]');
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
function isRunTabActive() {
  const run = document.getElementById('tab-run');
  return Boolean(run && !run.hidden);
}

/** live-layout khóa scroll body — chỉ khi đang xem tab Job + Live mở. Báo cáo phải scroll được. */
function syncLiveLayoutClass() {
  if (liveChromeOpen && isRunTabActive()) {
    document.body.classList.add('live-layout');
  } else {
    document.body.classList.remove('live-layout');
  }
}

document.querySelectorAll('.nav-item').forEach((btn) => {
  btn.addEventListener('click', () => {
    switchSection(btn.getAttribute('data-tab'));
  });
});

async function loadAccounts() {
  const status = document.getElementById('accountsStatus');
  const tbody = document.querySelector('#accountsTable tbody');
  if (!tbody) return;
  if (status) {
    status.className = 'hint hint--muted';
    status.textContent = 'Đang tải...';
  }
  try {
    const res = await fetch('/api/users');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Không tải được danh sách.');
    const users = Array.isArray(data.users) ? data.users : [];
    tbody.innerHTML = users
      .map((u) => {
        const when = formatVnDateTime(u.updatedAt || u.createdAt) || '—';
        const stored = u.passwordStored
          ? '<span class="badge warn">Đã lưu</span>'
          : '<span class="badge idle">Chưa lưu</span>';
        return `<tr>
          <td class="mono">${escapeHtml(u.username)}</td>
          <td>${escapeHtml(u.role || 'user')}</td>
          <td>${stored}</td>
          <td class="muted">${escapeHtml(when)}</td>
          <td><button type="button" class="btn btn-danger btn-sm" data-reset-user="${escapeHtml(u.id)}" data-reset-name="${escapeHtml(u.username)}">Reset pass</button></td>
        </tr>`;
      })
      .join('');
    if (status) {
      status.className = 'hint hint--muted';
      status.textContent = users.length ? `${users.length} tài khoản` : 'Chưa có tài khoản.';
    }
  } catch (err) {
    if (status) {
      status.className = 'hint hint--error';
      status.textContent = err?.message || String(err);
    }
  }
}

document.getElementById('refreshAccountsBtn')?.addEventListener('click', () => loadAccounts());

document.getElementById('accountsTable')?.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-reset-user]');
  if (!btn) return;
  const id = btn.getAttribute('data-reset-user');
  const name = btn.getAttribute('data-reset-name') || 'user này';
  if (!id) return;
  const ok = window.confirm(
    `Reset password của ${name}?\nPass đã lưu sẽ bị xóa. User login lại bằng pass WPM đúng thì tool lưu lại.`
  );
  if (!ok) return;
  btn.disabled = true;
  const status = document.getElementById('accountsStatus');
  try {
    const res = await fetch(`/api/users/${encodeURIComponent(id)}/reset-password`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Reset thất bại.');
    if (status) {
      status.className = 'hint hint--ok';
      status.textContent = `Đã reset ${name}. Bảo user login lại bằng pass WPM đúng.`;
    }
    await loadAccounts();
  } catch (err) {
    if (status) {
      status.className = 'hint hint--error';
      status.textContent = err?.message || String(err);
    }
    btn.disabled = false;
  }
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
  const max = Number(q?.maxConcurrent) || 0;
  const runningNow = Number(q?.runningCount) || 0;
  const waitingNow = Number(q?.pendingCount) || 0;
  setKpi(kpiRunning, runningNow, runningNow > 0);
  setKpi(kpiWaiting, waitingNow, waitingNow > 0);
  if (q?.runningCount > 0 || q?.pendingCount > 0) {
    queueHint.textContent = `Đang chạy ${q.runningCount || 0}${max > 0 ? `/${max}` : ' job'}${q.pendingCount ? ` · chờ ${q.pendingCount}` : ''}`;
  } else {
    queueHint.textContent = '';
  }
  const box = document.getElementById('queueList');
  if (!box) return;
  const items = q?.queue || [];
  if (!items.length) {
    box.innerHTML = '<p class="empty">Chưa có job trong hàng đợi.</p>';
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
          <button type="button" class="btn btn-light btn-sm queue-cancel" data-id="${item.id}">Hủy</button>
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

function selectedRunIds() {
  return [...document.querySelectorAll('#runsTable tbody .run-check:checked')]
    .map((el) => el.value)
    .filter(Boolean);
}

function syncRunsDeleteBtn() {
  const btn = document.getElementById('deleteSelectedRunsBtn');
  const all = document.getElementById('runsSelectAll');
  const boxes = [...document.querySelectorAll('#runsTable tbody .run-check')];
  const n = selectedRunIds().length;
  if (btn) btn.disabled = n === 0;
  if (all) {
    all.checked = boxes.length > 0 && boxes.every((b) => b.checked);
    all.indeterminate = n > 0 && n < boxes.length;
  }
}

async function loadReports() {
  const res = await fetch(`/api/runs?${reportQuery()}`);
  if (!res.ok) return;
  const data = await res.json();
  document.getElementById('statTotal').textContent = data.stats?.total ?? 0;
  document.getElementById('statOk').textContent = data.stats?.success ?? 0;
  const avgEl = document.getElementById('statAvg');
  if (avgEl) avgEl.textContent = formatDuration(data.stats?.avgDurationMs);
  const tbody = document.querySelector('#runsTable tbody');
  tbody.innerHTML = '';
  const selectAll = document.getElementById('runsSelectAll');
  if (selectAll) {
    selectAll.checked = false;
    selectAll.indeterminate = false;
  }
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

    const tdCheck = document.createElement('td');
    tdCheck.className = 'col-check';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.className = 'run-check';
    cb.value = r.id || '';
    cb.disabled = !r.id;
    cb.addEventListener('change', syncRunsDeleteBtn);
    tdCheck.appendChild(cb);

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

    tr.append(tdCheck, tdTime, tdUser, tdUrl, tdDur, tdStatus, tdNote);
    tbody.appendChild(tr);
  }
  syncRunsDeleteBtn();
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
document.getElementById('runsSelectAll')?.addEventListener('change', (e) => {
  const on = Boolean(e.target?.checked);
  document.querySelectorAll('#runsTable tbody .run-check').forEach((cb) => {
    if (!cb.disabled) cb.checked = on;
  });
  syncRunsDeleteBtn();
});
document.getElementById('deleteSelectedRunsBtn')?.addEventListener('click', async () => {
  const ids = selectedRunIds();
  if (!ids.length) return;
  if (!confirm(`Xóa ${ids.length} bản ghi đã chọn? Không hoàn tác được.`)) return;
  try {
    const res = await fetch('/api/runs/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || res.statusText);
    await loadReports();
  } catch (err) {
    alert(err?.message || 'Xóa bản ghi thất bại.');
  }
});
document.getElementById('purgeFailedRunsBtn')?.addEventListener('click', async () => {
  if (!confirm('Xóa khỏi lịch sử mọi bản ghi error + cancelled? Không hoàn tác được.')) return;
  try {
    const res = await fetch('/api/runs/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ statuses: ['error', 'cancelled'] }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || res.statusText);
    await loadReports();
    alert(`Đã dọn ${data.deleted ?? 0} bản ghi lỗi/hủy.`);
  } catch (err) {
    alert(err?.message || 'Dọn lỗi/hủy thất bại.');
  }
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
  const shot = document.getElementById('liveShot');
  const empty = document.getElementById('liveShotEmpty');
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
    syncLiveLayoutClass();
    if (frame) {
      frame.src = 'about:blank';
      frame.hidden = true;
    }
    if (shot) {
      shot.hidden = true;
      shot.removeAttribute('src');
    }
    if (empty) empty.hidden = false;
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
    syncLiveLayoutClass();
    if (wrap) wrap.hidden = false;
    toggle.disabled = false;
    toggle.textContent = 'Đóng Live';
    if (badge) {
      badge.textContent = 'LIVE';
      badge.classList.add('on');
    }

    if (liveChromeMode === 'novnc') {
      if (shot) shot.hidden = true;
      if (empty) empty.hidden = true;
      if (frame) {
        frame.hidden = false;
        const src = liveChromeSrc.startsWith('http')
          ? liveChromeSrc
          : `${window.location.origin}${liveChromeSrc}`;
        frame.removeAttribute('sandbox');
        frame.src = 'about:blank';
        requestAnimationFrame(() => {
          frame.src = `${src}${src.includes('?') ? '&' : '?'}_=${Date.now()}`;
        });
      }
      return;
    }

    // snapshot / screencast
    if (frame) {
      frame.hidden = true;
      frame.src = 'about:blank';
    }
    if (shot) shot.hidden = true;
    if (empty) empty.hidden = false;
  };

  const openLive = async () => {
    if (liveChromeOpen || starting) return;
    starting = true;
    toggle.disabled = true;
    toggle.textContent = 'Đang bật…';
    if (hintEl) {
      hintEl.textContent =
        liveChromeMode === 'novnc'
          ? 'Đang bật x11vnc — đợi vài giây…'
          : 'Đang mở Live snapshot…';
    }
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
          liveChromeMode === 'novnc'
            ? 'Live đang bật (x11vnc). Đóng Live khi không xem để tiết kiệm CPU.'
            : 'Live theo Log: mỗi dòng log = 1 ảnh; màn hình hiện ảnh của dòng trước.';
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
        liveChromeMode === 'novnc'
          ? 'Live tắt — tiết kiệm CPU. Bấm Mở Live khi cần xem/click Chrome.'
          : 'Live tắt. Bấm Mở Live để xem ảnh snapshot khi Fill/Run.';
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
    liveChromeMode = data.mode || 'snapshot';
    liveSnapshotMs = Number(data.intervalMs) || 1500;
    liveChromeSrc = data.iframeSrc || '/chrome-live/embed';
    if (hintEl) {
      hintEl.textContent =
        data.hint ||
        'Live mặc định tắt. Snapshot = xem ảnh định kỳ khi Fill/Run.';
    }
    if (newTab) {
      const showNovncTab = liveChromeMode === 'novnc';
      newTab.hidden = !showNovncTab;
      if (showNovncTab) {
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
    }
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

/* ============ REVIEW LINK ============ */
const rlUrl = document.getElementById('rlUrl');
const rlBtn = document.getElementById('rlBtn');
const rlStatus = document.getElementById('rlStatus');
const rlError = document.getElementById('rlError');
const rlResult = document.getElementById('rlResult');

async function generateReviewLink() {
  const raw = (rlUrl?.value || '').trim();
  const urls = raw.split('\n').map((s) => s.trim()).filter(Boolean);
  const errBox = rlError;
  const resultsBox = document.getElementById('rlResults');
  if (errBox) errBox.textContent = '';
  if (resultsBox) resultsBox.innerHTML = '';
  if (!urls.length) {
    if (errBox) errBox.textContent = 'Paste ít nhất 1 Google Maps hoặc Yelp URL (mỗi dòng 1 link).';
    return;
  }
  setBadge(rlStatus, 'running', `Đang xử lý 0/${urls.length}`);
  rlBtn.disabled = true;
  let done = 0, okCount = 0;
  const cards = [];
  for (const url of urls) {
    try {
      const res = await fetch('/api/review-link?url=' + encodeURIComponent(url));
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || 'Không xử lý được link.');
      okCount++;
      cards.push(reviewLinkCard(data, url));
    } catch (err) {
      cards.push(`<div class="rl-result rl-result--error">
        <p class="err-msg">${escapeHtml(err.message)}</p>
        <p class="muted small">${escapeHtml(url.slice(0, 80))}</p>
      </div>`);
    }
    done++;
    setBadge(rlStatus, 'running', `Đang xử lý ${done}/${urls.length}`);
  }
  if (resultsBox) resultsBox.innerHTML = cards.join('');
  setBadge(rlStatus, okCount ? 'done' : 'error', `Xong ${okCount}/${urls.length}`);
  rlBtn.disabled = false;
}

function reviewLinkCard(data, srcUrl) {
  const platform = data.platform === 'google' ? 'Google' : 'Yelp';
  const platClass = data.platform === 'yelp' ? ' rl-result--yelp' : '';
  const icon = data.platform === 'google'
    ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" width="24" height="24"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/></svg>'
    : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" width="24" height="24"><path d="M12 2l2.4 7.2H22l-6 4.6 2.3 7.2-6.3-4.5-6.3 4.5L8 13.8 2 9.2h7.6z"/></svg>';
  const uid = 'rl' + Math.random().toString(36).slice(2, 8);
  return `<div class="rl-result${platClass}">
    <div class="rl-result-head">
      <span class="tool-card-icon">${icon}</span>
      <div>
        <p class="rl-platform">${platform}</p>
        <p class="muted small">Direct review link sẵn sàng</p>
      </div>
      <a class="btn btn-primary" target="_blank" rel="noopener" href="${escapeHtml(data.reviewUrl)}">Mở review form</a>
    </div>
    <dl class="kv">
      <dt>Place ID</dt><dd><code id="${uid}-id">${escapeHtml(data.id || '—')}</code> <button type="button" class="btn btn-light btn-sm" data-copy="${uid}-id">Copy</button></dd>
      <dt>Review link</dt><dd class="rl-link"><a id="${uid}-link" href="${escapeHtml(data.reviewUrl)}" target="_blank" rel="noopener">${escapeHtml(data.reviewUrl)}</a> <button type="button" class="btn btn-light btn-sm" data-copy="${uid}-link">Copy</button></dd>
    </dl>
  </div>`;
}

rlBtn?.addEventListener('click', generateReviewLink);
rlUrl?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') generateReviewLink();
});

/* ============ QR TOOL (shell — backend sau) ============ */
const qrForm = document.getElementById('qrForm');
const qrLogBox = document.getElementById('qrLogBox');
const qrStatusBadge = document.getElementById('qrStatusBadge');

function qrLog(line) {
  if (!qrLogBox) return;
  const div = document.createElement('div');
  div.textContent = line;
  qrLogBox.appendChild(div);
  qrLogBox.scrollTop = qrLogBox.scrollHeight;
}

/* Sync text hex <-> color picker */
function darkenHex(hex, pct) {
  const m = /^#([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  const f = (1 - pct / 100);
  const r = Math.round(((n >> 16) & 255) * f);
  const g = Math.round(((n >> 8) & 255) * f);
  const b = Math.round((n & 255) * f);
  return '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase();
}
function syncColorPair(textId, pickerId, onPrimaryChange) {
  const text = document.getElementById(textId);
  const picker = document.getElementById(pickerId);
  if (!text || !picker) return;
  picker.addEventListener('input', () => {
    text.value = picker.value.toUpperCase();
    text.dispatchEvent(new Event('input', { bubbles: true }));
  });
  text.addEventListener('input', () => {
    const v = text.value.trim();
    if (/^#[0-9a-fA-F]{6}$/.test(v)) {
      picker.value = v;
      onPrimaryChange?.(v);
    }
  });
}
// Màu phụ trống → preview = darken 50% từ màu chính
function refreshSecondaryPreview() {
  const primary = document.getElementById('qrPrimary')?.value.trim() || '';
  const secText = document.getElementById('qrSecondary');
  const secPicker = document.getElementById('qrSecondaryPicker');
  if (!secText || !secPicker) return;
  if (!secText.value.trim()) {
    const derived = darkenHex(primary, 50);
    if (derived) secPicker.value = derived;
  }
}
syncColorPair('qrPrimary', 'qrPrimaryPicker', () => refreshSecondaryPreview());
syncColorPair('qrSecondary', 'qrSecondaryPicker');
document.getElementById('qrSecondary')?.addEventListener('input', refreshSecondaryPreview);
refreshSecondaryPreview();

qrForm?.addEventListener('submit', async (e) => {
  e.preventDefault();
  qrLog('QR backend chưa code — form UI xong, job chạy sẽ làm tiếp.');
  setBadge(qrStatusBadge, 'warn', 'Chưa có backend');
});

/* ============ DASHBOARD ============ */
const TOOL_LABELS = {
  'f-package': 'F Package',
  'fill-data': 'Fill Data',
  'review-link': 'Review Link',
  'qr': 'QR Tool',
  'chrome-live': 'Chrome Live',
  'accounts': 'Tài khoản',
};
const TOOL_ICONS = {
  'f-package': '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>',
  'fill-data': '<path d="M12 3v12m0 0 4-4m-4 4-4-4"/><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/>',
  'review-link': '<path d="M10 13a5 5 0 0 0 7.07 0l2.83-2.83a5 5 0 0 0-7.07-7.07L11.5 4.5"/><path d="M14 11a5 5 0 0 0-7.07 0L4.1 13.83a5 5 0 0 0 7.07 7.07l1.33-1.33"/>',
  'qr': '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 14h3v3h-3z"/>',
  'chrome-live': '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3"/>',
  'accounts': '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/>',
};
function toolLabel(t) { return TOOL_LABELS[t] || t || '—'; }
function toolIcon(t) {
  const p = TOOL_ICONS[t] || TOOL_ICONS['f-package'];
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
}

const dashState = { range: '30d', page: 1, perPage: 20, tool: '', user: '', status: '', totalPages: 1 };

function dashRangeDates() {
  const now = new Date();
  const to = now.toISOString().slice(0, 10);
  let from = to;
  if (dashState.range === '7d') from = new Date(now - 6 * 864e5).toISOString().slice(0, 10);
  if (dashState.range === '30d') from = new Date(now - 29 * 864e5).toISOString().slice(0, 10);
  return { from, to };
}

function runStatusPill(status) {
  const map = { success: ['ok', 'Thành công'], error: ['err', 'Lỗi'], cancelled: ['warn', 'Đã hủy'], running: ['run', 'Đang chạy'] };
  const [cls, label] = map[status] || ['muted', status || '—'];
  return `<span class="pill pill--${cls}">${label}</span>`;
}

function fmtDur(ms) {
  if (ms == null || !Number.isFinite(Number(ms))) return '—';
  const s = Math.round(Number(ms) / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}p${s % 60 ? ` ${s % 60}s` : ''}`;
  return `${Math.floor(m / 60)}h ${m % 60}p`;
}
function fmtTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

async function loadDashboard() {
  const { from, to } = dashRangeDates();
  try {
    const [statsRes, errRes, queueRes] = await Promise.all([
      fetch(`/api/runs/stats?from=${from}&to=${to}&groupBy=tool`, { credentials: 'same-origin' }),
      fetch('/api/runs/errors?top=8', { credentials: 'same-origin' }),
      fetch('/api/queue', { credentials: 'same-origin' }).catch(() => null),
    ]);
    const stats = await statsRes.json();
    const errData = await errRes.json();
    let queued = 0;
    try { const q = await queueRes?.json(); queued = q?.pendingCount || q?.queue?.length || 0; } catch {}

    // KPIs
    const s = stats.stats || {};
    document.getElementById('dashTotal').textContent = s.total ?? 0;
    const rate = s.total ? Math.round((s.success / s.total) * 100) : 0;
    document.getElementById('dashSuccessRate').textContent = `${rate}%`;
    document.getElementById('dashRunning').textContent = s.running ?? 0;
    document.getElementById('dashQueued').textContent = queued;
    document.getElementById('dashAvg').textContent = fmtDur(s.avgDurationMs);

    // Tool cards — chỉ 3 category chính
    const toolsBox = document.getElementById('dashTools');
    const byTool = (stats.byTool || []).filter((t) => ['f-package', 'qr', 'review-link'].includes(t.tool));
    if (!byTool.length) {
      toolsBox.innerHTML = '<p class="empty">Chưa có lượt chạy nào trong khoảng này.</p>';
    } else {
      toolsBox.innerHTML = byTool.map((t) => {
        const errRate = t.total ? Math.round((t.error / t.total) * 100) : 0;
        const active = dashState.tool === t.tool ? ' is-active' : '';
        return `<button type="button" class="tool-card${active}" data-tool="${t.tool}">
          <span class="tool-card-icon">${toolIcon(t.tool)}</span>
          <span class="tool-card-name">${toolLabel(t.tool)}</span>
          <span class="tool-card-num">${t.total}</span>
          <span class="tool-card-meta">Lỗi ${errRate}% · ${t.lastRunAt ? fmtTime(t.lastRunAt) : '—'}</span>
        </button>`;
      }).join('');
    }

    // Errors
    const errBox = document.getElementById('dashErrors');
    const errors = errData.errors || [];
    errBox.innerHTML = errors.length
      ? errors.map((e) => `<div class="err-row">
          <span class="err-count">${e.count}×</span>
          <div><p class="err-msg">${escapeHtml(e.error)}</p>
          <p class="muted small">${toolLabel(e.tool)} · ${fmtTime(e.lastAt)}</p></div>
        </div>`).join('')
      : '<p class="empty">Không có lỗi nào. Sạch!</p>';

    loadDashTable();
    loadDashHealth();
  } catch (err) {
    document.getElementById('dashTools').innerHTML = `<p class="empty">Lỗi tải dashboard: ${escapeHtml(err.message)}</p>`;
  }
}

async function loadDashTable() {
  const tbody = document.querySelector('#dashTable tbody');
  tbody.innerHTML = '<tr><td colspan="8" class="empty">Đang tải…</td></tr>';
  const params = new URLSearchParams({
    limit: 500, tool: dashState.tool, user: dashState.user, status: dashState.status,
  });
  try {
    const res = await fetch(`/api/runs?${params}`, { credentials: 'same-origin' });
    const data = await res.json();
    const runs = data.runs || [];
    dashState.totalPages = Math.max(1, Math.ceil(runs.length / dashState.perPage));
    if (dashState.page > dashState.totalPages) dashState.page = dashState.totalPages;
    const start = (dashState.page - 1) * dashState.perPage;
    const page = runs.slice(start, start + dashState.perPage);
    const isAdmin = currentUser?.role === 'admin';
    tbody.innerHTML = page.length ? page.map((r) => `<tr data-run-id="${r.id}" class="run-row">
        ${isAdmin ? `<td><input type="checkbox" class="dash-run-check" value="${r.id}" aria-label="Chọn" /></td>` : ''}
        <td class="nowrap">${fmtTime(r.startedAt)}</td>
        <td><span class="tool-tag">${toolIcon(r.tool)}${toolLabel(r.tool)}</span></td>
        <td>${escapeHtml(r.toolUser || r.username || '—')}</td>
        <td class="url-cell">${r.websiteUrl ? `<a href="${escapeHtml(r.websiteUrl)}" target="_blank" rel="noopener">${escapeHtml(shortUrl(r.websiteUrl))}</a>` : '—'}</td>
        <td>${runStatusPill(r.status)}</td>
        <td class="nowrap">${fmtDur(r.durationMs)}</td>
        <td><button type="button" class="btn btn-ghost btn-xs dash-detail" data-id="${r.id}">Chi tiết</button></td>
      </tr>`).join('')
      : '<tr><td colspan="8" class="empty">Không có lượt chạy nào.</td></tr>';
    document.getElementById('dashPageInfo').textContent = `Trang ${dashState.page}/${dashState.totalPages} · ${runs.length} dòng`;
    document.getElementById('dashPrev').disabled = dashState.page <= 1;
    document.getElementById('dashNext').disabled = dashState.page >= dashState.totalPages;
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="8" class="empty">Lỗi: ${escapeHtml(err.message)}</td></tr>`;
  }
}
function shortUrl(u) {
  try { const x = new URL(u); return x.hostname.replace(/^www\./, ''); } catch { return String(u).slice(0, 30); }
}

async function loadDashHealth() {
  const box = document.getElementById('dashHealth');
  try {
    const res = await fetch('/api/health', { credentials: 'same-origin' });
    const h = await res.json();
    const rows = [
      ['Trạng thái', h.ok ? 'OK' : 'Lỗi'],
      ['Uptime', h.uptime ? fmtDur(h.uptime * 1000) : '—'],
      ['Chrome sessions', h.chromeSessions ?? h.sessions ?? '—'],
      ['Queue', h.queueLength ?? h.pending ?? '—'],
    ];
    box.innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${escapeHtml(String(v))}</dd>`).join('');
  } catch (err) {
    box.innerHTML = `<dt>Lỗi</dt><dd>${escapeHtml(err.message)}</dd>`;
  }
}

/* Drawer chi tiết */
function openRunDrawer(runId) {
  const drawer = document.getElementById('runDrawer');
  const backdrop = document.getElementById('runDrawerBackdrop');
  const body = document.getElementById('runDrawerBody');
  drawer.hidden = false; backdrop.hidden = false;
  body.innerHTML = '<p class="empty">Đang tải…</p>';
  fetch(`/api/runs?limit=2000`, { credentials: 'same-origin' })
    .then((r) => r.json())
    .then((data) => {
      const run = (data.runs || []).find((x) => x.id === runId);
      if (!run) { body.innerHTML = '<p class="empty">Không tìm thấy.</p>'; return; }
      const steps = Array.isArray(run.stepResults) ? run.stepResults : [];
      body.innerHTML = `
        <dl class="kv">
          <dt>Tool</dt><dd>${toolLabel(run.tool)}</dd>
          <dt>User</dt><dd>${escapeHtml(run.toolUser || run.username || '—')}</dd>
          <dt>Bắt đầu</dt><dd>${fmtTime(run.startedAt)}</dd>
          <dt>Kết thúc</dt><dd>${fmtTime(run.finishedAt)}</dd>
          <dt>Thời lượng</dt><dd>${fmtDur(run.durationMs)}</dd>
          <dt>Trạng thái</dt><dd>${runStatusPill(run.status)}</dd>
          <dt>Website</dt><dd>${run.websiteUrl ? `<a href="${escapeHtml(run.websiteUrl)}" target="_blank" rel="noopener">${escapeHtml(run.websiteUrl)}</a>` : '—'}</dd>
          ${run.error ? `<dt>Lỗi</dt><dd class="err-msg">${escapeHtml(run.error)}</dd>` : ''}
        </dl>
        ${steps.length ? `<h3>Các bước (${steps.length})</h3>
        <table class="steps-table"><thead><tr><th>Bước</th><th>Trạng thái</th><th>Thời lượng</th></tr></thead>
        <tbody>${steps.map((s) => `<tr><td>${escapeHtml(s.step)}</td><td>${runStatusPill(s.status)}</td><td>${fmtDur(s.durationMs)}</td></tr>`).join('')}</tbody></table>` : ''}
        ${run.resultSummary ? `<h3>Kết quả</h3><dl class="kv">
          ${run.resultSummary.project ? `<dt>Project</dt><dd>${escapeHtml(run.resultSummary.project)}</dd>` : ''}
          ${run.resultSummary.username ? `<dt>Username</dt><dd>${escapeHtml(run.resultSummary.username)}</dd>` : ''}
          ${run.resultSummary.loginUrl ? `<dt>Login URL</dt><dd><a href="${escapeHtml(run.resultSummary.loginUrl)}" target="_blank" rel="noopener">Mở</a></dd>` : ''}
        </dl>` : ''}`;
    })
    .catch((err) => { body.innerHTML = `<p class="empty">Lỗi: ${escapeHtml(err.message)}</p>`; });
}
function closeRunDrawer() {
  document.getElementById('runDrawer').hidden = true;
  document.getElementById('runDrawerBackdrop').hidden = true;
}

/* Dashboard events */
document.querySelectorAll('.seg-btn').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('.seg-btn').forEach((x) => x.classList.remove('is-active'));
  b.classList.add('is-active');
  dashState.range = b.dataset.range;
  dashState.page = 1;
  loadDashboard();
}));
document.getElementById('dashRefresh')?.addEventListener('click', loadDashboard);
document.getElementById('dashHealthBtn')?.addEventListener('click', loadDashHealth);
document.getElementById('dashTools')?.addEventListener('click', (e) => {
  const card = e.target.closest('.tool-card');
  if (!card) return;
  dashState.tool = dashState.tool === card.dataset.tool ? '' : card.dataset.tool;
  document.getElementById('dashFilterTool').value = dashState.tool;
  dashState.page = 1;
  loadDashboard();
});
['dashFilterTool', 'dashFilterUser', 'dashFilterStatus'].forEach((id) => {
  document.getElementById(id)?.addEventListener('change', (e) => {
    dashState.tool = document.getElementById('dashFilterTool').value;
    dashState.user = document.getElementById('dashFilterUser').value.trim();
    dashState.status = document.getElementById('dashFilterStatus').value;
    dashState.page = 1;
    loadDashTable();
    // sync tool cards highlight
    document.querySelectorAll('.tool-card').forEach((c) => c.classList.toggle('is-active', c.dataset.tool === dashState.tool));
  });
});
document.getElementById('dashFilterUser')?.addEventListener('input', (e) => {
  clearTimeout(window.__dashUserT);
  window.__dashUserT = setTimeout(() => {
    dashState.user = e.target.value.trim();
    dashState.page = 1;
    loadDashTable();
  }, 400);
});
document.getElementById('dashPrev')?.addEventListener('click', () => { if (dashState.page > 1) { dashState.page--; loadDashTable(); } });
document.getElementById('dashNext')?.addEventListener('click', () => { if (dashState.page < dashState.totalPages) { dashState.page++; loadDashTable(); } });
document.getElementById('dashExportCsv')?.addEventListener('click', () => {
  const params = new URLSearchParams({ limit: 2000, tool: dashState.tool, user: dashState.user, status: dashState.status });
  window.open(`/api/runs.csv?${params}`, '_blank');
});
document.getElementById('dashTable')?.addEventListener('click', (e) => {
  const btn = e.target.closest('.dash-detail');
  if (btn) { openRunDrawer(btn.dataset.id); return; }
  const row = e.target.closest('.run-row');
  if (row && !e.target.closest('a,button,input')) openRunDrawer(row.dataset.runId);
});
document.getElementById('runDrawerClose')?.addEventListener('click', closeRunDrawer);
document.getElementById('runDrawerBackdrop')?.addEventListener('click', closeRunDrawer);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeRunDrawer(); });

/* Admin: xóa đã chọn + dọn */
document.getElementById('dashSelectAll')?.addEventListener('change', (e) => {
  document.querySelectorAll('.dash-run-check').forEach((c) => { c.checked = e.target.checked; });
  syncDashDeleteBtn();
});
document.getElementById('dashTable')?.addEventListener('change', (e) => {
  if (e.target.classList.contains('dash-run-check')) syncDashDeleteBtn();
});
function syncDashDeleteBtn() {
  const n = document.querySelectorAll('.dash-run-check:checked').length;
  const btn = document.getElementById('dashDeleteSel');
  if (btn) { btn.disabled = !n; btn.textContent = n ? `Xóa đã chọn (${n})` : 'Xóa đã chọn'; }
}
document.getElementById('dashDeleteSel')?.addEventListener('click', async () => {
  const ids = [...document.querySelectorAll('.dash-run-check:checked')].map((c) => c.value);
  if (!ids.length || !confirm(`Xóa ${ids.length} dòng?`)) return;
  const res = await fetch('/api/runs/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids }), credentials: 'same-origin' });
  const data = await res.json();
  alert(data.ok ? `Đã xóa ${data.deleted} dòng.` : (data.error || 'Lỗi'));
  loadDashboard();
});
document.getElementById('dashPurge')?.addEventListener('click', async () => {
  if (!confirm('Dọn tất cả dòng lỗi & đã hủy?')) return;
  const res = await fetch('/api/runs/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ statuses: ['error', 'cancelled'] }), credentials: 'same-origin' });
  const data = await res.json();
  alert(data.ok ? `Đã dọn ${data.deleted} dòng.` : (data.error || 'Lỗi'));
  loadDashboard();
});
