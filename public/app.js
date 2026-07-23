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
let eventSource = null;
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
    appendLog(`⏹ Đã gửi hủy job ${id.slice(0, 8)}… (${data.kind})`);
    setRunBadge('error', 'Cancelling…');
    refreshQueue();
  } catch (err) {
    appendLog(`❌ Hủy job: ${err.message}`);
    if (cancelBtn) cancelBtn.disabled = false;
  }
}

function setBadge(el, mode, text) {
  el.className = `badge ${mode}`;
  el.textContent = text;
}

function setRunBadge(mode, text) {
  setBadge(statusBadge, mode, text);
}

function appendLog(line) {
  logBox.textContent += (logBox.textContent ? '\n' : '') + line;
  logBox.scrollTop = logBox.scrollHeight;
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
  const reportsTab = document.querySelector('.tab[data-tab="reports"]');
  if (!isAdmin && reportsTab?.classList.contains('active')) {
    document.querySelector('.tab[data-tab="run"]')?.click();
  }
  if (!isAdmin) {
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
  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }
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

function connectEvents(jobId) {
  if (eventSource) eventSource.close();
  const q = jobId ? `?jobId=${encodeURIComponent(jobId)}` : '';
  eventSource = new EventSource(`/api/events${q}`);
  eventSource.addEventListener('log', (e) => {
    const data = JSON.parse(e.data);
    if (jobId && data.jobId && data.jobId !== jobId) return;
    appendLog(data.line);
  });
  eventSource.addEventListener('step', (e) => {
    const data = JSON.parse(e.data);
    if (data?.id && data?.status) markStepUi(data.id, data.status);
  });
  eventSource.addEventListener('result', (e) => {
    const data = JSON.parse(e.data);
    showResult(data);
    setRunBadge('done', 'Done');
    runBtn.disabled = false;
    setCancelVisible(false);
    currentJobId = null;
    if (resumeBtn) resumeBtn.hidden = true;
    clearStepStyles();
    doneThisRun.clear();
    queueHint.textContent = '';
    loadBackups();
    refreshQueue();
  });
  eventSource.addEventListener('error', (e) => {
    try {
      const data = JSON.parse(e.data);
      const cancelled = Boolean(data.cancelled) || /đã bị hủy|hủy bởi/i.test(data.message || '');
      appendLog(cancelled ? `⏹ ${data.message}` : `❌ ${data.message}`);
      if (!cancelled) untickCompletedAfterError();
      setRunBadge(cancelled ? 'idle' : 'error', cancelled ? 'Cancelled' : 'Error');
      runBtn.disabled = false;
      setCancelVisible(false);
      currentJobId = null;
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
      /* SSE reconnect */
    }
  });
  eventSource.addEventListener('queue', (e) => {
    try {
      const q = JSON.parse(e.data);
      renderQueue(q);
    } catch {
      /* ignore */
    }
  });
  eventSource.addEventListener('done', () => {
    runBtn.disabled = false;
    setCancelVisible(false);
  });
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
      const ok = f.ok !== false && f.value;
      const label = k === 'websiteUrl' ? 'Website' : k;
      return `<span class="fill-chip ${ok ? 'ok' : 'bad'}" title="${f.hint || ''}">${label}: ${ok ? 'OK' : 'thiếu — sửa tay'}</span>`;
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
    fillDataHint.style.color = 'var(--danger)';
    return;
  }

  const webTargetMode = getWebTargetMode();
  const websiteUrl = (websiteInput?.value || '').trim();
  if (webTargetMode === 'website' && !websiteUrl) {
    fillDataHint.textContent = 'Mode Website: điền ô Website (subdomain) trước rồi Fill.';
    fillDataHint.style.color = 'var(--danger)';
    markFieldWarn('websiteUrl', true);
    return;
  }

  fillDataBtn.disabled = true;
  runBtn.disabled = true;
  fillDataHint.style.color = 'var(--muted)';
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
      fillDataHint.style.color = 'var(--danger)';
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
      fillDataHint.style.color = 'var(--warn)';
      setRunBadge('error', 'Sửa tay');
    } else if (warns.length) {
      fillDataHint.textContent = `Đã fill — ${warns.length} cảnh báo (xem Log). Có thể Run.`;
      fillDataHint.style.color = 'var(--warn)';
      setRunBadge('done', 'Filled');
    } else {
      fillDataHint.textContent = 'Đã fill xong — kiểm tra rồi bấm Run.';
      fillDataHint.style.color = 'var(--accent)';
      setRunBadge('done', 'Filled');
    }
    appendLog('=== Fill data xong ===');
  } catch (err) {
    appendLog(`❌ ${err.message}`);
    fillDataHint.textContent = err.message;
    fillDataHint.style.color = 'var(--danger)';
    setRunBadge('error', 'Error');
  } finally {
    fillDataBtn.disabled = false;
    runBtn.disabled = false;
  }
});

