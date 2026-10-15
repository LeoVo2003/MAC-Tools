/**
 * QR Generate orchestration — điều phối toàn bộ flow tạo QR landing page.
 */
import {
  wpUploadMedia,
  wpGetElementorData,
  wpCreateCF7Form,
  wpFindPageBySlug,
  wpCreatePage,
  wpUpdatePage,
  wpRegenerateElementorCss,
  wpConfigOk,
} from './wpClient.js';
import {
  replaceMedia,
  replaceTokens,
  replaceColors,
  rebindCF7,
  removeReviewCta,
  slugify,
  countElements,
} from './elementor.js';
import { installBridge, removeBridge } from './sftpBridge.js';

const TEMPLATE_ID = Number(process.env.QR_TEMPLATE_ID) || 2806;

// Mapping attachment cũ trong template (đã chốt với user 2026-10-15)
const OLD_ATTACHMENTS = {
  bgSections: { id: 9508, url: 'https://quan.macmarketing.us/wp-content/uploads/2026/10/324-nprod-1-1-hori-cc-beige-brown.jpg' },
  formLeft: { id: 9509, url: 'https://quan.macmarketing.us/wp-content/uploads/2026/10/595-nhm-1-1-hori-cc-white-pink.jpg' },
  // 9507 (placeholder) và 9510 (dưới form): giữ nguyên
};

/** Darken hex 50% */
function darkenHex(hex, pct = 50) {
  const m = /^#([0-9a-fA-F]{6})$/.exec(String(hex || '').trim());
  if (!m) return '#000000';
  const n = parseInt(m[1], 16);
  const f = 1 - pct / 100;
  const r = Math.round(((n >> 16) & 255) * f);
  const g = Math.round(((n >> 8) & 255) * f);
  const b = Math.round((n & 255) * f);
  return '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase();
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
  if (!/^#[0-9a-fA-F]{6}$/.test(primary)) throw new Error('Màu chính không hợp lệ');
  const secondary = inputs.secondary?.trim() || darkenHex(primary, 50);
  step('validate', true, `${title} / ${slug}`);

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
  const [logoMedia, bg1Media, bg2Media] = await Promise.all([
    wpUploadMedia(logoFile.buffer, logoFile.filename, logoFile.mimetype),
    wpUploadMedia(bg1File.buffer, bg1File.filename, bg1File.mimetype),
    wpUploadMedia(bg2File.buffer, bg2File.filename, bg2File.mimetype),
  ]);
  step('upload', true, `logo=${logoMedia.id}, bg1=${bg1Media.id}, bg2=${bg2Media.id}`);
  result.media = { logo: logoMedia, bg1: bg1Media, bg2: bg2Media };

  // 4. Review links: manual → derive từ social → ẩn nút
  const reviewLinks = {};
  // Google
  if (inputs.reviewGg?.trim() && !inputs.reviewGg.includes('#link_')) {
    reviewLinks.google = inputs.reviewGg.trim();
  } else if (wpmData.social?.google) {
    // TODO: gọi worker convert khi có social URL
    reviewLinks.google = wpmData.social.google; // tạm, sẽ convert ở bước sau
  }
  // Yelp
  if (inputs.reviewYelp?.trim() && !inputs.reviewYelp.includes('#link_')) {
    reviewLinks.yelp = inputs.reviewYelp.trim();
  } else if (wpmData.social?.yelp) {
    reviewLinks.yelp = wpmData.social.yelp;
  }
  step('review-links', true, `google=${reviewLinks.google ? 'có' : 'ẩn'}, yelp=${reviewLinks.yelp ? 'có' : 'ẩn'}`);

  // 5. Tạo CF7 form
  const cf7Title = title;
  const shopEmail = wpmData.email || '';
  const cf7Form = await wpCreateCF7Form({
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

  // 6. Lấy template Elementor
  const templateData = await wpGetElementorData(TEMPLATE_ID);
  if (!Array.isArray(templateData)) throw new Error('Template _elementor_data không phải array');
  step('template', true, `${countElements(templateData)} elements`);

  // 7. Replace
  const elements = JSON.parse(JSON.stringify(templateData)); // deep clone

  // 7a. Media
  const mediaCount = replaceMedia(elements, [
    { ...OLD_ATTACHMENTS.bgSections, newId: bg1Media.id, newUrl: bg1Media.url },
    { ...OLD_ATTACHMENTS.formLeft, newId: bg2Media.id, newUrl: bg2Media.url },
    // Logo: tìm image widget trống ở hero (id=0 hoặc không có) → thay bằng logo mới
    // Tạm: replace mọi image có url rỗng hoặc placeholder logo
  ]);
  // Logo: tìm widget image đầu tiên (hero) — heuristic
  // TODO: cần xác định chính xác widget logo trong template 2806
  step('replace-media', true, `${mediaCount} chỗ`);

  // 7b. Tokens text
  const tokens = {
    '{{ten}}': businessName,
    '{{dia_chi}}': wpmData.address || '',
    '{{phone}}': wpmData.phone || '',
    '{{email}}': shopEmail,
    '{{soc_fb}}': wpmData.social?.facebook || '',
    '{{soc_ig}}': wpmData.social?.instagram || '',
    '{{soc_yelp}}': wpmData.social?.yelp || '',
    '{{soc_gg}}': wpmData.social?.google || '',
    '{{link_home}}': inputs.homeLink || '',
    '{{link_menu}}': inputs.menuLink || '',
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
  // Inject CSS variables vào page (qua custom CSS)
  // TODO: cần xác định cách inject vào template 2806 (page settings custom_css)
  step('replace-colors', true, `${colorCount} chỗ, primary=${primary}, secondary=${secondary}`);

  // 7d. Rebind CF7
  const cf7Count = rebindCF7(elements, cf7Form.id);
  step('rebind-cf7', true, `${cf7Count} widget`);

  // 7e. Ẩn nút review nếu không có link
  let removedGg = 0, removedYelp = 0;
  if (!reviewLinks.google) removedGg = removeReviewCta(elements, 'google');
  if (!reviewLinks.yelp) removedYelp = removeReviewCta(elements, 'yelp');
  if (removedGg || removedYelp) step('remove-cta', true, `google=${removedGg}, yelp=${removedYelp}`);

  // 8. Tạo/update page
  let page;
  if (existing && force) {
    page = await wpUpdatePage(existing.id, { title, elementorData: elements });
    step('page', true, `updated #${existing.id}`);
  } else {
    page = await wpCreatePage({ title, slug, elementorData: elements });
    step('page', true, `created #${page.id}`);
  }
  result.page = { id: page.id, slug, url: page.link || `https://qr.macmarketing.us/${slug}/` };

  // 9. Regenerate CSS
  await wpRegenerateElementorCss(page.id);
  step('regenerate-css', true);

  // 10. Verify
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 15000);
    const res = await fetch(result.page.url, { signal: ctrl.signal, method: 'HEAD' });
    clearTimeout(t);
    step('verify', res.ok, `HTTP ${res.status}`);
  } catch (err) {
    step('verify', false, err.message);
  }

  // CSS variables để inject (trả về cho frontend log)
  result.cssVariables = {
    '--qr-primary': primary,
    '--qr-secondary': secondary,
    '--qr-logo-filter': inputs.logoFilter ? 'brightness(0) invert(1)' : 'none',
  };

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
