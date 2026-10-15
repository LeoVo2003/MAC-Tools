/**
 * WordPress REST API client cho QR Tool → qr.macmarketing.us
 * Auth: Application Password qua Basic Auth (từ env QR_WP_*).
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

function authHeader() {
  const user = overrideUser || getWpUser();
  const pass = overridePass || getWpAppPassword();
  if (!user || !pass) {
    throw new Error('Thiếu QR_WP_USER hoặc QR_WP_APP_PASSWORD (nhập trên form hoặc .env)');
  }
  const token = Buffer.from(`${user}:${pass}`).toString('base64');
  return `Basic ${token}`;
}

async function wpFetch(path, { method = 'GET', body = null, headers = {} } = {}) {
  const url = `${getWpBase()}/wp-json${path}`;
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), 30000);
  try {
    const res = await fetch(url, {
      method,
      signal: ctrl.signal,
      headers: {
        Authorization: authHeader(),
        'Content-Type': 'application/json',
        ...headers,
      },
      body: body ? JSON.stringify(body) : null,
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = { _raw: text }; }
    if (!res.ok) {
      const msg = data?.message || data?.code || `HTTP ${res.status}`;
      throw new Error(`WP API ${method} ${path}: ${msg}`);
    }
    return data;
  } finally {
    clearTimeout(timeout);
  }
}

/** Upload 1 file lên WP Media → { id, url } */
export async function wpUploadMedia(fileBuffer, filename, mimeType) {
  const url = `${getWpBase()}/wp-json/wp/v2/media`;
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), 60000);
  try {
    // Gửi raw binary với Content-Disposition (ổn định hơn FormData)
    const res = await fetch(url, {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        Authorization: authHeader(),
        'Content-Type': mimeType || 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${filename}"`,
      },
      body: fileBuffer,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Upload ${filename}: ${data?.message || `HTTP ${res.status}`}`);
    return { id: data.id, url: data.source_url };
  } finally {
    clearTimeout(timeout);
  }
}

/** Lấy _elementor_data của template (cần mu-plugin hoặc meta expose) */
export async function wpGetElementorData(postId) {
  // Thử qua custom endpoint của mu-plugin trước
  try {
    const data = await wpFetch(`/qr/v1/template/${postId}`);
    if (data?.elementor_data) return data.elementor_data;
  } catch { /* fallback */ }
  // Fallback: thử các post type (pages, elementor_library)
  for (const type of ['pages', 'elementor_library']) {
    try {
      const page = await wpFetch(`/wp/v2/${type}/${postId}?context=edit`);
      const ed = page?.meta?._elementor_data;
      if (ed) return typeof ed === 'string' ? JSON.parse(ed) : ed;
    } catch { /* thử type tiếp theo */ }
  }
  throw new Error(`Không lấy được _elementor_data của post ${postId}. Cần mu-plugin qr-template.`);
}

/** Tạo CF7 form → { id, title } */
export async function wpCreateCF7Form({ title, form, mail }) {
  const data = await wpFetch('/contact-form-7/v1/contact-forms', {
    method: 'POST',
    body: { title, form, mail },
  });
  if (!data?.id) throw new Error('Tạo CF7 form thất bại: không có ID trả về');
  return { id: data.id, title: data.title || title };
}

/** Tìm page theo slug → page object hoặc null */
export async function wpFindPageBySlug(slug) {
  const pages = await wpFetch(`/wp/v2/pages?slug=${encodeURIComponent(slug)}`);
  return Array.isArray(pages) && pages.length ? pages[0] : null;
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
    // Snippet chưa update (404) → fallback publish qua REST
    if (/HTTP 404/.test(err.message)) {
      return wpFetch(`/wp/v2/pages/${pageId}`, { method: 'POST', body: { status: 'publish' } });
    }
    // Đọc fatal message thật từ server (nếu có)
    try {
      const f = await wpFetch('/qr/v1/last-fatal');
      if (f?.fatal) throw new Error(`Publish critical error: ${f.fatal}`);
    } catch { /* bỏ qua */ }
    throw err;
  }
}

/** Xóa cache Elementor CSS của page (force regenerate) */
export async function wpRegenerateElementorCss(pageId) {
  try {
    // Xóa postmeta _elementor_css để Elementor regenerate lần view sau
    await wpFetch(`/qr/v1/regenerate-css/${pageId}`, { method: 'POST' });
  } catch {
    // mu-plugin chưa có endpoint này thì bỏ qua, Elementor tự regenerate khi edit
  }
}

export function wpConfigOk() {
  const user = overrideUser || getWpUser();
  const pass = overridePass || getWpAppPassword();
  return Boolean(getWpBase() && user && pass);
}
