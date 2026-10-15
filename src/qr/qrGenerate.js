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
  replaceLogoInHeader,
  buildCssVariablesBlock,
  replaceCssVariables,
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

/** Tokens cho social thêm tay: { tiktok: url } → { '{{soc_tiktok}}': url } */
function buildExtraSocialTokens(socialExtra) {
  const tokens = {};
  try {
    const extra = typeof socialExtra === 'string' ? JSON.parse(socialExtra) : (socialExtra || {});
    for (const [platform, url] of Object.entries(extra)) {
      if (platform && url) tokens[`{{soc_${platform}}}`] = String(url).trim();
    }
  } catch {}
  return tokens;
}

/** Darken hex 50% */
function darkenHex(hex, pct = 50) {  const m = /^#([0-9a-fA-F]{6})$/.exec(String(hex || '').trim());
  if (!m) return '#000000';
  const n = parseInt(m[1], 16);
  const f = 1 - pct / 100;
  const r = Math.round(((n >> 16) & 255) * f);
  const g = Math.round(((n >> 8) & 255) * f);
  const b = Math.round((n & 255) * f);
  return '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase();
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
    // Darken chỉ áp dụng cho hex; gradient thì dùng stop cuối
    secondaryRaw = isHex(primary) ? darkenHex(primary.slice(0, 7), 50) : primary;
  }
  secondaryRaw = secondaryRaw.toUpperCase();
  if (!isHex(secondaryRaw) && !isGradient(secondaryRaw)) throw new Error('Màu phụ không hợp lệ (hex hoặc gradient)');
  const secondary = secondaryRaw;
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

  // 7a. Media (bg sections + hình form)
  const mediaCount = replaceMedia(elements, [
    { ...OLD_ATTACHMENTS.bgSections, newId: bg1Media.id, newUrl: bg1Media.url },
    { ...OLD_ATTACHMENTS.formLeft, newId: bg2Media.id, newUrl: bg2Media.url },
  ]);
  step('replace-media', true, `${mediaCount} chỗ`);

  // 7a2. Logo: img duy nhất trong #custom-header
  const logoOk = replaceLogoInHeader(elements, { id: logoMedia.id, url: logoMedia.url });
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
    ...buildExtraSocialTokens(inputs.socialExtra),
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
  // Build CSS variables block để inject vào page
  const cssVars = {
    '--qr-primary': primary,
    '--qr-secondary': secondary,
    '--qr-logo-filter': inputs.logoFilter ? 'brightness(0) invert(1)' : 'none',
  };
  const cssVarsBlock = buildCssVariablesBlock(cssVars);
  const cssOk = replaceCssVariables(elements, cssVarsBlock);
  step('replace-colors', true, `${colorCount} chỗ, primary=${primary}, secondary=${secondary}`);
  step('css-variables', cssOk, cssOk ? 'đã thay trong widget' : 'không tìm thấy widget CSS');

  // 7d. Rebind CF7
  const cf7Count = rebindCF7(elements, cf7Form.id);
  step('rebind-cf7', true, `${cf7Count} widget`);

  // 7e. Xóa nút review nếu user xóa trống ô input
  let removedGg = 0, removedYelp = 0;
  if (ggResult.action === 'remove') removedGg = removeReviewCta(elements, 'google');
  if (yelpResult.action === 'remove') removedYelp = removeReviewCta(elements, 'yelp');
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
