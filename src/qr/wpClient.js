/**
 * WordPress REST API client cho QR Tool → qr.macmarketing.us
 * Auth: Application Password qua Basic Auth (từ env QR_WP_*).
 */

// Đọc env lazy (dotenv.config chạy sau khi modules load)
function getWpBase() {
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
  console.log(`[wp-auth] user="${user}" pass_len=${pass.length} override=${Boolean(overrideUser)}`);
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
  // Fallback: REST pages với context=edit (cần meta được expose)
  const page = await wpFetch(`/wp/v2/pages/${postId}?context=edit`);
  const ed = page?.meta?._elementor_data;
  if (ed) return typeof ed === 'string' ? JSON.parse(ed) : ed;
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

/** Tạo page mới */
export async function wpCreatePage({ title, slug, elementorData }) {
  return wpFetch('/wp/v2/pages', {
    method: 'POST',
    body: {
      title,
      slug,
      status: 'publish',
      template: 'elementor_canvas',
      meta: {
        _elementor_data: JSON.stringify(elementorData),
        _elementor_edit_mode: 'builder',
        _elementor_template_type: 'wp-page',
      },
    },
  });
}

/** Update page có sẵn (ghi đè) */
export async function wpUpdatePage(pageId, { title, elementorData }) {
  return wpFetch(`/wp/v2/pages/${pageId}`, {
    method: 'POST',
    body: {
      title,
      meta: {
        _elementor_data: JSON.stringify(elementorData),
        _elementor_edit_mode: 'builder',
      },
    },
  });
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
