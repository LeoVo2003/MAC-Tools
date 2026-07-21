const loginPanel = document.getElementById('loginPanel');
const loginForm = document.getElementById('loginForm');
const loginBtn = document.getElementById('loginBtn');
const loginStatus = document.getElementById('loginStatus');
const loginError = document.getElementById('loginError');
const cancelLoginBtn = document.getElementById('cancelLoginBtn');
const appMain = document.getElementById('appMain');
const userBar = document.getElementById('userBar');
const whoAmI = document.getElementById('whoAmI');
const logoutBtn = document.getElementById('logoutBtn');

const form = document.getElementById('jobForm');
const runBtn = document.getElementById('runBtn');
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

const wpmUsername = document.getElementById('wpmUsername');
const wpmPassword = document.getElementById('wpmPassword');
const saveWpmBtn = document.getElementById('saveWpmBtn');
const wpmCredStatus = document.getElementById('wpmCredStatus');
const wpmEnvPath = document.getElementById('wpmEnvPath');

const WPM_LS_KEY = 'fugt.wpm.v1';

let currentUser = null;
let currentJobId = null;
let eventSource = null;
const doneThisRun = new Set();

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

function readLocalWpm() {
  try {
    const raw = localStorage.getItem(WPM_LS_KEY);
    if (!raw) return { username: '', password: '' };
    const data = JSON.parse(raw);
    return {
      username: String(data.username || '').trim(),
      password: String(data.password || ''),
    };
  } catch {
    return { username: '', password: '' };
  }
}

function writeLocalWpm(username, password) {
  localStorage.setItem(
    WPM_LS_KEY,
    JSON.stringify({ username: String(username || '').trim(), password: String(password || '') })
  );
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
  if (result.accountExists) {
    outLogin.textContent = '';
    outLogin.removeAttribute('href');
    outDoc.textContent = '';
    outDoc.removeAttribute('href');
    outUser.textContent = result.notice || result.username || 'Đã tồn tại tài khoản trên web';
    outPass.textContent = '';
  } else {
    outLogin.textContent = result.loginUrl || '';
    outLogin.href = result.loginUrl || '#';
    outDoc.textContent = guide;
    outDoc.href = guide || '#';
    outUser.textContent = result.username || '';
    outPass.textContent = result.password || '';
  }
}

function applyRoleUi(user) {
  const isAdmin = user?.role === 'admin';
  document.querySelectorAll('[data-admin-only]').forEach((el) => {
    el.hidden = !isAdmin;
  });
  if (logoutBtn) {
    logoutBtn.hidden = !isAdmin;
    logoutBtn.textContent = isAdmin ? 'Về chế độ team' : 'Đăng xuất';
  }
  const reportsTab = document.querySelector('.tab[data-tab="reports"]');
  if (!isAdmin && reportsTab?.classList.contains('active')) {
    document.querySelector('.tab[data-tab="run"]')?.click();
  }
}

function showAdminLogin() {
  loginPanel.hidden = false;
  loginError.textContent = '';
  document.getElementById('loginUser')?.focus();
  loginPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function hideAdminLogin() {
  loginPanel.hidden = true;
  loginError.textContent = '';
}

function showApp(user) {
  currentUser = user;
  hideAdminLogin();
  appMain.hidden = false;
  userBar.hidden = false;
  const isAdmin = user.role === 'admin';
  whoAmI.textContent = isAdmin ? `${user.username} (admin)` : 'Team · không cần login';
  setBadge(loginStatus, 'done', isAdmin ? 'Admin' : 'Team');
  applyRoleUi(user);
  loadWpmCredentials();
  connectEvents();
}

async function enterGuestMode() {
  const res = await fetch('/api/guest', { method: 'POST' });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Không vào được chế độ team');
  showApp(data.user);
}

async function refreshMe() {
  const res = await fetch('/api/me');
  const data = await res.json();
  if (data.user) {
    showApp(data.user);
    return;
  }
  await enterGuestMode();
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

cancelLoginBtn?.addEventListener('click', hideAdminLogin);

logoutBtn.addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST' });
  await enterGuestMode();
});

/** Admin login: Ctrl+Shift+A */
window.addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.shiftKey && (e.key === 'A' || e.key === 'a')) {
    e.preventDefault();
    if (loginPanel.hidden) showAdminLogin();
    else hideAdminLogin();
  }
});

function loadWpmCredentials() {
  const local = readLocalWpm();
  if (local.username) wpmUsername.value = local.username;
  if (local.password) {
    wpmPassword.value = '';
    wpmPassword.placeholder = '•••••••• (đã lưu trên máy này — nhập mới nếu muốn đổi)';
  } else {
    wpmPassword.placeholder = '••••••••';
  }
  const ok = Boolean(local.username && local.password);
  setBadge(wpmCredStatus, ok ? 'done' : 'error', ok ? 'Đã lưu (máy này)' : 'Chưa lưu');
  wpmEnvPath.textContent = ok
    ? 'Đã lưu trên trình duyệt máy bạn.'
    : 'Điền WPM rồi bấm Lưu.';
}

