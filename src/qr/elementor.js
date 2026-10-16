/**
 * Thao tác _elementor_data: decode → walk → replace → encode.
 * KHÔNG raw string-replace JSON.
 */

/** Walk đệ quy mọi node trong elements tree */
export function walkElements(elements, fn) {
  if (!Array.isArray(elements)) return;
  for (const el of elements) {
    fn(el);
    if (Array.isArray(el.elements)) walkElements(el.elements, fn);
  }
}

/** Đếm tổng số elements (để log) */
export function countElements(elements) {
  let n = 0;
  walkElements(elements, () => n++);
  return n;
}

/**
 * Replace media: tìm widget có image settings trùng attachment ID hoặc URL cũ
 * → set id + url mới.
 *
 * CHỈ match plain image object {id: number, url: string}.
 * KHÔNG match array (repeater/gallery) — từng gây fatal sanitize_settings
 * vì biến repeater thành {id, url}.
 *
 * @param {Array} elements
 * @param {Array<{oldId:number, oldUrl:string, newId:number, newUrl:string}>} mappings
 * @returns {number} số chỗ đã replace
 */
function isImageObject(v) {
  return (
    v !== null &&
    typeof v === 'object' &&
    !Array.isArray(v) &&
    typeof v.id === 'number' &&
    typeof v.url === 'string'
  );
}

export function replaceMedia(elements, mappings) {
  let count = 0;
  walkElements(elements, (el) => {
    const s = el.settings || {};
    // settings phải là plain object (bỏ qua nếu là array/string/số)
    if (!s || typeof s !== 'object' || Array.isArray(s)) return;
    for (const m of mappings) {
      // Check các key ảnh phổ biến: image, background_image, etc.
      for (const key of Object.keys(s)) {
        const v = s[key];
        if (isImageObject(v) && (v.id === m.oldId || v.url === m.oldUrl)) {
          s[key] = { ...v, id: m.newId, url: m.newUrl };
          count++;
        }
      }
    }
  });
  return count;
}

/**
 * Replace background images theo VAI TRÒ (không hardcode attachment ID,
 * vì template rebuild là ID đổi).
 * - Element có css_id 'left-form' → bg2 (hình form).
 * - Các background_image còn lại → bg1 (background chung).
 * - Bỏ qua css_id trong keepCssIds.
 * @param {Array} elements
 * @param {{id:number, url:string}} bg1Media
 * @param {{id:number, url:string}} bg2Media
 * @param {string[]} keepCssIds - css_id của element giữ nguyên background
 * @returns {{count:number, details:string[]}}
 */
export function replaceBackgroundsByRole(elements, bg1Media, bg2Media, keepCssIds = []) {
  let count = 0;
  const details = [];
  const keep = new Set(keepCssIds);
  walkElements(elements, (el) => {
    const s = el.settings || {};
    if (!s || typeof s !== 'object' || Array.isArray(s)) return;
    const bg = s.background_image;
    if (!isImageObject(bg)) return;
    const cssId = String(s.css_id || s._element_id || s._css_id || el.id || '');
    if (keep.has(cssId)) {
      details.push(`giữ ${cssId || el.id} (#${bg.id})`);
      return;
    }
    const isForm = cssId === 'left-form';
    const target = isForm ? bg2Media : bg1Media;
    // Bỏ qua nếu đã đúng ảnh mới (tránh replace vòng)
    if (bg.id === target.id || bg.url === target.url) return;
    s.background_image = { ...bg, id: target.id, url: target.url };
    count++;
    details.push(`${cssId || el.id}: #${bg.id} → #${target.id}${isForm ? ' (bg2/form)' : ' (bg1)'}`);
  });
  return { count, details };
}

/**
 * Replace text tokens: {{ten}}, {{dia_chi}}, v.v.
 * Đệ quy vào mọi string trong settings (kể cả repeater rows như
 * social_icon_list, icon_list) — bản cũ chỉ check cấp đầu nên miss.
 */
export function replaceTokens(elements, tokens) {
  let count = 0;
  const tokenKeys = Object.keys(tokens);
  if (!tokenKeys.length) return 0;
  const walkValue = (v) => {
    if (typeof v === 'string') {
      let nv = v;
      for (const tk of tokenKeys) {
        if (nv.includes(tk)) {
          nv = nv.split(tk).join(tokens[tk]);
          count++;
        }
      }
      return nv;
    }
    if (Array.isArray(v)) {
      for (let i = 0; i < v.length; i++) v[i] = walkValue(v[i]);
      return v;
    }
    if (v && typeof v === 'object') {
      for (const k of Object.keys(v)) v[k] = walkValue(v[k]);
      return v;
    }
    return v;
  };
  walkElements(elements, (el) => {
    const s = el.settings;
    if (s && typeof s === 'object' && !Array.isArray(s)) walkValue(s);
  });
  return count;
}

