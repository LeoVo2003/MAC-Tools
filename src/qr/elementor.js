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
 * @param {Array} elements
 * @param {Array<{oldId:number, oldUrl:string, newId:number, newUrl:string}>} mappings
 * @returns {number} số chỗ đã replace
 */
export function replaceMedia(elements, mappings) {
  let count = 0;
  walkElements(elements, (el) => {
    const s = el.settings || {};
    for (const m of mappings) {
      // Check các key ảnh phổ biến: image, background_image, etc.
      for (const key of Object.keys(s)) {
        const v = s[key];
        if (v && typeof v === 'object' && (v.id === m.oldId || v.url === m.oldUrl)) {
          s[key] = { ...v, id: m.newId, url: m.newUrl };
          count++;
        }
      }
    }
  });
  return count;
}

/**
 * Replace text tokens: {{ten}}, {{dia_chi}}, v.v.
 * Walk mọi string value trong settings, replace token.
 */
export function replaceTokens(elements, tokens) {
  let count = 0;
  const tokenKeys = Object.keys(tokens);
  if (!tokenKeys.length) return 0;
  walkElements(elements, (el) => {
    const s = el.settings || {};
    for (const key of Object.keys(s)) {
      const v = s[key];
      if (typeof v === 'string') {
        let nv = v;
        for (const tk of tokenKeys) {
          if (nv.includes(tk)) {
            nv = nv.split(tk).join(tokens[tk]);
            count++;
          }
        }
        if (nv !== v) s[key] = nv;
      }
    }
  });
  return count;
}

/**
 * Replace màu hex trong widget settings → CSS variable.
 * @param {Array} elements
 * @param {Array<{hex:string, variable:string}>} mappings
 */
export function replaceColors(elements, mappings) {
  let count = 0;
  walkElements(elements, (el) => {
    const s = el.settings || {};
    for (const key of Object.keys(s)) {
      const v = s[key];
      if (typeof v === 'string') {
        let nv = v;
        for (const m of mappings) {
          const re = new RegExp(m.hex.replace('#', '\\#'), 'gi');
          if (re.test(nv)) {
            nv = nv.replace(re, `var(${m.variable})`);
            count++;
          }
        }
        if (nv !== v) s[key] = nv;
      }
    }
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
 * Tìm và thay logo: img duy nhất bên trong #custom-header (template 2806).
 * @param {Array} elements
 * @param {{id:number, url:string}} logoMedia
 * @returns {boolean} có thay được không
 */
export function replaceLogoInHeader(elements, logoMedia) {
  let replaced = false;
  // Tìm element có css_id = 'custom-header'
  const findHeader = (arr) => {
    for (const el of arr) {
      if (el.settings?.css_id === 'custom-header' || el.id === 'custom-header') return el;
      if (Array.isArray(el.elements)) {
        const found = findHeader(el.elements);
        if (found) return found;
      }
    }
    return null;
  };
  const header = findHeader(elements);
  if (!header) return false;
  // Trong header, tìm image widget đầu tiên và thay
  walkElements([header], (el) => {
    if (replaced) return;
    const wt = String(el.widgetType || '').toLowerCase();
    if (wt === 'image' || wt.includes('image')) {
      const s = el.settings || {};
      if (s.image) {
        s.image = { ...s.image, id: logoMedia.id, url: logoMedia.url };
        replaced = true;
      }
    }
  });
  return replaced;
}

/**
 * Tạo CSS variables block để inject vào page.
 * @param {object} variables - { '--qr-primary': '#E31E24', ... }
 * @returns {string} CSS text
 */
export function buildCssVariablesBlock(variables) {
  const lines = Object.entries(variables).map(([k, v]) => `  ${k}: ${v};`);
  return `:root {\n${lines.join('\n')}\n}`;
}
export function slugify(text) {
  return String(text || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
