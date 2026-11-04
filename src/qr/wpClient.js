/**
 * WordPress REST API client cho QR Tool (QR_WP_BASE).
 * Auth: Application Password qua Basic Auth (từ env QR_WP_*).
 * Hỗ trợ site tắt pretty /wp-json (vd. quan test) → fallback ?rest_route=.
 */

// Đọc env lazy (dotenv.config chạy sau khi modules load)
/** Base URL của WP (để build page URL khi REST không trả link) */
export function getWpBase() {
  return (process.env.QR_WP_BASE || 'https://qr.macmarketing.us').replace(/\/$/, '');
}
function getWpUser() { return process.env.QR_WP_USER || ''; }
function getWpAppPassword() { return process.env.QR_WP_APP_PASSWORD || ''; }

// Override từ form (nếu user nhập tay)
let overrideUser = '', overridePass = '';
export function setWpCredentials(user, pass) {
  overrideUser = String(user || '').trim();
  overridePass = String(pass || '').trim();
}
export function clearWpCredentials() { overrideUser = ''; overridePass = ''; }

/** 'pretty' = /wp-json/... | 'query' = /?rest_route=/... | null = chưa biết */
let restStyle = null;

function authHeader() {
  const user = overrideUser || getWpUser();
  const pass = overridePass || getWpAppPassword();
  if (!user || !pass) {
    throw new Error('Thiếu QR_WP_USER hoặc QR_WP_APP_PASSWORD (nhập trên form hoặc .env)');
  }
  const token = Buffer.from(`${user}:${pass}`).toString('base64');
  return `Basic ${token}`;
}

/** path: /wp/v2/pages?slug=x hoặc /qr/v1/template/1 */
function buildRestUrl(path, style) {
  const base = getWpBase();
  const clean = path.startsWith('/') ? path : `/${path}`;
  const qIdx = clean.indexOf('?');
  const route = qIdx >= 0 ? clean.slice(0, qIdx) : clean;
  const query = qIdx >= 0 ? clean.slice(qIdx + 1) : '';
  if (style === 'query') {
    // Quan / site permalinks lạ: /wp-json → HTML 404, nhưng ?rest_route= OK
    return `${base}/?rest_route=${route}${query ? `&${query}` : ''}`;
  }
  return `${base}/wp-json${clean}`;
}

function isHtml404(status, data) {
  return status === 404 && typeof data?._raw === 'string' && /<!doctype html|<html/i.test(data._raw);
}

async function rawFetch(url, { method = 'GET', body = null, headers = {}, timeoutMs = 30000 } = {}) {
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      signal: ctrl.signal,
      headers: {
        Authorization: authHeader(),
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...headers,
      },
      body: body ? (Buffer.isBuffer(body) || typeof body === 'string' || body instanceof Uint8Array ? body : JSON.stringify(body)) : null,
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = { _raw: text }; }
    return { res, data, text };
  } finally {
    clearTimeout(timeout);
  }
}