/**
 * Replace màu hex trong widget settings → CSS variable.
 * Đệ quy vào mọi string (kể cả nested) cho chắc.
 * @param {Array} elements
 * @param {Array<{hex:string, variable:string}>} mappings
 */
export function replaceColors(elements, mappings) {
  let count = 0;
  const walkValue = (v) => {
    if (typeof v === 'string') {
      let nv = v;
      for (const m of mappings) {
        const re = new RegExp(m.hex.replace('#', '\\#'), 'gi');
        if (re.test(nv)) {
          nv = nv.replace(re, `var(${m.variable})`);
          count++;
        }
      }
      return nv;
    }
    if (Array.isArray(v)) {
      for (let i = 0; i < v.length; i++) v[i] = walkValue(v[i]);
      return v;
    }
    if (v && typeof v === 'object') {
      for (const k of Object.keys(v)) v[k] = walkValue(v[k]);
      return v;
    }
    return v;
  };
  walkElements(elements, (el) => {
    const s = el.settings;
    if (s && typeof s === 'object' && !Array.isArray(s)) walkValue(s);
  });
  return count;
}

/**
 * Set CSS variables trên page settings (hoặc root element).
 * Thêm vào custom CSS của page.
 */
export function setCssVariables(elements, variables) {
  // Tìm element đầu tiên hoặc dùng page settings
  // Đơn giản: inject vào settings của element đầu tiên có custom_css
  // Thực tế: thêm <style> vào HTML widget đầu tiên, hoặc dùng page settings
  const css = `:root {\n${Object.entries(variables).map(([k, v]) => `  ${k}: ${v};`).join('\n')}\n}`;
  return css;
}

/**
 * Rebind CF7 widget → form ID mới.
 * Tìm widget có setting chứa form ID cũ / contact_form.
 */
export function rebindCF7(elements, newFormId) {
  let count = 0;
  walkElements(elements, (el) => {
    // Elementor CF7 widget thường có elType 'widget', widgetType chứa 'cf7' hoặc 'contact-form'
    const wt = String(el.widgetType || '').toLowerCase();
    if (wt.includes('cf7') || wt.includes('contact') || wt.includes('form')) {
      const s = el.settings || {};
      // Các key có thể chứa form ID
      for (const key of ['contact_form', 'form_id', 'id', 'selected_form']) {
        if (key in s) {
          s[key] = String(newFormId);
          count++;
        }
      }
      // Nếu không tìm thấy key, log để debug
      if (count === 0) {
        // Thử set key phổ biến nhất
        s.contact_form = String(newFormId);
        count++;
      }
    }
  });
  return count;
}

/**
 * Xóa nút/section review khỏi tree (khi không có link).
 * Tìm element có link hoặc class liên quan đến review.
 */
export function removeReviewCta(elements, platform) {
  // platform: 'google' | 'yelp'
  let removed = 0;
  const shouldRemove = (el) => {
    const s = el.settings || {};
    const text = JSON.stringify(s).toLowerCase();
    // Tìm text "review" + platform
    return text.includes('review') && text.includes(platform);
  };
  const filterTree = (arr) => {
    if (!Array.isArray(arr)) return arr;
    return arr.filter((el) => {
      if (shouldRemove(el)) {
        removed++;
        return false;
      }
      if (Array.isArray(el.elements)) {
        el.elements = filterTree(el.elements);
      }
      return true;
    });
  };
  const filtered = filterTree(elements);
  // Copy kết quả vào mảng gốc
  elements.length = 0;
  elements.push(...filtered);
  return removed;
}

/**
 * Tìm và thay logo: Image widget #img-logo trong #custom-header (template mới),
 * hoặc <img> trong HTML widget (template cũ).
 * Thay image id/url + set link logo về homepage.
 * @param {Array} elements
 * @param {{id:number, url:string}} logoMedia
 * @param {string} homeLink - link homepage, có thì set cho logo
 * @returns {boolean} có thay được không
 */