saveWpmBtn.addEventListener('click', () => {
  const username = wpmUsername.value.trim();
  const password = wpmPassword.value;
  if (!username) {
    setBadge(wpmCredStatus, 'error', 'Thiếu user');
    return;
  }
  const local = readLocalWpm();
  const pass = password || local.password;
  if (!pass) {
    setBadge(wpmCredStatus, 'error', 'Nhập password');
    return;
  }
  writeLocalWpm(username, pass);
  wpmPassword.value = '';
  wpmPassword.placeholder = '•••••••• (đã lưu trên máy này — nhập mới nếu muốn đổi)';
  setBadge(wpmCredStatus, 'done', 'Đã lưu (máy này)');
  wpmEnvPath.textContent = 'Đã lưu WPM trên trình duyệt máy bạn.';
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
    clearStepStyles();
    doneThisRun.clear();
    queueHint.textContent = '';
    loadBackups();
  });
  eventSource.addEventListener('error', (e) => {
    try {
      const data = JSON.parse(e.data);
      appendLog(`❌ ${data.message}`);
      untickCompletedAfterError();
      setRunBadge('error', 'Error');
      runBtn.disabled = false;
      queueHint.textContent = '';
    } catch {
      /* SSE reconnect */
    }
  });
  eventSource.addEventListener('queue', (e) => {
    try {
      const q = JSON.parse(e.data);
      const max = q.maxConcurrent || 4;
      if (q.runningCount > 0 || q.pendingCount > 0) {
        queueHint.textContent = `Đang chạy ${q.runningCount || 0}/${max}${q.pendingCount ? ` · chờ ${q.pendingCount}` : ''}`;
      } else {
        queueHint.textContent = '';
      }
    } catch {
      /* ignore */
    }
  });
  eventSource.addEventListener('done', () => {
    runBtn.disabled = false;
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
  let s = stripApostrophes(raw).trim();
  s = s.replace(/\s+/g, '-');
  s = s.replace(/[^a-zA-Z0-9._\-@]/g, '');
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

form?.addEventListener('submit', async (e) => {
  e.preventDefault();
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

  const localWpm = readLocalWpm();
  const wpmUser = (wpmUsername.value.trim() || localWpm.username).trim();
  const wpmPass = wpmPassword.value || localWpm.password;
  if (!wpmUser || !wpmPass) {
    appendLog('❌ Chưa có WPM. Điền Username/Password WPM rồi bấm Lưu (lưu trên máy bạn).');
    setRunBadge('error', 'Error');
    return;
  }
  // Giữ pass trên form trống nhưng đã lưu local — đồng bộ username form vào local nếu đang nhập
  if (wpmUsername.value.trim() && wpmPassword.value) {
    writeLocalWpm(wpmUser, wpmPass);
  }

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
    wpmUsername: wpmUser,
    wpmPassword: wpmPass,
  };

  logBox.textContent = '';
  resultPanel.hidden = true;
  doneThisRun.clear();
  clearStepStyles();
  runBtn.disabled = true;
  setRunBadge('running', 'Running');

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
      return;
    }
    currentJobId = data.jobId;
    queueHint.textContent = data.message || '';
    connectEvents(data.jobId);
    if (data.position > 1) setRunBadge('running', `Queue #${data.position}`);
  } catch (err) {
    appendLog(`❌ ${err.message}`);
    setRunBadge('error', 'Error');
    runBtn.disabled = false;
  }
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
    if (tab === 'reports') loadReports();
    if (tab === 'backups') loadBackups();
  });
});

async function loadReports() {
  const res = await fetch('/api/runs?limit=100');
  if (!res.ok) return;
  const data = await res.json();
  document.getElementById('statTotal').textContent = data.stats?.total ?? 0;
  document.getElementById('statOk').textContent = data.stats?.success ?? 0;
  document.getElementById('statErr').textContent = data.stats?.error ?? 0;
  const tbody = document.querySelector('#runsTable tbody');
  tbody.innerHTML = '';
  for (const r of data.runs || []) {
    const tr = document.createElement('tr');
    const note =
      r.error ||
      r.resultSummary?.username ||
      (r.resultSummary?.accountExists ? 'account exists' : '');
    tr.innerHTML = `
      <td>${(r.startedAt || '').replace('T', ' ').slice(0, 19)}</td>
      <td>${r.toolUser || r.username || '—'}</td>
      <td class="mono">${r.websiteUrl || '—'}</td>
      <td><span class="badge ${r.status === 'success' ? 'done' : r.status === 'error' ? 'error' : 'running'}">${r.status}</span></td>
      <td>${String(note).slice(0, 80)}</td>`;
    tbody.appendChild(tr);
  }
}

document.getElementById('refreshReportsBtn')?.addEventListener('click', loadReports);

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

refreshMe().catch((err) => {
  console.error(err);
  appMain.hidden = false;
  whoAmI.textContent = 'Lỗi kết nối — F5 thử lại';
});