async function wpFetch(path, { method = 'GET', body = null, headers = {} } = {}) {
  const tryStyle = restStyle || 'pretty';
  let url = buildRestUrl(path, tryStyle);
  let { res, data } = await rawFetch(url, { method, body, headers });

  // Pretty /wp-json trả HTML 404 → chuyển sang ?rest_route= (một lần, cache cả process)
  if (isHtml404(res.status, data) && tryStyle === 'pretty') {
    restStyle = 'query';
    url = buildRestUrl(path, 'query');
    ({ res, data } = await rawFetch(url, { method, body, headers }));
  } else if (res.ok && !restStyle) {
    restStyle = tryStyle;
  }

  if (!res.ok) {
    let msg = data?.message || data?.code || `HTTP ${res.status}`;
    if (isHtml404(res.status, data)) {
      msg = `REST API không trả JSON tại ${getWpBase()} (HTTP 404 HTML). Thử bật permalinks hoặc kiểm tra QR_WP_BASE=${getWpBase()}`;
    }
    const err = new Error(`WP API ${method} ${path}: ${msg}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  if (!restStyle) restStyle = tryStyle;
  return data;
}

/** Upload 1 file lên WP Media → { id, url } */
export async function wpUploadMedia(fileBuffer, filename, mimeType) {
  // Đảm bảo đã detect restStyle (pretty vs query)
  if (!restStyle) {
    try { await wpPing(); } catch { /* wpFetch bên dưới sẽ tự fallback */ }
  }
  const url = buildRestUrl('/wp/v2/media', restStyle || 'pretty');
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), 60000);
  try {
    const doUpload = async (uploadUrl) => {
      const res = await fetch(uploadUrl, {
        method: 'POST',
        signal: ctrl.signal,
        headers: {
          Authorization: authHeader(),
          'Content-Type': mimeType || 'application/octet-stream',
          'Content-Disposition': `attachment; filename="${filename}"`,
          Accept: 'application/json',
        },
        body: fileBuffer,
      });
      const text = await res.text();
      let data = null;
      try { data = text ? JSON.parse(text) : {}; } catch { data = { _raw: text }; }
      return { res, data };
    };

    let { res, data } = await doUpload(url);
    if (isHtml404(res.status, data) && (restStyle || 'pretty') === 'pretty') {
      restStyle = 'query';
      ({ res, data } = await doUpload(buildRestUrl('/wp/v2/media', 'query')));
    }
    if (!res.ok) throw new Error(`Upload ${filename}: ${data?.message || data?.code || `HTTP ${res.status}`}`);
    return { id: data.id, url: data.source_url };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Tìm attachment theo MD5 hash nội dung file (dedup, không phụ thuộc tên file).
 * Cần snippet v9+ (endpoint /qr/v1/find-media-by-hash + meta _qr_file_hash).
 * @param {string} hash - MD5 hex 32 ký tự
 * @returns {Promise<{id:number, url:string}|null>}
 */
export async function wpFindMediaByHash(hash) {
  try {
    const data = await wpFetch('/qr/v1/find-media-by-hash', {
      method: 'POST',
      body: { hash },
    });
    if (data?.found && data.id) return { id: data.id, url: data.url };
  } catch {
    // Endpoint chưa có (snippet cũ) → bỏ qua, upload như bình thường
  }
  return null;
}

/**
 * Lưu hash lên attachment vừa upload (để lần sau tìm được).
 * Dùng meta _qr_file_hash đã register show_in_rest ở snippet v9+.
 */
export async function wpSaveMediaHash(id, hash) {
  try {
    await wpFetch(`/wp/v2/media/${id}`, {
      method: 'POST',
      body: { meta: { _qr_file_hash: hash } },
    });
  } catch {
    // Không lưu được cũng không sao — chỉ mất khả năng dedup
  }
}

/**
 * Đọc _elementor_data RAW của template/page qua snippet v16.
 * GET /qr/v1/template/{id} → { id, raw } (chuỗi raw, không qua PHP json_decode
 * để {} rỗng không bị biến thành [] — xem 2.14).
 * Node JSON.parse trực tiếp → {} giữ nguyên là {}.
 */
export async function wpGetTemplateRaw(postId) {
  const data = await wpFetch(`/qr/v1/template/${postId}`);
  if (!data?.raw || typeof data.raw !== 'string') {
    throw new Error(`Template/page ${postId}: endpoint /qr/v1/template không trả raw (cần snippet v16+)`);
  }
  return JSON.parse(data.raw);
}

/**
 * Lấy _elementor_data đã parse của template hoặc page.
 * Dùng snippet endpoint (không còn SFTP bridge — xem 2.6).
 */
export async function wpGetElementorData(postId) {
  const elements = await wpGetTemplateRaw(postId);
  if (!Array.isArray(elements)) throw new Error(`Post ${postId}: _elementor_data không phải array`);
  return elements;
}

/** Tạo CF7 form → { id, title } */
export async function wpCreateCF7Form({ title, form, mail }) {
  // Dùng custom endpoint /qr/v1/create-cf7 (PHP API trực tiếp).
  // Cần snippet v12+. Trả về lỗi chi tiết nếu thiếu mail_to.
  const data = await wpFetch('/qr/v1/create-cf7', {
    method: 'POST',
    body: {
      title,
      form,
      mail_to: mail?.to || '',
      mail_subject: mail?.subject || '',
      mail_body: mail?.body || '',
    },
  });
  if (!data?.id) throw new Error(`Tạo CF7 form thất bại: ${data?.message || data?.code || 'không có ID trả về'}`);
  return { id: data.id, title: data.title || title, mailToSaved: data.mail_to_saved, mailFromSaved: data.mail_from_saved };
}

/** Xóa CF7 form cũ (khi ghi đè page). Cần snippet v14+. */
export async function wpDeleteCF7Form(id, expectedPrefix = '') {
  try {
    // (3.2) Snippet tự check title server-side: chỉ xóa khi title bắt đầu bằng expectedPrefix
    await wpFetch(`/qr/v1/delete-cf7/${id}`, {
      method: 'DELETE',
      body: JSON.stringify({ expected_prefix: expectedPrefix }),
    });
    return true;
  } catch {
    return false;
  }
}

/** Xóa page (dùng cho rollback) — force delete */
export async function wpDeletePage(id) {
  try {
    await wpFetch(`/wp/v2/pages/${id}?force=true`, { method: 'DELETE' });
    return true;
  } catch {
    return false;
  }
}

/** Tìm page theo slug → page object hoặc null */
export async function wpFindPageBySlug(slug) {
  // Bao gồm draft/pending/private để phát hiện page dở dang từ lần chạy lỗi (2.1).
  // Cần Application Password hợp lệ — không auth thì WP trả 400 Status is forbidden.
  const q = `slug=${encodeURIComponent(slug)}&status=publish,draft,pending,private`;
  try {
    const pages = await wpFetch(`/wp/v2/pages?${q}`);
    return Array.isArray(pages) && pages.length ? pages[0] : null;
  } catch (err) {
    // Auth yếu/hết hạn: fallback chỉ publish (public) thay vì chết cả job
    if (err.status === 400 || err.status === 401 || err.status === 403) {
      const pages = await wpFetch(`/wp/v2/pages?slug=${encodeURIComponent(slug)}&status=publish`);
      return Array.isArray(pages) && pages.length ? pages[0] : null;
    }
    throw err;
  }
}

/** Tạo page trống (draft, canvas) — chưa có Elementor data */
export async function wpCreatePage({ title, slug }) {
  const page = await wpFetch('/wp/v2/pages', {
    method: 'POST',
    body: { title, slug, status: 'draft', template: 'elementor_canvas' },
  });
  if (!page?.id) throw new Error('Tạo page thất bại: không có ID');
  return page;
}

/**
 * Import template NGUYÊN BẢN vào page (server-side verbatim copy,
 * không JSON round-trip qua Node). Page sau bước này phải render
 * giống hệt template preview.
 */
export async function wpImportTemplate(pageId, templateId) {
  const res = await wpFetch(`/qr/v1/import-template/${pageId}`, {
    method: 'POST',
    body: { template_id: templateId },
  });
  if (!res?.ok) throw new Error(`Import template thất bại: ${res?.message || 'unknown'}`);
  return res;
}

/** Ghi _elementor_data đã mutate qua custom endpoint (đã fix wp_slash) */
export async function wpSetElementorData(pageId, elementorData) {
  const res = await wpFetch(`/qr/v1/set-elementor/${pageId}`, {
    method: 'POST',
    body: { elementor_data: JSON.stringify(elementorData) },
  });
  if (!res?.ok) throw new Error(`Ghi Elementor data thất bại (page #${pageId})`);
  return res;
}

/** Publish page qua custom endpoint (bắt fatal message thật nếu critical error) */
export async function wpPublishPage(pageId) {
  try {
    const res = await wpFetch(`/qr/v1/publish/${pageId}`, { method: 'POST' });
    if (res?.ok) return { id: pageId, link: res.link };
    throw new Error(res?.error || 'Publish thất bại');
  } catch (err) {
    // Snippet chưa update (404) → fallback publish qua REST (2.5: check err.status)
    if (err.status === 404) {
      return wpFetch(`/wp/v2/pages/${pageId}`, { method: 'POST', body: { status: 'publish' } });
    }
    // Đọc fatal log thật từ server (2.5: thay last-fatal bằng error-log)
    try {
      const log = await wpGetErrorLog();
      if (log) throw new Error(`Publish critical error. PHP log:\n${log}`);
    } catch (e) {
      if (e.message.startsWith('Publish critical error')) throw e;
      // bỏ qua lỗi đọc log
    }
    throw err;
  }
}

/** Xóa PHP fatal log đầu job (để log chỉ chứa lỗi của run hiện tại) */
export async function wpClearErrorLog() {
  try { await wpFetch('/qr/v1/error-log-clear', { method: 'POST' }); } catch { /* snippet cũ: bỏ qua */ }
}

/** Đọc PHP fatal log (40 dòng cuối) — dùng khi frontend critical error */
export async function wpGetErrorLog() {
  try {
    const r = await wpFetch('/qr/v1/error-log');
    return r?.log || '';
  } catch {
    return '';
  }
}

export function wpConfigOk() {
  const user = overrideUser || getWpUser();
  const pass = overridePass || getWpAppPassword();
  return Boolean(getWpBase() && user && pass);
}

/** Ping REST root — detect pretty /wp-json vs ?rest_route= (quan test thường cần query) */
export async function wpPing() {
  const base = getWpBase();
  const tryOnce = async (style) => {
    const url = style === 'query' ? `${base}/?rest_route=/` : `${base}/wp-json/`;
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), 15000);
    try {
      const res = await fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/json' } });
      const text = await res.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch { data = { _raw: text }; }
      return { res, data, style, url };
    } finally {
      clearTimeout(timeout);
    }
  };

  let hit = await tryOnce(restStyle || 'pretty');
  if ((!hit.res.ok || !hit.data?.namespaces) && hit.style === 'pretty') {
    hit = await tryOnce('query');
  }
  if (!hit.res.ok || !hit.data?.namespaces) {
    throw new Error(
      `WP REST không trả lời tại ${base} (thử /wp-json và ?rest_route=). Kiểm tra QR_WP_BASE=${base}`
    );
  }
  if (!Array.isArray(hit.data.namespaces) || !hit.data.namespaces.includes('wp/v2')) {
    throw new Error(`Site ${base} thiếu namespace wp/v2`);
  }
  restStyle = hit.style;
  return {
    name: hit.data.name,
    url: hit.data.url || base,
    restStyle: hit.style,
    hasQr: hit.data.namespaces.includes('qr/v1'),
  };
}
