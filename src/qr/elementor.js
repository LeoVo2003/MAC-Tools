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

/**
 * Check background_image: nới lỏng hơn isImageObject — chấp nhận cả trường
 * hợp paste URL ngoài (id trống/không phải number), chỉ cần có url string.
 */
function isBackgroundObject(v) {
  return (
    v !== null &&
    typeof v === 'object' &&
    !Array.isArray(v) &&
    typeof v.url === 'string' &&
    v.url.length > 0
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
 * Kiểm tra element có chứa TRỰC TIẾP Contact Form 7 widget (child cấp 1).
 * Không tính container cha chứa gián tiếp (tránh match nhầm section bao ngoài).
 */
function isDirectFormContainer(el) {
  if (!Array.isArray(el.elements)) return false;
  return el.elements.some((sub) => String(sub.widgetType || '').includes('contact-form-7'));
}

/**
 * Replace background images theo VAI TRÒ (không hardcode attachment ID,
 * vì template rebuild là ID đổi).
 * - Element chứa form (CF7) hoặc css_id 'left-form' → bg2 (hình form).
 * - Các background_image còn lại → bg1 (background chung).
 * - Bỏ qua css_id trong keepCssIds.
 * @param {Array} elements
 * @param {{id:number, url:string}} bg1Media
 * @param {{id:number, url:string}} bg2Media
 * @param {string[]} keepCssIds - css_id của element giữ nguyên background
 * @returns {{count:number, details:string[]}}
 */
export function replaceBackgroundsByRole(elements, bg1Media, bg2Media, keepCssIds = [], keepUrls = []) {
  let count = 0;
  const details = [];
  const keep = new Set(keepCssIds);
  let formBgSet = false;
  let formContainer = null;
  // Cả background_image và background_overlay_image (::before overlay của Elementor)
  const BG_KEYS = ['background_image', 'background_overlay_image'];
  walkElements(elements, (el) => {
    const s = el.settings || {};
    if (!s || typeof s !== 'object' || Array.isArray(s)) return;
    const cssId = String(s.css_id || s._element_id || s._css_id || el.id || '');
    // Hình form: element có css_id left-form HOẶC chứa CF7 widget
    const isForm = cssId === 'left-form' || isDirectFormContainer(el);
    if (isForm && !formContainer && (el.elType === 'container' || el.elType === 'section')) {
      formContainer = el;
    }
    for (const bgKey of BG_KEYS) {
      const bg = s[bgKey];
      if (!isBackgroundObject(bg)) continue;
      const isOverlay = bgKey === 'background_overlay_image';
      const label = isOverlay ? 'overlay' : 'bg';
      // Giữ nguyên nếu URL nằm trong keep-list
      if (keepUrls.some((u) => bg.url.includes(u))) {
        details.push(`giữ ${cssId || el.id} (${bg.url.split('/').pop()})`);
        if (isForm) formBgSet = true;
        continue;
      }
      if (keep.has(cssId)) {
        details.push(`giữ ${cssId || el.id} (#${bg.id || '?'})`);
        if (isForm) formBgSet = true;
        continue;
      }
      const target = isForm ? bg2Media : bg1Media;
      if (bg.id === target.id || bg.url === target.url) {
        if (isForm) formBgSet = true;
        continue;
      }
      s[bgKey] = { ...bg, id: target.id, url: target.url };
      count++;
      if (isForm) formBgSet = true;
      details.push(`${cssId || el.id} [${label}]: ${bg.id || '?'} → #${target.id}${isForm ? ' (bg2/form)' : ' (bg1)'}`);
    }
  });
  // Fallback: form container chưa có background → SET mới luôn
  // (template xóa ảnh placeholder thì tool vẫn gán được)
  if (!formBgSet && formContainer) {
    const s = formContainer.settings;
    s.background_background = 'classic';
    s.background_image = { id: bg2Media.id, url: bg2Media.url };
    count++;
    const cssId = String(s.css_id || s._element_id || s._css_id || formContainer.id || '');
    details.push(`${cssId || formContainer.id}: (trống) → #${bg2Media.id} (bg2/form, set mới)`);
  }
  return { count, details };
}

/**
 * Replace ảnh hardcode trong custom_css của element
 * (vd #left-form dùng selector::before { background-image: url('...') }).
 * - left-form → bg2, còn lại → bg1.
 * Chỉ đụng URL ảnh http(s) có đuôi file ảnh.
 */
export function replaceCustomCssImages(elements, bg1Media, bg2Media, keepCssIds = []) {
  let count = 0;
  const details = [];
  const keep = new Set(keepCssIds);
  walkElements(elements, (el) => {
    const s = el.settings || {};
    if (!s || typeof s !== 'object' || Array.isArray(s)) return;
    const css = s.custom_css;
    if (typeof css !== 'string' || !css.includes('url(')) return;
    const cssId = String(s.css_id || s._element_id || s._css_id || el.id || '');
    if (keep.has(cssId)) return;
    const isForm = cssId === 'left-form' || isDirectFormContainer(el);
    const target = isForm ? bg2Media : bg1Media;
    const re = /url\(\s*(['"]?)(https?:\/\/[^'")]+?\.(?:jpg|jpeg|png|webp|gif|svg|avif))(\1)\s*\)/gi;
    let newCss = css;
    let m;
    const seen = new Set();
    while ((m = re.exec(css)) !== null) {
      const oldUrl = m[2];
      if (oldUrl === target.url || seen.has(oldUrl)) continue;
      seen.add(oldUrl);
      newCss = newCss.split(oldUrl).join(target.url);
      count++;
      details.push(`${cssId || el.id} custom_css: ...${oldUrl.slice(-40)} → #${target.id}${isForm ? ' (bg2/form)' : ' (bg1)'}`);
    }
    if (newCss !== css) s.custom_css = newCss;
  });
  return { count, details };
}

/**
 * Replace ảnh placeholder trong <style> của theme HTML widget.
 * Xử lý trường hợp #left-form::before { background-image: url(...) } hardcode
 * trong CSS theme (không nằm trong custom_css của element).
 * @param {Array} elements
 * @param {{id:number, url:string}} bg2Media - ảnh form
 * @returns {{count:number, details:string[]}}
 */
export function replaceThemeCssImages(elements, bg2Media) {
  let count = 0;
  const details = [];
  walkElements(elements, (el) => {
    const wt = String(el.widgetType || '').toLowerCase();
    if (wt !== 'html' && !wt.includes('html')) return;
    const s = el.settings || {};
    for (const key of ['html', 'custom_html']) {
      const val = s[key];
      if (typeof val !== 'string' || !val.includes('</style>')) continue;
      // #left-form::before hoặc #left_form::before { ... background-image: url(...) ... }
      const newVal = val.replace(
        /(#left[-_]form::before\s*\{[^}]*?background-image\s*:\s*url\(\s*['"]?)([^'")\s]+)(['"]?\s*\))/gi,
        (m, pre, oldUrl, post) => {
          if (!oldUrl || oldUrl === bg2Media.url || oldUrl.startsWith('data:')) return m;
          count++;
          details.push(`theme #left-form::before: ...${oldUrl.slice(-40)} → #${bg2Media.id} (bg2)`);
          return pre + bg2Media.url + post;
        }
      );
      if (newVal !== val) {
        s[key] = newVal;
        break;
      }
    }
  });
  return { count, details };
}

/**
 * Patch CSS theme: nút .btn-m/.btn-s thiếu font-weight (theme gốc không set).
 * Append rule override vào cuối <style> của HTML widget theme.
 * @param {Array} elements
 * @param {number} weight - font-weight cho nút (mặc định 600)
 * @returns {boolean} có patch được không
 */
export function patchButtonWeight(elements, weight = 600) {
  let patched = false;
  // (Review 2 - 1.2) TẤT CẢ nút trong template đều có background = var(--qr-primary)
  // (secondary chỉ là viền), nên chữ/icon LUÔN dùng --qr-text-on-primary.
  // Patch cũ dùng on-secondary cho .btn-s/social → vàng/cam/nâu chỉ 1.4-3.1:1.
  const override = `\n/* TOOL PATCH: nút có font-weight + màu chữ đúng contrast */\n.btn-m a, .btn-s a, .btn-l a, .btn-s .wpcf7-submit { font-weight: ${weight} !important; }\n.btn-m a, .btn-s a, .btn-l a, .btn-s .wpcf7-submit, .elementor-button-link { color: var(--qr-text-on-primary, #141414) !important; }\n/* Icon trong nút và social icons đổi màu theo chữ (dùng currentColor) */\n.btn-m a svg, .btn-s a svg, .btn-l a svg { fill: currentColor !important; }\n.btn-m a svg path, .btn-s a svg path, .btn-l a svg path { fill: currentColor !important; }\n.btn-m a i, .btn-s a i, .btn-l a i { color: inherit !important; }\n.social-icons a, .social-icon a, [class*=\"social\"] a { color: var(--qr-text-on-primary, #141414) !important; }\n.social-icons a svg, [class*=\"social\"] a svg { fill: currentColor !important; }\n.social-icons a svg path, [class*=\"social\"] a svg path { fill: currentColor !important; }\n`;
  walkElements(elements, (el) => {
    if (patched) return;
    const wt = String(el.widgetType || '').toLowerCase();
    if (wt === 'html' || wt.includes('html')) {
      const s = el.settings || {};
      for (const key of ['html', 'custom_html']) {
        const val = s[key];
        if (typeof val === 'string' && val.includes('.btn-m a') && val.includes('</style>')) {
          // Nếu đã có patch màu chữ mới → chỉ update font-weight nếu khác
          if (val.includes('--qr-text-on-primary')) {
            const weightRe = /(\.btn-m a, \.btn-s a, \.btn-l a, \.btn-s \.wpcf7-submit\s*\{\s*font-weight:\s*)(\d+)/;
            const m = val.match(weightRe);
            if (m && Number(m[2]) !== weight) {
              s[key] = val.replace(weightRe, `$1${weight}`);
            }
            patched = true;
          } else {
            // Xóa patch cũ (nếu có) rồi thêm patch mới
            let newVal = val.replace(/\/\* TOOL PATCH: nút có font-weight \*\/[\s\S]*?\.btn-s \.wpcf7-submit \{[^}]+\}\n/, '');
            newVal = newVal.replace('</style>', `${override}</style>`);
            s[key] = newVal;
            patched = true;
          }
          break;
        }
      }
    }
  });
  return patched;
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
    // (2.11) Chỉ match widgetType === 'contact-form-7' chính xác
    // (tránh nhầm với Elementor Form/Login widget)
    const wt = String(el.widgetType || '').toLowerCase();
    if (wt === 'contact-form-7') {
      const s = el.settings || {};
      // Chỉ set key contact_form (key chuẩn của CF7 widget)
      s.contact_form = String(newFormId);
      count++;
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
  // (2.9) Ưu tiên marker class, fallback heuristic chuỗi cũ
  const marker = platform === 'google' ? 'qr-cta-google-review' : 'qr-cta-yelp-review';
  let removed = 0;
  const hasMarker = (el) => {
    const s = el.settings || {};
    const classes = String(s._css_classes || s.css_classes || '');
    return classes.split(/\s+/).includes(marker);
  };
  const shouldRemove = (el) => {
    // Ưu tiên marker class chính xác
    if (hasMarker(el)) return true;
    // Fallback: heuristic chuỗi cũ (kém chính xác hơn)
    const s = el.settings || {};
    const text = JSON.stringify(s).toLowerCase();
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
    .replace(/đ/g, 'd').replace(/Đ/g, 'd')  // đ/Đ không có dạng tổ hợp NFD (2.17)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
