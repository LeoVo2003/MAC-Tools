const form = document.getElementById('jobForm');
const runBtn = document.getElementById('runBtn');
const logBox = document.getElementById('logBox');
const statusBadge = document.getElementById('statusBadge');
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

/** Bước đã hoàn thành trong lần chạy hiện tại — lỗi thì tự bỏ tick */
const doneThisRun = new Set();

function stepInputs() {
  return [...document.querySelectorAll('input[name="step"]')];
}

function getSelectedSteps() {
  return stepInputs()
    .filter((el) => el.checked)
    .map((el) => el.value);
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

/** Lỗi → bỏ tick các bước đã xong, giữ tick phần còn lại để Run lại. */
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
  appendLog(
    `↳ Đã bỏ tick ${doneThisRun.size} bước xong — tick còn lại để Run tiếp.`
  );
}

stepsAllBtn.addEventListener('click', () => setAllSteps(true));
stepsNoneBtn.addEventListener('click', () => setAllSteps(false));

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

async function loadWpmCredentials() {
  try {
    const res = await fetch('/api/wpm-credentials');
    const data = await res.json();
    if (data.username) wpmUsername.value = data.username;
    if (data.hasPassword) {
      wpmPassword.placeholder = '•••••••• (đã lưu — nhập mới nếu muốn đổi)';
      wpmPassword.value = '';
    }
    wpmEnvPath.textContent = data.envPath ? `File: ${data.envPath}` : '';
    if (data.configured) {
      setBadge(wpmCredStatus, 'done', 'Đã lưu');
    } else {
      setBadge(wpmCredStatus, 'error', 'Chưa lưu');
    }
  } catch (err) {
    setBadge(wpmCredStatus, 'error', 'Lỗi tải');
    wpmEnvPath.textContent = err.message;
  }
}

saveWpmBtn.addEventListener('click', async () => {
  const username = wpmUsername.value.trim();
  let password = wpmPassword.value;
  if (!username) {
    setBadge(wpmCredStatus, 'error', 'Thiếu user');
    return;
  }
  if (!password) {
    setBadge(wpmCredStatus, 'error', 'Nhập password');
    return;
  }

  saveWpmBtn.disabled = true;
  try {
    const res = await fetch('/api/wpm-credentials', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const data = await res.json();
    if (!res.ok) {
      setBadge(wpmCredStatus, 'error', 'Lỗi');
      wpmEnvPath.textContent = data.error || res.statusText;
      return;
    }
    wpmPassword.value = '';
    wpmPassword.placeholder = '•••••••• (đã lưu — nhập mới nếu muốn đổi)';
    setBadge(wpmCredStatus, 'done', 'Đã lưu');
    wpmEnvPath.textContent = data.message || data.envPath;
  } catch (err) {
    setBadge(wpmCredStatus, 'error', 'Lỗi');
    wpmEnvPath.textContent = err.message;
  } finally {
    saveWpmBtn.disabled = false;
  }
});

function connectEvents() {
  const es = new EventSource('/api/events');
  es.addEventListener('log', (e) => {
    const data = JSON.parse(e.data);
    appendLog(data.line);
  });
  es.addEventListener('step', (e) => {
    const data = JSON.parse(e.data);
    if (data?.id && data?.status) markStepUi(data.id, data.status);
  });
  es.addEventListener('result', (e) => {
    const data = JSON.parse(e.data);
    showResult(data);
    setRunBadge('done', 'Done');
    runBtn.disabled = false;
    clearStepStyles();
    doneThisRun.clear();
  });
  es.addEventListener('error', (e) => {
    try {
      const data = JSON.parse(e.data);
      appendLog(`❌ ${data.message}`);
      untickCompletedAfterError();
      setRunBadge('error', 'Error');
      runBtn.disabled = false;
    } catch {
      /* SSE reconnect noise — không phải lỗi job */
    }
  });
  es.addEventListener('done', () => {
    runBtn.disabled = false;
  });
  return es;
}

connectEvents();
loadWpmCredentials();

/** Thêm /edit sau /projects/{id} nếu thiếu. */
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

/** Bỏ dấu nháy ' trong username/password (tia's → tias). */
function stripApostrophes(raw) {
  return String(raw ?? '').replace(/[''`´′’‘]/g, '');
}

function sanitizeWpUsername(raw) {
  let s = stripApostrophes(raw).trim();
  s = s.replace(/\s+/g, '-');
  s = s.replace(/[^a-zA-Z0-9._\-@]/g, '');
  s = s.replace(/-+/g, '-').replace(/^\-+|\-+$/g, '');
  return s;
}

function sanitizeCustomerPassword(raw) {
  return stripApostrophes(raw);
}

const projectUrlInput = form.querySelector('[name="wpmProjectUrl"]');
projectUrlInput?.addEventListener('blur', () => {
  const next = normalizeWpmProjectUrl(projectUrlInput.value);
  if (next) projectUrlInput.value = next;
});

for (const name of ['username', 'password']) {
  const el = form.querySelector(`[name="${name}"]`);
  if (!el) continue;
  const apply = () => {
    const next =
      name === 'username'
        ? sanitizeWpUsername(el.value)
        : sanitizeCustomerPassword(el.value);
    if (next !== el.value) el.value = next;
  };
  el.addEventListener('blur', apply);
  el.addEventListener('change', apply);
}

form.addEventListener('submit', async (e) => {
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
    }
  } catch (err) {
    appendLog(`❌ ${err.message}`);
    setRunBadge('error', 'Error');
    runBtn.disabled = false;
  }
});

copyBtn.addEventListener('click', async () => {
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

async function copyText(text, btn) {
  const val = String(text || '').trim();
  if (!val) return;
  await navigator.clipboard.writeText(val);
  if (!btn) return;
  btn.classList.add('copied');
  const prev = btn.getAttribute('title') || 'Copy';
  btn.setAttribute('title', 'Đã copy');
  setTimeout(() => {
    btn.classList.remove('copied');
    btn.setAttribute('title', prev === 'Đã copy' ? 'Copy' : prev);
  }, 1200);
}

resultPanel.addEventListener('click', async (e) => {
  const btn = e.target.closest('.copy-one');
  if (!btn || !resultPanel.contains(btn)) return;
  const id = btn.getAttribute('data-copy');
  const el = id ? document.getElementById(id) : null;
  if (!el) return;
  await copyText(el.textContent, btn);
});