let pendingResume = false;
let liveChromeOpen = false;
let liveChromeSrc = '';

resumeBtn?.addEventListener('click', () => {
  appendLog('↳ Resume = chạy tiếp trên Chrome đang mở (không clear Live).');
  pendingResume = true;
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
    downloadBackup: fd.get('downloadBackup') === 'on',
    packageTier: 'F',
    steps,
    webTargetMode: getWebTargetMode(),
    resume: isResume,
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
    connectEvents(data.jobId);
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
    document.getElementById('tab-reports').hidden = tab !== 'reports';
    document.getElementById('tab-backups').hidden = tab !== 'backups';
    if (tab === 'reports') {
      loadReports();
      loadHealth();
    }
    if (tab === 'backups') loadBackups();
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
    row.innerHTML = `
      <div>
        <strong>${item.status === 'running' ? '▶ Running' : `#${item.position || '?'} Waiting`}</strong>
        · ${item.user || '—'}
        <div class="meta">${short}… ${item.startedAt ? item.startedAt.replace('T', ' ').slice(0, 19) : ''}</div>
      </div>
      <button type="button" class="secondary tiny queue-cancel" data-id="${item.id}">Hủy</button>`;
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
    const started = (r.startedAt || '').replace('T', ' ').slice(0, 19);
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

async function loadBackups() {
  const box = document.getElementById('backupsList');
  box.innerHTML = '<p class="hint">Đang tải…</p>';
  try {
    const res = await fetch('/api/backups');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || res.statusText);
    if (!data.folders?.length) {
      box.innerHTML = '<p class="hint">Chưa có folder backup.</p>';
      return;
    }
    box.innerHTML = '';
    for (const folder of data.folders) {
      const details = document.createElement('details');
      details.className = 'backup-folder';
      details.innerHTML = `<summary><strong>${folder.name}</strong> <span class="hint">(${folder.fileCount} files · ${folder.mtime?.slice(0, 19) || ''})</span></summary><div class="backup-files" data-name="${folder.name}">Loading…</div>`;
      box.appendChild(details);
      details.addEventListener('toggle', async () => {
        if (!details.open) return;
        const filesBox = details.querySelector('.backup-files');
        if (filesBox.dataset.loaded) return;
        const fr = await fetch(`/api/backups/${encodeURIComponent(folder.name)}/files`);
        const fd = await fr.json();
        filesBox.innerHTML = '';
        for (const f of fd.files || []) {
          const a = document.createElement('a');
          a.href = `/api/backups/${encodeURIComponent(folder.name)}/file?f=${encodeURIComponent(f.name)}`;
          a.textContent = `${f.name} (${Math.round((f.size || 0) / 1024)} KB)`;
          a.className = 'backup-file-link';
          filesBox.appendChild(a);
        }
        filesBox.dataset.loaded = '1';
      });
    }
  } catch (err) {
    box.innerHTML = `<p class="hint" style="color:var(--danger)">${err.message}</p>`;
  }
}

document.getElementById('refreshBackupsBtn')?.addEventListener('click', loadBackups);

async function setupLiveChrome() {
  const panel = document.getElementById('liveChromePanel');
  const toggle = document.getElementById('liveChromeToggle');
  const badge = document.getElementById('liveChromeBadge');
  const wrap = document.getElementById('liveChromeFrameWrap');
  const frame = document.getElementById('liveChromeFrame');
  const newTab = document.getElementById('liveChromeNewTab');
  if (!panel || !toggle) return;

  const openLive = () => {
    if (liveChromeOpen) return;
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
    toggle.textContent = 'Đóng Live';
    if (badge) {
      badge.textContent = 'LIVE';
      badge.classList.add('on');
    }
  };

  const closeLive = () => {
    liveChromeOpen = false;
    document.body.classList.remove('live-layout');
    if (frame) frame.src = 'about:blank';
    if (wrap) wrap.hidden = true;
    toggle.textContent = 'Mở Live';
    if (badge) {
      badge.textContent = 'OFF';
      badge.classList.remove('on');
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
    const hintEl = panel.querySelector('.live-chrome-hint');
    if (hintEl && data.hint) hintEl.textContent = data.hint;
    if (newTab) {
      newTab.hidden = false;
      newTab.href = '/chrome-live/';
    }
    // Layout ngang + tự mở Live khi có CHROME_LIVE
    document.body.classList.add('live-layout');
    openLive();
  } catch {
    panel.hidden = true;
    document.body.classList.remove('live-layout');
    return;
  }

  toggle.onclick = () => {
    if (liveChromeOpen) closeLive();
    else openLive();
  };
}

refreshMe().catch((err) => {
  console.error(err);
  showLoggedOut();
  loginError.textContent = err.message || 'Lỗi kết nối — F5 thử lại';
});
