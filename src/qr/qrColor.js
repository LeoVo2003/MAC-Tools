/**
 * qrColor.js — nguồn DUY NHẤT cho logic màu QR (dùng chung server + browser preview).
 * OKLCH để sinh màu (đều theo cảm nhận), WCAG 2.x để chọn màu chữ (đo contrast thật).
 */
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

// ---------- parse ----------
export function parseHex(str) {
  const m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(String(str || '').trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: m[2] ? parseInt(m[2], 16) / 255 : 1 };
}
export const isGradient = (v) => /^(repeating-)?(linear|radial|conic)-gradient\(/i.test(String(v || '').trim());
/** Lấy các màu stop (hex) trong gradient. */
export function gradientStops(g) {
  return [...String(g).matchAll(/#[0-9a-f]{6}(?:[0-9a-f]{2})?\b/gi)].map((m) => m[0]);
}

// ---------- sRGB <-> linear <-> OKLab/OKLCH ----------
const toLin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const toSrgb = (c) => { c = c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055; return c * 255; };

export function rgbToOklch({ r, g, b }) {
  const [R, G, B] = [toLin(r), toLin(g), toLin(b)];
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const Bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return { L, C: Math.hypot(A, Bb), h: ((Math.atan2(Bb, A) * 180) / Math.PI + 360) % 360 };
}
function oklchToLinear({ L, C, h }) {
  const a = C * Math.cos((h * Math.PI) / 180), b = C * Math.sin((h * Math.PI) / 180);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}
const inGamut = (lin) => lin.every((v) => v >= -0.0005 && v <= 1.0005);
/** OKLCH → hex, tự giảm chroma cho tới khi nằm trong sRGB (không bị neon/clip méo hue). */
export function oklchToHex({ L, C, h }) {
  L = clamp(L, 0, 1);
  let c = Math.max(0, C), lin = oklchToLinear({ L, C: c, h });
  for (let i = 0; i < 40 && !inGamut(lin); i++) { c *= 0.93; lin = oklchToLinear({ L, C: c, h }); }
  const to = (v) => Math.round(clamp(toSrgb(clamp(v, 0, 1)), 0, 255)).toString(16).padStart(2, '0');
  return `#${to(lin[0])}${to(lin[1])}${to(lin[2])}`.toUpperCase();
}

// ---------- WCAG ----------
export function luminance(hex) {
  const c = parseHex(hex); if (!c) return 0;
  return 0.2126 * toLin(c.r) + 0.7152 * toLin(c.g) + 0.0722 * toLin(c.b);
}
export function contrast(a, b) {
  const x = luminance(a), y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
/** Chọn màu chữ tốt nhất cho 1 hoặc nhiều nền (gradient → xét mọi stop, tối đa hoá contrast tệ nhất). */
export function pickTextColor(bgs, { light = '#FFFFFF', dark = '#141414', pure = ['#000000'] } = {}) {
  const list = Array.isArray(bgs) ? bgs : [bgs];
  const worst = (t) => Math.min(...list.map((b) => contrast(b, t)));
  let best = worst(light) >= worst(dark) ? light : dark;
  if (worst(best) < 4.5) { // fallback đen/trắng tuyệt đối
    for (const t of [light === best ? '#000000' : '#FFFFFF', ...pure]) if (worst(t) > worst(best)) best = t;
  }
  return { color: best, ratio: +worst(best).toFixed(2) };
}

// ---------- input an toàn ----------
/**
 * Chuẩn hoá input màu từ form. Trả về chuỗi đã sạch hoặc ném lỗi.
 * - hex: nhận "e31e24", "#e31", "#E31E24", "#E31E24CC" → "#E31E24" / "#E31E24CC"
 * - gradient: chỉ cho ký tự an toàn, ngoặc cân, 2+ stop hex (chặn chèn CSS/HTML vào <style>)
 */
export function sanitizeColorInput(v) {
  let s = String(v || '').trim();
  if (!s) throw new Error('Màu trống');
  if (isGradient(s)) {
    if (s.length > 300 || !/^[#0-9a-zA-Z(),.%\s-]+$/.test(s)) throw new Error('Gradient chứa ký tự không hợp lệ');
    let depth = 0;
    for (const ch of s) { if (ch === '(') depth++; if (ch === ')') depth--; if (depth < 0) break; }
    if (depth !== 0) throw new Error('Gradient sai ngoặc');
    if (gradientStops(s).length < 2) throw new Error('Gradient cần ít nhất 2 màu dạng #RRGGBB');
    return s;
  }
  s = s.replace(/^#?/, '#');
  if (/^#[0-9a-f]{3}$/i.test(s)) s = '#' + [...s.slice(1)].map((c) => c + c).join('');
  if (!parseHex(s)) throw new Error('Màu phải là hex (#RRGGBB) hoặc linear/radial-gradient(...)');
  return s.toUpperCase();
}

/** Filter CSS cho logo đặt trên nền primary: auto = trắng nếu chữ trên primary là trắng, ngược lại đen. */
export function logoFilterCss(mode, textOnPrimary) {
  if (mode === 'white') return 'brightness(0) invert(1)';
  if (mode === 'black') return 'brightness(0)';
  if (mode === 'auto') return String(textOnPrimary).toUpperCase() === '#FFFFFF' ? 'brightness(0) invert(1)' : 'brightness(0)';
  return 'none';
}

// ---------- palette ----------
/** Màu đại diện của primary: hex → chính nó (bỏ alpha); gradient → trung bình các stop trong OKLab. */
export function baseColor(primary) {
  if (isGradient(primary)) {
    const stops = gradientStops(primary).map(parseHex).filter(Boolean);
    if (!stops.length) return null;
    const lch = stops.map(rgbToOklch);
    // trung bình trong OKLab (tránh lỗi trung bình hue)
    const a = lch.map((x) => x.C * Math.cos((x.h * Math.PI) / 180)), b = lch.map((x) => x.C * Math.sin((x.h * Math.PI) / 180));
    const n = lch.length, A = a.reduce((s, v) => s + v, 0) / n, B = b.reduce((s, v) => s + v, 0) / n;
    return { L: lch.reduce((s, x) => s + x.L, 0) / n, C: Math.hypot(A, B), h: ((Math.atan2(B, A) * 180) / Math.PI + 360) % 360 };
  }
  const c = parseHex(primary); return c ? rgbToOklch(c) : null;
}

/**
 * Màu phụ tự sinh: cùng hue, lệch lightness vừa đủ (CR>=1.8) để phân biệt với primary.
 * Ngoại lệ: primary vàng/cam sáng → bản "đậm" của nó là olive/nâu bùn, nên dùng neutral đậm ám hue.
 */
export function deriveSecondary(primary) {
  const p = baseColor(primary); if (!p) return null;
  const primHex = isGradient(primary) ? oklchToHex(p) : primary.slice(0, 7).toUpperCase();
  const warmBright = p.L > 0.78 && p.C > 0.12 && p.h >= 60 && p.h <= 110;
  if (warmBright) return oklchToHex({ L: 0.32, C: 0.045, h: p.h });
  const dir = p.L >= 0.55 ? -1 : +1;
  let best = null;
  for (let d = 0.14; d <= 0.40; d += 0.02) {
    best = oklchToHex({ L: clamp(p.L + dir * d, 0.18, 0.88), C: p.C * 0.92, h: p.h });
    if (contrast(primHex, best) >= 1.8) break;
  }
  return best;
}

/**
 * Toàn bộ biến màu cho template. Luôn trả đủ key (hex / gradient / alpha đều xử lý).
 * @returns {{vars:Object, report:Object}}
 */
export function buildPalette(primaryRaw, secondaryRaw = '') {
  const primary = sanitizeColorInput(primaryRaw);
  const secondaryInput = String(secondaryRaw || '').trim() ? sanitizeColorInput(secondaryRaw) : '';
  const p = baseColor(primary);
  if (!p) throw new Error('Màu chính không hợp lệ');
  const grad = isGradient(primary);
  const primStops = grad ? gradientStops(primary).map((s) => s.slice(0, 7)) : [primary.slice(0, 7)];
  const secondary = secondaryInput || deriveSecondary(primary);
  const secStops = isGradient(secondary) ? gradientStops(secondary).map((s) => s.slice(0, 7)) : [secondary.slice(0, 7)];

  const tint = (L, k, cap) => oklchToHex({ L, C: Math.min(p.C * k, cap), h: p.h });
  const soft = tint(0.955, 0.22, 0.045);          // nền nhạt cho card/section
  const bg   = tint(0.985, 0.06, 0.012);          // nền trang (gần trắng, ám nhẹ hue)
  const ink  = tint(0.24, 0.20, 0.035);           // chữ thân trang (gần đen, ám nhẹ hue)

  // (Review 2 - 1.4) --qr-accent-ink: primary hạ lightness đến khi ≥4.5:1 trên soft
  // Dùng cho heading-3, icon/link cần màu thương hiệu trên nền sáng
  let accentInk = oklchToHex({ L: p.L, C: p.C, h: p.h });
  for (let l = p.L; l > 0.15 && contrast(accentInk, soft) < 4.5; l -= 0.02) {
    accentInk = oklchToHex({ L: l, C: p.C, h: p.h });
  }

  const onPrimary = pickTextColor(primStops), onSecondary = pickTextColor(secStops), onSoft = pickTextColor(soft);
  // (1.5) --qr-primary-bg: gradient giữ nguyên, màu đặc dùng cho background-color
  // Template dùng background: var(--qr-primary-bg) thay vì background-color
  const primBase = oklchToHex({ L: p.L, C: p.C, h: p.h });
  const vars = {
    '--qr-primary': grad ? primBase : primary,  // luôn là màu đặc (cho color, border)
    '--qr-primary-bg': primary,  // gradient hoặc màu đặc (cho background)
    '--qr-secondary': secondary,
    '--qr-primary-soft': soft,
    '--qr-bg': bg,
    '--qr-text': ink,
    '--qr-text-on-primary': onPrimary.color,
    '--qr-text-on-secondary': onSecondary.color,
    '--qr-text-on-soft': onSoft.color,
    '--qr-accent-ink': accentInk,
  };
  const report = {
    onPrimary: onPrimary.ratio, onSecondary: onSecondary.ratio, onSoft: onSoft.ratio,
    textOnBg: +contrast(bg, ink).toFixed(2), textOnSoft: +contrast(soft, ink).toFixed(2),
    primaryVsSecondary: +contrast(primStops[0], secStops[0]).toFixed(2),
    accentInkOnSoft: +contrast(accentInk, soft).toFixed(2),
    warnings: [],
  };
  if (report.onPrimary < 4.5) report.warnings.push(`Chữ trên nút primary chỉ ${report.onPrimary}:1 (<4.5) — nên đổi màu chính.`);
  if (report.onSecondary < 4.5) report.warnings.push(`Chữ trên nút secondary chỉ ${report.onSecondary}:1 (<4.5).`);
  if (report.primaryVsSecondary < 1.3) report.warnings.push('Primary và secondary quá giống nhau.');
  if (p.L > 0.93) report.warnings.push('Màu chính gần trắng — sẽ không nổi trên nền sáng.');
  if (primary.length === 9) report.warnings.push('Primary có alpha — contrast tính trên màu đặc, thực tế sẽ thấp hơn.');
  if (report.accentInkOnSoft < 4.5) report.warnings.push(`Màu nhấn trên nền soft chỉ ${report.accentInkOnSoft}:1 (<4.5).`);
  return { vars, report };
}
