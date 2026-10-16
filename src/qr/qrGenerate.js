/**
 * QR Generate orchestration — điều phối toàn bộ flow tạo QR landing page.
 */
import { createHash } from 'crypto';
import {
  wpUploadMedia,
  wpFindMediaByHash,
  wpSaveMediaHash,
  wpGetElementorData,
  wpCreateCF7Form,
  wpFindPageBySlug,
  wpCreatePage,
  wpImportTemplate,
  wpSetElementorData,
  wpPublishPage,
  wpRegenerateElementorCss,
  wpConfigOk,
  wpClearErrorLog,
  wpGetErrorLog,
  getWpBase,
} from './wpClient.js';
import {
  replaceBackgroundsByRole,
  replaceCustomCssImages,
  replaceThemeCssImages,
  patchButtonWeight,
  replaceTokens,
  replaceColors,
  replaceLogoInHeader,
  buildCssVariablesBlock,
  replaceCssVariables,
  rebindCF7,
  removeReviewCta,
  slugify,
  countElements,
} from './elementor.js';
import { installBridge, removeBridge } from './sftpBridge.js';

function getTemplateId() { return Number(process.env.QR_TEMPLATE_ID) || 2806; }

// Background giữ nguyên (theo element id hoặc css_id).
// 37e07fe4: container form giữ ảnh 303-bg-1-1-hori-cc-beige-brown.jpg
// (user chốt 2026-10-16; keep theo element để đổi ảnh khác cũng không ảnh hưởng)
const KEEP_BACKGROUND_CSS_IDS = ['37e07fe4'];

// URL ảnh giữ nguyên (dự phòng, match theo tên file không phụ thuộc domain)
const KEEP_BACKGROUND_URLS = [
  '303-bg-1-1-hori-cc-beige-brown.jpg', // user chốt 2026-10-16: giữ nguyên
];

/** Darken hex 50% (giữ nguyên alpha nếu là #RRGGBBAA) */
function darkenHex(hex, pct = 50) {  const m = /^#([0-9a-fA-F]{6})([0-9a-fA-F]{2})?$/.exec(String(hex || '').trim());
  if (!m) return '#000000';
  const n = parseInt(m[1], 16);
  const f = 1 - pct / 100;
  const r = Math.round(((n >> 16) & 255) * f);
  const g = Math.round(((n >> 8) & 255) * f);
  const b = Math.round((n & 255) * f);
  const alpha = m[2] ? m[2].toUpperCase() : '';
  return '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase() + alpha;
}

/**
 * Sinh --qr-primary-soft / --qr-text / --qr-text-on-soft từ primary
 * (cùng công thức với JS qrThemeInit trong theme).
 * Tool fill trực tiếp để không phụ thuộc JS — JS của theme chỉ parse
 * được hex 6 ký tự, primary 8-digit sẽ làm nó fail.
 */
function deriveThemeColors(primary) {
  const m = /^#([0-9a-fA-F]{6})([0-9a-fA-F]{2})?$/i.exec(String(primary || '').trim());
  if (!m) return {};
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  // soft: primary pha 90% trắng
  const sr = r * 0.1 + 255 * 0.9, sg = g * 0.1 + 255 * 0.9, sb = b * 0.1 + 255 * 0.9;
  const hx = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  const soft = `#${hx(sr)}${hx(sg)}${hx(sb)}`.toUpperCase();
  // chữ trên nền đậm/nhạt: đảo theo YIQ
  const yiq = (r * 299 + g * 587 + b * 114) / 1000;
  const yiqSoft = (sr * 299 + sg * 587 + sb * 114) / 1000;
  return {
    '--qr-primary-soft': soft,
    '--qr-text': yiq > 128 ? '#141414' : '#FFFFFF',
    '--qr-text-on-soft': yiqSoft > 128 ? '#141414' : '#FFFFFF',
  };
}

/** Convert social URL → review URL qua worker */
async function convertToReviewUrl(socialUrl) {
  if (!socialUrl || !socialUrl.startsWith('http')) return null;
  const workerBase = (process.env.REVIEW_LINK_WORKER || 'https://review-link.leo-vo.workers.dev').replace(/\/$/, '');
  try {
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), 15000);
    const r = await fetch(`${workerBase}/api/convert?url=${encodeURIComponent(socialUrl)}`, { signal: ctrl.signal });
    clearTimeout(timeout);
    const data = await r.json();
    if (data?.ok && data?.reviewUrl) return data.reviewUrl;
    return null;
  } catch {
    return null;
  }
}