export function replaceLogoInHeader(elements, logoMedia, homeLink = '') {
  let replaced = false;
  // Tìm element có css_id = 'custom-header'
  const findHeader = (arr) => {
    for (const el of arr) {
      const _cid = el.settings?.css_id || el.settings?._element_id || el.settings?._css_id;
      if (_cid === 'custom-header' || el.id === 'custom-header') return el;
      if (Array.isArray(el.elements)) {
        const found = findHeader(el.elements);
        if (found) return found;
      }
    }
    return null;
  };
  const header = findHeader(elements);
  if (!header) return false;
  // Set link cho image widget: s.link = { url }
  const setImageLink = (s) => {
    if (!homeLink) return;
    const cur = (s.link && typeof s.link === 'object' && !Array.isArray(s.link)) ? s.link : {};
    s.link = { ...cur, url: homeLink };
  };
  walkElements([header], (el) => {
    if (replaced) return;
    const s = el.settings || {};
    const cssId = String(s.css_id || s._element_id || s._css_id || '');
    const wt = String(el.widgetType || '').toLowerCase();
    // 1. Image widget có css_id = 'img-logo' → thay image id/url + link home
    if (cssId === 'img-logo' && wt.includes('image')) {
      if (s.image) {
        s.image.id = logoMedia.id;
        s.image.url = logoMedia.url;
      }
      setImageLink(s);
      replaced = true;
      return;
    }
    // 2. HTML widget → thay src của <img>
    if (wt === 'html' || wt.includes('html')) {
      const htmlKey = s.html ? 'html' : (s.custom_html ? 'custom_html' : null);
      if (htmlKey && typeof s[htmlKey] === 'string') {
        const newHtml = s[htmlKey].replace(
          /<img([^>]*)\ssrc=["'][^"']*["']/i,
          `<img$1 src="${logoMedia.url}"`
        );
        if (newHtml !== s[htmlKey]) {
          s[htmlKey] = newHtml;
          replaced = true;
        }
      }
    }
  });
  return replaced;
}

/**
 * Tạo CSS variables block.
 * @param {object} variables - { '--qr-primary': '#E31E24', ... }
 * @returns {string} CSS text
 */
export function buildCssVariablesBlock(variables) {
  const lines = Object.entries(variables).map(([k, v]) => `  ${k}: ${v};`);
  return `:root {\n${lines.join('\n')}\n}`;
}

/**
 * Thay giá trị CSS variables trong HTML widget theme engine.
 * CHỈ thay trong block `:root { ... }` (bỏ qua comment phía trên),
 * thay từng dòng "--var: ...;" đã có (hoặc chèn thêm nếu thiếu),
 * GIỮ NGUYÊN toàn bộ :root còn lại (font, size, weight...).
 * @param {Array} elements
 * @param {object} variables - { '--qr-primary': '#E31E24', ... }
 * @returns {boolean} có thay được không
 */
export function replaceCssVariables(elements, variables) {
  let replaced = false;
  // Key dài trước để tránh prefix nhầm (--qr-primary vs --qr-primary-soft)
  const names = Object.keys(variables).sort((a, b) => b.length - a.length);
  walkElements(elements, (el) => {
    if (replaced) return;
    const wt = String(el.widgetType || '').toLowerCase();
    if (wt === 'html' || wt.includes('html') || wt.includes('custom-css')) {
      const s = el.settings || {};
      for (const key of ['html', 'custom_html', 'custom_css']) {
        const val = s[key];
        if (typeof val === 'string' && val.includes('--qr-primary')) {
          // Scope vào block :root { ... } đầu tiên — tránh match nhầm
          // tên biến nằm trong comment (vd "TOOL CHỈ ĐIỀN 2 DÒNG ĐẦU").
          const newVal = val.replace(/:root\s*\{[^}]*\}/s, (rootBlock) => {
            let nb = rootBlock;
            for (const name of names) {
              const value = variables[name];
              const escName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
              const re = new RegExp(`(${escName}\\s*:\\s*)[^;]+;`);
              if (re.test(nb)) {
                nb = nb.replace(re, `$1${value};`);
              } else {
                // chưa có biến này → chèn vào đầu :root
                nb = nb.replace('{', `{\n  ${name}: ${value};`);
              }
            }
            return nb;
          });
          if (newVal !== val) {
            s[key] = newVal;
            replaced = true;
          }
          break;
        }
      }
    }
  });
  return replaced;
}
export function slugify(text) {
  return String(text || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