/** Download ảnh từ URL → { buffer, filename, mimetype } */
async function downloadImage(url) {
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), 30000);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`Download ${url}: HTTP ${res.status}`);
    const contentType = res.headers.get('content-type') || 'image/jpeg';
    if (!contentType.startsWith('image/')) throw new Error(`URL không phải ảnh: ${contentType}`);
    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.length > 10 * 1024 * 1024) throw new Error('Ảnh quá lớn (>10MB)');
    const ext = contentType.split('/')[1]?.split('+')[0] || 'jpg';
    const filename = `qr-${Date.now()}.${ext}`;
    return { buffer, filename, mimetype: contentType };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * @param {object} opts
 * @param {object} opts.wpmData - data từ WPM fill (tên, địa chỉ, phone, email, social)
 * @param {object} opts.inputs - input tay (màu, link, logoFilter)
 * @param {object} opts.files - { logo, bg1, bg2 } mỗi cái: { buffer, filename, mimetype } hoặc { url }
 * @param {function} opts.onLog
 * @param {boolean} opts.force - ghi đè nếu slug trùng
 */
export async function generateQRPage({ wpmData, inputs, files, onLog = () => {}, force = false }) {
  const log = (msg) => { console.log(`[qr] ${msg}`); onLog(`[qr] ${msg}`); };
  if (!wpConfigOk()) throw new Error('Chưa cấu hình QR_WP_* trong .env');

  const result = { steps: [] };
  const step = (name, ok, detail = '') => {
    result.steps.push({ name, ok, detail });
    log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
  };

  // 0. Cài mu-plugin tạm (tự xóa sau job)
  let bridgeInstalled = false;
  try {
    bridgeInstalled = await installBridge(log);
    // Đợi 1s để WP nhận plugin mới
    if (bridgeInstalled) await new Promise((r) => setTimeout(r, 1000));
  } catch (err) {
    log(`[qr-bridge] Lỗi cài plugin: ${err.message} — tiếp tục với template cache.`);
  }

  try {

  // 1. Validate + chuẩn bị data
  const zip = String(wpmData.zip || '').trim();
  const businessName = String(wpmData.shopName || wpmData.projectName || '').trim();
  if (!zip || !businessName) throw new Error('Thiếu ZIP hoặc tên tiệm từ WPM');
  const title = `${zip} ${businessName}`;
  const slug = `${zip}-${slugify(businessName)}`;
  const primary = String(inputs.primary || '').trim();
  const isHex = (v) => /^#[0-9A-F]{6}([0-9A-F]{2})?$/i.test(v);
  const isGradient = (v) => /^(linear|radial)-gradient\(/i.test(v);
  if (!isHex(primary) && !isGradient(primary)) throw new Error('Màu chính không hợp lệ (hex hoặc gradient)');
  let secondaryRaw = inputs.secondary?.trim() || '';
  if (!secondaryRaw) {
    // Darken chỉ áp dụng cho hex; gradient thì dùng stop cuối.
    // Giữ nguyên alpha nếu primary là #RRGGBBAA.
    secondaryRaw = isHex(primary) ? darkenHex(primary, 50) : primary;
  }
  secondaryRaw = secondaryRaw.toUpperCase();
  if (!isHex(secondaryRaw) && !isGradient(secondaryRaw)) throw new Error('Màu phụ không hợp lệ (hex hoặc gradient)');
  const secondary = secondaryRaw;
  step('validate', true, `${title} / ${slug}`);

  // Xóa PHP fatal log đầu job (snippet v5+) để log chỉ chứa lỗi run này
  await wpClearErrorLog();

  // 2. Check slug trùng
  const existing = await wpFindPageBySlug(slug);
  if (existing && !force) {
    const err = new Error(`Slug đã tồn tại: ${slug} (page ${existing.id})`);
    err.code = 'SLUG_EXISTS';
    err.existingPageId = existing.id;
    throw err;
  }
  if (existing && force) step('slug', true, `ghi đè page ${existing.id}`);

  // 3. Upload 3 ảnh (file upload hoặc download từ URL)
  log('Chuẩn bị 3 ảnh...');
  const prepareImage = async (file, name) => {
    if (file?.buffer) return file;
    if (file?.url) {
      log(`Download ${name} từ URL...`);
      return downloadImage(file.url);
    }
    throw new Error(`Thiếu ảnh ${name}: upload file hoặc paste link`);
  };
  const [logoFile, bg1File, bg2File] = await Promise.all([
    prepareImage(files.logo, 'logo'),
    prepareImage(files.bg1, 'background'),
    prepareImage(files.bg2, 'hình form'),
  ]);
  log('Upload 3 ảnh lên WP...');
  // Dedup: tính MD5 trước, nếu đã có trên web (kể cả khác tên) thì dùng lại
  const md5 = (buf) => createHash('md5').update(buf).digest('hex');
  const getOrUpload = async (file, label) => {
    const hash = md5(file.buffer);
    const existing = await wpFindMediaByHash(hash);
    if (existing) {
      log(`Dùng lại ảnh ${label} #${existing.id} (đã có trên web)`);
      return { id: existing.id, url: existing.url };
    }
    const media = await wpUploadMedia(file.buffer, file.filename, file.mimetype);
    await wpSaveMediaHash(media.id, hash);
    return media;
  };
  const [logoMedia, bg1Media, bg2Media] = await Promise.all([
    getOrUpload(logoFile, 'logo'),
    getOrUpload(bg1File, 'background'),
    getOrUpload(bg2File, 'hình form'),
  ]);
  step('upload', true, `logo=${logoMedia.id}, bg1=${bg1Media.id}, bg2=${bg2Media.id}`);
  result.media = { logo: logoMedia, bg1: bg1Media, bg2: bg2Media };

  // 4. Review links + Social defaults
  // Logic: WPM có link → convert bằng tool → fail thì về default
  //        WPM không có → default #link_{platform}_rv
  //        User xóa trống ô input → xóa nút khỏi page
  const reviewLinks = {};
  const socialLinks = {};
  const isManual = (v) => v?.trim() && !v.startsWith('#link_');
  const isEmpty = (v) => !v?.trim();

  // Helper: xử lý 1 platform
  const processPlatform = async (platform, socialUrl, manualInput) => {
    const defaultTag = `#link_${platform}_rv`;
    // User xóa trống → xóa nút
    if (isEmpty(manualInput) && !socialUrl) return { action: 'remove' };
    if (isEmpty(manualInput)) return { action: 'remove' };
    // User nhập tay (không phải default tag)
    if (isManual(manualInput)) return { action: 'use', url: manualInput.trim() };
    // Có social từ WPM → convert
    if (socialUrl && socialUrl.startsWith('http')) {
      log(`Convert ${platform} social → review link...`);
      const converted = await convertToReviewUrl(socialUrl);
      if (converted) {
        step(`review-${platform}`, true, 'tự convert từ social');
        return { action: 'use', url: converted };
      }
      log(`${platform}: convert thất bại → dùng default.`);
    }
    // Default
    step(`review-${platform}`, true, 'dùng default');
    return { action: 'use', url: defaultTag };
  };

  const ggResult = await processPlatform('gg', wpmData.social?.google, inputs.reviewGg);
  const yelpResult = await processPlatform('yelp', wpmData.social?.yelp, inputs.reviewYelp);

  if (ggResult.action === 'use') reviewLinks.google = ggResult.url;
  if (yelpResult.action === 'use') reviewLinks.yelp = yelpResult.url;

  // Social defaults: #link_{social} nếu WPM không có
  for (const [key, tag] of [['facebook', 'fb'], ['instagram', 'ig'], ['yelp', 'yelp'], ['google', 'gg']]) {
    const url = wpmData.social?.[key];
    socialLinks[key] = (url && url.startsWith('http')) ? url : `#link_${tag}`;
  }

  // 5. Tạo CF7 form (bỏ qua nếu skipCf7 — vd PHP cũ chưa chạy CF7 mới)
  const shopEmail = wpmData.email || '';
  let cf7Form = null;
  if (!inputs.skipCf7) {
    const cf7Title = title;
    cf7Form = await wpCreateCF7Form({
      title: cf7Title,
      form: `[text* your-name placeholder "Your name*"]\n[tel* your-phone placeholder "Phone*"]\n[email your-email placeholder "Email"]\n[textarea your-message placeholder "Your message (optional)"]\n[submit "Submit"]`,
      mail: {
        to: shopEmail,
        subject: 'Customer Service Review ([your-name])',
        body: `From: [your-name]\nEmail: [your-email]\nPhone: [your-phone]\n\nMessage: [your-message]\n\n-----------------------------------------------------------\nThis e-mail was sent from a contact form on [_site_title] ([_url])`,
        exclude_blank: 'on',
      },
    });
    step('cf7', true, `form #${cf7Form.id}`);
    result.cf7 = cf7Form;
  } else {
    step('cf7', true, 'bỏ qua (skipCf7)');
  }

  // 6. Validate template tồn tại + có Elementor data (fail sớm nếu sai template ID)
  const templateId = getTemplateId();
  const templateData = await wpGetElementorData(templateId);
  if (!Array.isArray(templateData)) throw new Error(`Template #${templateId}: _elementor_data không phải array`);
  const templateTopLevel = templateData.length;
  step('template', true, `#${templateId}: ${countElements(templateData)} elements, ${templateTopLevel} top-level`);

  // 7. Tạo page → import template NGUYÊN BẢN server-side (verbatim, không JSON round-trip)
  // Page sau bước này phải render giống hệt template preview.
  let pageId;
  if (existing && force) {
    pageId = existing.id;
    step('page', true, `dùng lại page #${pageId} (ghi đè)`);
  } else {
    const created = await wpCreatePage({ title, slug });
    pageId = created.id;
    step('page', true, `created #${pageId}`);
  }
  const imported = await wpImportTemplate(pageId, templateId);
  const importOk = imported.top_level === templateTopLevel && imported.top_level > 0;
  step('import-template', importOk, `verbatim ${imported.bytes} bytes, ${imported.top_level}/${templateTopLevel} top-level`);
  if (!importOk) {
    throw new Error(`Import lệch: template ${templateTopLevel} top-level nhưng page chỉ ${imported.top_level}. Kiểm tra snippet qr-set-elementor v2 trên site.`);
  }

  // 7b. Đọc lại data từ page (chính data vừa import) rồi mutate trên đó
  let elements = await wpGetElementorData(pageId);
  if (!Array.isArray(elements)) throw new Error('Page _elementor_data không phải array sau import');
  elements = JSON.parse(JSON.stringify(elements)); // deep clone để mutate

  // 8. Replace trên data của page

  // 7a. Background images theo vai trò (không hardcode attachment ID):
  // left-form → bg2 (hình form), các background còn lại → bg1.
  const bgRes = replaceBackgroundsByRole(
    elements,
    { id: bg1Media.id, url: bg1Media.url },
    { id: bg2Media.id, url: bg2Media.url },
    KEEP_BACKGROUND_CSS_IDS,
    KEEP_BACKGROUND_URLS,
  );
  step('replace-media', true, `${bgRes.count} chỗ`);
  for (const d of bgRes.details) log(`[qr] bg: ${d}`);

  // 7a1. Ảnh hardcode trong custom_css (vd #left-form::before url(...))
  const cssImgRes = replaceCustomCssImages(
    elements,
    { id: bg1Media.id, url: bg1Media.url },
    { id: bg2Media.id, url: bg2Media.url },
    KEEP_BACKGROUND_CSS_IDS,
  );
  if (cssImgRes.count) {
    step('replace-css-img', true, `${cssImgRes.count} chỗ`);
    for (const d of cssImgRes.details) log(`[qr] css-img: ${d}`);
  }

  // 7a1b. Ảnh hardcode trong <style> của theme (vd #left-form::before url(...))
  const themeImgRes = replaceThemeCssImages(elements, { id: bg2Media.id, url: bg2Media.url });
  if (themeImgRes.count) {
    step('replace-theme-img', true, `${themeImgRes.count} chỗ`);
    for (const d of themeImgRes.details) log(`[qr] theme-img: ${d}`);
  }

  // 7a2. Patch font-weight cho nút (theme gốc thiếu)
  const btnWO = patchButtonWeight(elements);
  if (btnWO) step('patch-btn-weight', true, 'font-weight: 700');

  // 7a2. Logo: img trong #custom-header + link về homepage
  const logoOk = replaceLogoInHeader(elements, { id: logoMedia.id, url: logoMedia.url }, inputs.homeLink || '');
  step('replace-logo', logoOk, logoOk ? `logo #${logoMedia.id}` : 'không tìm thấy #custom-header');

  // 7b. Tokens text (hiển thị đầy đủ: tên, zip, mail, phone, địa chỉ, social)
  const tokens = {
    '{{ten}}': businessName,
    '{{zip}}': zip,
    '{{dia_chi}}': wpmData.address || '',
    '{{phone}}': wpmData.phone || '',
    '{{email}}': shopEmail,
    '{{soc_fb}}': socialLinks.facebook,
    '{{soc_ig}}': socialLinks.instagram,
    '{{soc_yelp}}': socialLinks.yelp,
    '{{soc_gg}}': socialLinks.google,
    '{{soc_tiktok}}': inputs.tiktok || '',
    '{{soc_youtube}}': inputs.youtube || '',
    '{{link_home}}': inputs.homeLink || '',
    '{{home_link}}': inputs.homeLink || '',
    '{{link_menu}}': inputs.menuLink || '',
    '{{menu_link}}': inputs.menuLink || '',
    '{{link_rv_gg}}': reviewLinks.google || '',
    '{{link_rv_yelp}}': reviewLinks.yelp || '',
  };
  const tokenCount = replaceTokens(elements, tokens);
  step('replace-tokens', true, `${tokenCount} chỗ`);

  // 7c. Màu → CSS variables
  const colorCount = replaceColors(elements, [
    { hex: '#1D1BE0', variable: '--qr-primary' },
    { hex: '#567445', variable: '--qr-secondary' },
  ]);
  // Build CSS variables: primary/secondary/logo-filter + soft/text tự sinh từ primary
  // (tool fill trực tiếp để không phụ thuộc JS của theme)
  const cssVars = {
    '--qr-primary': primary,
    '--qr-secondary': secondary,
    '--qr-logo-filter': inputs.logoFilter ? 'brightness(0) invert(1)' : 'none',
    ...deriveThemeColors(primary),
  };
  const cssVarsBlock = buildCssVariablesBlock(cssVars);
  const cssOk = replaceCssVariables(elements, cssVars);
  step('replace-colors', true, `${colorCount} chỗ, primary=${primary}, secondary=${secondary}`);
  step('css-variables', cssOk, cssOk ? 'đã thay trong widget' : 'không tìm thấy widget CSS');

  // 7d. Rebind CF7 (nếu có form)
  if (cf7Form) {
    const cf7Count = rebindCF7(elements, cf7Form.id);
    step('rebind-cf7', true, `${cf7Count} widget`);
  }

  // 7e. Xóa nút review nếu user xóa trống ô input
  let removedGg = 0, removedYelp = 0;
  if (ggResult.action === 'remove') removedGg = removeReviewCta(elements, 'google');
  if (yelpResult.action === 'remove') removedYelp = removeReviewCta(elements, 'yelp');
  if (removedGg || removedYelp) step('remove-cta', true, `google=${removedGg}, yelp=${removedYelp}`);

  // 9. Ghi data đã mutate vào page (custom endpoint đã fix wp_slash)
  const written = await wpSetElementorData(pageId, elements);
  step('write-elementor', true, `${countElements(elements)} elements, ${written.bytes} bytes`);

  // 10. Publish page
  const published = await wpPublishPage(pageId);
  step('publish', true, `#${pageId}`);
  result.page = { id: pageId, slug, url: published.link || `${getWpBase()}/${slug}/` };

  // 11. Regenerate CSS
  await wpRegenerateElementorCss(pageId);
  step('regenerate-css', true);

  // 12. Verify bằng GET (trigger render thật, không phải HEAD)
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 25000);
    const res = await fetch(result.page.url, { signal: ctrl.signal });
    clearTimeout(t);
    const body = await res.text();
    const hasCritical = /critical error/i.test(body);
    if (res.ok && !hasCritical) {
      step('verify', true, `HTTP ${res.status}`);
    } else {
      // Đọc PHP fatal log thật từ server
      const elog = await wpGetErrorLog();
      if (elog) {
        log('[qr] PHP fatal log từ server:');
        for (const line of elog.split('\n')) log(`[php] ${line}`);
      }
      step('verify', false, `HTTP ${res.status}${hasCritical ? ' + critical error (xem [php] log)' : ''}`);
    }
  } catch (err) {
    step('verify', false, err.message);
  }

  // CSS variables để inject (trả về cho frontend log)
  result.cssVariables = cssVars;
  result.cssVariablesBlock = cssVarsBlock;

  return result;
  } finally {
    // Luôn xóa mu-plugin tạm sau job (dù thành công hay thất bại)
    if (bridgeInstalled) {
      try {
        await removeBridge(log);
      } catch (err) {
        log(`[qr-bridge] Lỗi xóa plugin: ${err.message} — cần xóa tay: qr-bridge-temp.php`);
      }
    }
  }
}
