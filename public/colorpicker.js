/* QR Color Picker — Untitled UI style (Solid + Gradient).
 * Popup nhỏ dưới ô màu, áp dụng trực tiếp khi chỉnh. Output luôn là #RRGGBB(AA) hoặc *-gradient(... #hex %). */
(function () {
  'use strict';

  /* ================= Color math ================= */
  const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const lerpPt = (p, q, t) => ({ x: lerp(p.x, q.x, t), y: lerp(p.y, q.y, t) });

  function hsbToRgb(h, s, b) {
    h = ((h % 360) + 360) % 360;
    s = clamp(s, 0, 100) / 100; b = clamp(b, 0, 100) / 100;
    const k = (n) => (n + h / 60) % 6;
    const f = (n) => b * (1 - s * Math.max(0, Math.min(k(n), 4 - k(n), 1)));
    return { r: Math.round(255 * f(5)), g: Math.round(255 * f(3)), b: Math.round(255 * f(1)) };
  }
  function rgbToHsb(r, g, b) {
    r = clamp(r, 0, 255) / 255; g = clamp(g, 0, 255) / 255; b = clamp(b, 0, 255) / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
    let h = 0;
    if (d !== 0) {
      if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) * 60;
      else if (max === g) h = ((b - r) / d + 2) * 60;
      else h = ((r - g) / d + 4) * 60;
    }
    return { h, s: max === 0 ? 0 : (d / max) * 100, b: max * 100 };
  }
  function hsbToHsl(h, s, b) {
    s /= 100; b /= 100;
    const l = b * (1 - s / 2);
    const sl = l === 0 || l === 1 ? 0 : (b - l) / Math.min(l, 1 - l);
    return { h, s: sl * 100, l: l * 100 };
  }
  function hslToHsb(h, s, l) {
    s /= 100; l /= 100;
    const v = l + s * Math.min(l, 1 - l);
    return { h, s: v === 0 ? 0 : 2 * (1 - l / v) * 100, b: v * 100 };
  }
  const hx = (n) => clamp(Math.round(n), 0, 255).toString(16).padStart(2, '0').toUpperCase();
  function toHex(c) {
    const { r, g, b } = hsbToRgb(c.h, c.s, c.b);
    return '#' + hx(r) + hx(g) + hx(b) + (c.a < 1 ? hx(c.a * 255) : '');
  }
  function toCss(c) {
    const { r, g, b } = hsbToRgb(c.h, c.s, c.b);
    return c.a >= 1 ? `rgb(${r},${g},${b})` : `rgba(${r},${g},${b},${+c.a.toFixed(2)})`;
  }
  function parseColor(str) {
    const s = String(str || '').trim();
    let m = /^#?([0-9a-f]{3})$/i.exec(s);
    const full = m ? m[1].split('').map((c) => c + c).join('') : null;
    m = /^#?([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(full || s);
    if (m) {
      const n = parseInt(m[1], 16);
      return { ...rgbToHsb(n >> 16, (n >> 8) & 255, n & 255), a: m[2] ? parseInt(m[2], 16) / 255 : 1 };
    }
    m = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([\d.]+))?\s*\)$/i.exec(s);
    if (m) return { ...rgbToHsb(+m[1], +m[2], +m[3]), a: m[4] !== undefined ? clamp(+m[4], 0, 1) : 1 };
    return null;
  }

  /* ================= Gradient geometry ================= */
  function extendLine(p1, p2) {
    let dx = p2.x - p1.x, dy = p2.y - p1.y;
    if (Math.hypot(dx, dy) < 0.001) { dx = 1; dy = 1; }
    let tMin = -Infinity, tMax = Infinity;
    if (Math.abs(dx) > 1e-6) {
      const a = -p1.x / dx, b = (100 - p1.x) / dx;
      tMin = Math.max(tMin, Math.min(a, b)); tMax = Math.min(tMax, Math.max(a, b));
    }
    if (Math.abs(dy) > 1e-6) {
      const a = -p1.y / dy, b = (100 - p1.y) / dy;
      tMin = Math.max(tMin, Math.min(a, b)); tMax = Math.min(tMax, Math.max(a, b));
    }
    return {
      start: { x: clamp(p1.x + tMin * dx, 0, 100), y: clamp(p1.y + tMin * dy, 0, 100) },
      end: { x: clamp(p1.x + tMax * dx, 0, 100), y: clamp(p1.y + tMax * dy, 0, 100) },
    };
  }
  function project(pt, a, b) {
    const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
    return l2 < 1e-6 ? 0 : clamp(((pt.x - a.x) * dx + (pt.y - a.y) * dy) / l2, 0, 1);
  }
  const angleOf = (a, b) => (((Math.round((Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI + 90)) % 360) + 360) % 360;
  // Đường qua tâm theo góc, kéo ra tới biên; điểm đầu/cuối nằm ở 12% và 88% của đường đó
  function endpointsFromAngle(angle) {
    const rad = ((angle - 90) * Math.PI) / 180;
    const ext = extendLine({ x: 50, y: 50 }, { x: 50 + Math.cos(rad) * 10, y: 50 + Math.sin(rad) * 10 });
    return { a: lerpPt(ext.start, ext.end, 0.12), b: lerpPt(ext.start, ext.end, 0.88) };
  }

  /* ================= State ================= */
  let uid = 0;
  const newStop = (pos, c) => ({ id: ++uid, pos, h: c.h, s: c.s, b: c.b, a: c.a });
  const BRAND = parseColor('#E31E24');
  const DEFAULT_SOLID = () => ({ ...BRAND });
  function defaultGrad() {
    const g = {
      type: 'linear', angle: 135, activeId: 0,
      pStart: { x: 12, y: 12 }, pEnd: { x: 88, y: 88 },
      line: { start: { x: 0, y: 0 }, end: { x: 100, y: 100 } },
      stops: [newStop(12, BRAND), newStop(88, { ...BRAND, b: BRAND.b * 0.5 })],
    };
    g.activeId = g.stops[0].id;
    return g;
  }
  const S = {
    target: null, mode: 'solid', format: 'hex', dirty: false,
    solid: DEFAULT_SOLID(), grad: defaultGrad(),
  };

  const SAVED_KEY = 'qrCpSaved.v1';
  const SAVED_DEFAULT = {
    solid: ['#E31E24', '#F79009', '#12B76A', '#1877F2', '#7F56D9', '#EE46BC', '#101828', '#FFFFFF'],
    grad: [
      'linear-gradient(135deg, #E31E24 0%, #7A0F14 100%)',
      'linear-gradient(135deg, #F79009 0%, #E31E24 100%)',
      'linear-gradient(135deg, #1877F2 0%, #7F56D9 100%)',
      'linear-gradient(135deg, #12B76A 0%, #1877F2 100%)',
      'linear-gradient(135deg, #101828 0%, #475467 100%)',
    ],
  };
  function loadSaved() {
    try {
      const v = JSON.parse(localStorage.getItem(SAVED_KEY));
      if (v && Array.isArray(v.solid) && Array.isArray(v.grad)) return v;
    } catch { /* ignore */ }
    return { solid: [...SAVED_DEFAULT.solid], grad: [...SAVED_DEFAULT.grad] };
  }
  const saved = loadSaved();
  const persistSaved = () => { try { localStorage.setItem(SAVED_KEY, JSON.stringify(saved)); } catch { /* ignore */ } };

  const sortedStops = () => [...S.grad.stops].sort((a, b) => a.pos - b.pos);
  const activeStop = () => S.grad.stops.find((s) => s.id === S.grad.activeId) || S.grad.stops[0];

  function sortStopsInPlace() { S.grad.stops.sort((a, b) => a.pos - b.pos); }
  // Sau khi đổi pos của stop đầu/cuối: đưa pStart/pEnd về đúng vị trí trên line
  function syncEndpointsFromPos() {
    const g = S.grad, all = g.stops;
    sortStopsInPlace();
    g.pStart = lerpPt(g.line.start, g.line.end, all[0].pos / 100);
    g.pEnd = lerpPt(g.line.start, g.line.end, all[all.length - 1].pos / 100);
  }
  function stop2D(index) {
    const g = S.grad, all = g.stops;
    if (index === 0) return g.pStart;
    if (index === all.length - 1) return g.pEnd;
    const span = Math.max(1, all[all.length - 1].pos - all[0].pos);
    return lerpPt(g.pStart, g.pEnd, clamp((all[index].pos - all[0].pos) / span, 0, 1));
  }
  function syncLineFromEndpoints(pS, pE) {
    const g = S.grad, all = g.stops;
    sortStopsInPlace();
    const span0 = Math.max(1, all[all.length - 1].pos - all[0].pos);
    const frac = all.map((st, i) => (i === 0 ? 0 : i === all.length - 1 ? 1 : clamp((st.pos - all[0].pos) / span0, 0.02, 0.98)));
    g.pStart = { x: clamp(pS.x, 0, 100), y: clamp(pS.y, 0, 100) };
    g.pEnd = { x: clamp(pE.x, 0, 100), y: clamp(pE.y, 0, 100) };
    const ext = extendLine(g.pStart, g.pEnd);
    g.line = { start: ext.start, end: ext.end };
    g.angle = angleOf(g.pStart, g.pEnd);
    all[0].pos = Math.round(project(g.pStart, ext.start, ext.end) * 100);
    all[all.length - 1].pos = Math.max(all[0].pos + 1, Math.round(project(g.pEnd, ext.start, ext.end) * 100));
    const span = Math.max(1, all[all.length - 1].pos - all[0].pos);
    all.forEach((st, i) => {
      if (i > 0 && i < all.length - 1) {
        st.pos = clamp(Math.round(all[0].pos + frac[i] * span), all[0].pos + 1, all[all.length - 1].pos - 1);
      }
    });
  }
  function setAngle(angle) {
    const p = endpointsFromAngle(angle);
    syncLineFromEndpoints(p.a, p.b);
    S.grad.angle = ((Math.round(angle) % 360) + 360) % 360;
  }
  function interpolateAt(pos) {
    const all = sortedStops();
    if (pos <= all[0].pos) return { ...all[0] };
    if (pos >= all[all.length - 1].pos) return { ...all[all.length - 1] };
    for (let i = 0; i < all.length - 1; i++) {
      const a = all[i], b = all[i + 1];
      if (pos >= a.pos && pos <= b.pos) {
        const t = (pos - a.pos) / Math.max(1, b.pos - a.pos);
        const ra = hsbToRgb(a.h, a.s, a.b), rb = hsbToRgb(b.h, b.s, b.b);
        const hsb = rgbToHsb(lerp(ra.r, rb.r, t), lerp(ra.g, rb.g, t), lerp(ra.b, rb.b, t));
        return { ...hsb, a: lerp(a.a, b.a, t) };
      }
    }
    return { ...all[0] };
  }

  /* ================= CSS output / parse ================= */
  function stopsCss() { return sortedStops().map((st) => `${toHex(st)} ${Math.round(st.pos)}%`).join(', '); }
  function gradientCss() {
    const g = S.grad, parts = stopsCss();
    if (g.type === 'radial') return `radial-gradient(circle at 50% 50%, ${parts})`;
    if (g.type === 'angular') return `conic-gradient(from ${g.angle}deg at 50% 50%, ${parts})`;
    if (g.type === 'diamond') return `conic-gradient(from ${g.angle}deg at ${Math.round(g.pStart.x)}% ${Math.round(g.pStart.y)}%, ${parts})`;
    return `linear-gradient(${g.angle}deg, ${parts})`;
  }
  const currentValue = () => (S.mode === 'solid' ? toHex(S.solid) : gradientCss());

  function parseGradient(str) {
    const m = String(str).match(/(linear|radial|conic)-gradient\((.*)\)\s*$/is);
    if (!m) return null;
    let type = m[1] === 'conic' ? 'angular' : m[1];
    const parts = [];
    let depth = 0, cur = '';
    for (const ch of m[2]) {
      if (ch === '(') depth++;
      if (ch === ')') depth--;
      if (ch === ',' && depth === 0) { parts.push(cur.trim()); cur = ''; } else cur += ch;
    }
    if (cur.trim()) parts.push(cur.trim());
    let angle = 135, from = 0;
    const deg = parts[0] && parts[0].match(/(-?\d+(?:\.\d+)?)\s*deg/);
    if (deg) { angle = ((Math.round(+deg[1]) % 360) + 360) % 360; from = 1; }
    else if (parts[0] && /circle|ellipse|at\s|from\s/i.test(parts[0])) from = 1;
    if (from && type === 'angular') {
      const at = parts[0].match(/at\s+(\d+)%\s+(\d+)%/i);
      if (at && (+at[1] !== 50 || +at[2] !== 50)) type = 'diamond';
    }
    const stops = [];
    for (let i = from; i < parts.length; i++) {
      const pm = parts[i].match(/(#[0-9a-fA-F]{3,8}|rgba?\([^)]+\))\s*(\d+(?:\.\d+)?)?\s*%?/);
      if (!pm) continue;
      const c = parseColor(pm[1]);
      if (!c) continue;
      stops.push(newStop(pm[2] !== undefined ? clamp(+pm[2], 0, 100) : (i === from ? 0 : 100), c));
    }
    if (stops.length < 2) return null;
    stops.sort((a, b) => a.pos - b.pos);
    return { type, angle, stops };
  }
  function applyGradientValue(str) {
    const p = parseGradient(str);
    if (!p) return false;
    const g = S.grad;
    g.type = p.type; g.stops = p.stops; g.activeId = p.stops[0].id;
    const e = endpointsFromAngle(p.angle);
    const first = p.stops[0].pos, last = p.stops[p.stops.length - 1].pos;
    g.pStart = e.a; g.pEnd = e.b;
    const ext = extendLine(e.a, e.b);
    g.line = { start: ext.start, end: ext.end };
    g.angle = p.angle;
    // đặt pos stop đầu/cuối theo pos đã lưu (không nén lại 0-100)
    g.pStart = lerpPt(ext.start, ext.end, first / 100);
    g.pEnd = lerpPt(ext.start, ext.end, last / 100);
    return true;
  }

  /* ================= DOM ================= */
  const ICON = {
    eye: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m2 22 1-1h3l9-9"/><path d="M3 21v-3l9-9"/><path d="m15 6 3.4-3.4a2.1 2.1 0 1 1 3 3L18 9l.4.4a2.1 2.1 0 1 1-3 3l-3.8-3.8a2.1 2.1 0 1 1 3-3l.4.4Z"/></svg>',
    swap: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/></svg>',
    plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
    minus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M5 12h14"/></svg>',
  };
  const HAS_EYEDROPPER = typeof window.EyeDropper === 'function';
  const eyeBtn = (id) => `<button type="button" id="${id}" class="cp-icon-btn" title="Lấy màu từ màn hình" aria-label="Lấy màu từ màn hình" ${HAS_EYEDROPPER ? '' : 'hidden'}>${ICON.eye}</button>`;

  const pop = document.createElement('div');
  pop.className = 'qr-cp-pop';
  pop.hidden = true;
  pop.innerHTML = `
    <div class="cp-dialog" role="dialog" aria-label="Chọn màu">
      <div class="cp-tabs" role="tablist">
        <button type="button" class="cp-tab" data-mode="solid" role="tab">Solid</button>
        <button type="button" class="cp-tab" data-mode="gradient" role="tab">Gradient</button>
      </div>

      <div class="cp-pane" data-pane="solid">
        <div id="s-area" class="cp-area" tabindex="0" role="slider" aria-label="Độ bão hòa và độ sáng">
          <div class="cp-area-white"></div><div class="cp-area-black"></div>
          <div id="s-thumb" class="cp-thumb"></div>
        </div>
        <div class="cp-row">
          ${eyeBtn('s-eye')}
          <div class="cp-sliders">
            <div id="s-hue" class="cp-slider cp-hue" tabindex="0" role="slider" aria-label="Hue"><div id="s-hue-t" class="cp-slider-thumb"></div></div>
            <div id="s-alpha" class="cp-slider cp-check" tabindex="0" role="slider" aria-label="Độ trong suốt">
              <div class="cp-slider-clip"><div id="s-alpha-f" class="cp-slider-fill"></div></div>
              <div id="s-alpha-t" class="cp-slider-thumb"></div>
            </div>
          </div>
        </div>
        <div class="cp-row">
          <select id="s-format" class="cp-select" aria-label="Định dạng màu">
            <option value="hex">Hex</option><option value="rgb">RGB</option><option value="hsl">HSL</option>
          </select>
          <div id="s-inputs" class="cp-group"></div>
        </div>
        <div class="cp-section">
          <div class="cp-section-head"><span>Đã lưu</span><button type="button" id="s-save" class="cp-add">${ICON.plus}<span>Thêm</span></button></div>
          <div id="s-saved" class="cp-swatches"></div>
        </div>
      </div>

      <div class="cp-pane" data-pane="gradient" hidden>
        <div id="g-area" class="cp-area cp-grad-area cp-check" role="group" aria-label="Hướng gradient và các điểm màu">
          <div id="g-fill" class="cp-grad-fill"></div>
          <svg class="cp-grad-svg" aria-hidden="true">
            <line id="g-line" stroke="rgba(255,255,255,.7)" stroke-width="2" stroke-dasharray="3 5" stroke-linecap="round"/>
          </svg>
          <div id="g-handles" class="cp-grad-handles"></div>
        </div>
        <div class="cp-row">
          <select id="g-type" class="cp-select is-grow" aria-label="Kiểu gradient">
            <option value="linear">Linear</option><option value="radial">Radial</option>
            <option value="angular">Angular</option><option value="diamond">Diamond</option>
          </select>
          <div class="cp-cell is-solo" title="Góc (độ)"><input id="g-angle" inputmode="numeric" aria-label="Góc gradient"></div>
          <button type="button" id="g-reverse" class="cp-icon-btn" title="Đảo ngược" aria-label="Đảo ngược gradient">${ICON.swap}</button>
        </div>
        <div id="g-bar" class="cp-slider cp-bar cp-check" role="group" aria-label="Vị trí các điểm màu (bấm để thêm)">
          <div class="cp-slider-clip"><div id="g-bar-f" class="cp-slider-fill"></div></div>
          <div id="g-bar-h"></div>
        </div>
        <div class="cp-stop-panel">
          <div class="cp-stop-head">
            <span id="g-stop-title" class="cp-stop-title">Stop #1</span>
            <button type="button" id="g-eye" class="cp-link" ${HAS_EYEDROPPER ? '' : 'hidden'}>${ICON.eye}<span>Lấy màu</span></button>
          </div>
          <div id="g-hue" class="cp-slider cp-hue" tabindex="0" role="slider" aria-label="Hue điểm màu"><div id="g-hue-t" class="cp-slider-thumb"></div></div>
          <div id="g-alpha" class="cp-slider cp-check" tabindex="0" role="slider" aria-label="Độ trong suốt điểm màu">
            <div class="cp-slider-clip"><div id="g-alpha-f" class="cp-slider-fill"></div></div>
            <div id="g-alpha-t" class="cp-slider-thumb"></div>
          </div>
        </div>
        <div class="cp-section">
          <div class="cp-section-head"><span>Điểm màu</span><button type="button" id="g-add" class="cp-add">${ICON.plus}<span>Thêm</span></button></div>
          <div id="g-stops" class="cp-stops"></div>
        </div>
        <div class="cp-section">
          <div class="cp-section-head"><span>Đã lưu</span><button type="button" id="g-save" class="cp-add">${ICON.plus}<span>Thêm</span></button></div>
          <div id="g-saved" class="cp-swatches"></div>
        </div>
      </div>

      <div class="cp-foot">
        <button type="button" id="cp-clear" class="cp-btn cp-btn-ghost">Xóa màu</button>
        <button type="button" id="cp-done" class="cp-btn cp-btn-primary">Xong</button>
      </div>
    </div>`;
  const $ = (id) => pop.querySelector('#' + id);
  const MAX_STOPS = 6;

  /* ================= Render ================= */
  const aGrad = (c) => {
    const { r, g, b } = hsbToRgb(c.h, c.s, c.b);
    return `linear-gradient(to right, rgba(${r},${g},${b},0), rgb(${r},${g},${b}))`;
  };
  function placeSliders(prefix, c) {
    $(prefix + '-hue-t').style.left = (c.h / 360) * 100 + '%';
    $(prefix + '-hue-t').style.background = `hsl(${c.h},100%,50%)`;
    $(prefix + '-alpha-f').style.background = aGrad(c);
    $(prefix + '-alpha-t').style.left = c.a * 100 + '%';
    $(prefix + '-alpha-t').style.background = toCss(c);
  }

  function renderSolid() {
    const c = S.solid;
    $('s-area').style.backgroundColor = `hsl(${c.h},100%,50%)`;
    $('s-thumb').style.left = c.s + '%';
    $('s-thumb').style.top = 100 - c.b + '%';
    $('s-thumb').style.background = toCss({ ...c, a: 1 });
    placeSliders('s', c);
    $('s-format').value = S.format;
    renderSolidInputs();
    renderSwatches('solid');
  }

  // Ô nhập theo định dạng: Hex | RGB | HSL (+ alpha %)
  function solidFieldValues() {
    const c = S.solid, rgb = hsbToRgb(c.h, c.s, c.b), hsl = hsbToHsl(c.h, c.s, c.b);
    const a = Math.round(c.a * 100) + '%';
    if (S.format === 'rgb') return [rgb.r, rgb.g, rgb.b, a];
    if (S.format === 'hsl') return [Math.round(hsl.h), Math.round(hsl.s), Math.round(hsl.l), a];
    return [toHex({ ...c, a: 1 }), a];
  }
  let builtFormat = '';
  function renderSolidInputs() {
    const box = $('s-inputs');
    const vals = solidFieldValues();
    if (builtFormat !== S.format) {
      builtFormat = S.format;
      box.innerHTML = '';
      vals.forEach((_, i) => {
        const last = i === vals.length - 1;
        const cell = document.createElement('div');
        cell.className = 'cp-cell' + (last ? ' is-alpha' : '') + (S.format === 'hex' && i === 0 ? ' is-wide' : '');
        const inp = document.createElement('input');
        inp.setAttribute('aria-label', last ? 'Độ đục %' : ['Giá trị 1', 'Giá trị 2', 'Giá trị 3'][i]);
        if (S.format === 'hex' && i === 0) { inp.className = 'cp-mono'; inp.spellcheck = false; }
        inp.addEventListener('change', onSolidInput);
        cell.appendChild(inp);
        box.appendChild(cell);
      });
    }
    box.querySelectorAll('input').forEach((inp, i) => { if (document.activeElement !== inp) inp.value = vals[i]; });
  }
  function onSolidInput() {
    const ins = [...$('s-inputs').querySelectorAll('input')].map((i) => i.value.trim());
    const num = (v) => parseFloat(String(v).replace(/[^0-9.-]/g, ''));
    const al = num(ins[ins.length - 1]);
    const a = Number.isFinite(al) ? clamp(al, 0, 100) / 100 : S.solid.a;
    if (S.format === 'hex') {
      const p = parseColor(ins[0]);
      if (p) S.solid = { h: p.h, s: p.s, b: p.b, a };
    } else if (S.format === 'rgb') {
      const [r, g, b] = ins.slice(0, 3).map(num);
      if ([r, g, b].every(Number.isFinite)) S.solid = { ...rgbToHsb(r, g, b), a };
    } else {
      const [h, s, l] = ins.slice(0, 3).map(num);
      if ([h, s, l].every(Number.isFinite)) S.solid = { ...hslToHsb(((h % 360) + 360) % 360, clamp(s, 0, 100), clamp(l, 0, 100)), a };
    }
    update();
  }

  function renderSwatches(kind) {
    const box = $(kind === 'solid' ? 's-saved' : 'g-saved');
    box.innerHTML = '';
    const cur = currentValue().toUpperCase();
    if (!saved[kind].length) {
      box.innerHTML = '<span class="cp-hint">Chưa có màu nào — bấm Thêm để lưu.</span>';
      return;
    }
    saved[kind].forEach((val, idx) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'cp-swatch' + (S.mode === kind && val.toUpperCase() === cur ? ' on' : '');
      b.style.background = val;
      b.title = val + ' — chuột phải để xóa';
      b.setAttribute('aria-label', 'Màu đã lưu ' + val);
      b.addEventListener('click', () => {
        if (kind === 'solid') {
          const p = parseColor(val);
          if (p) S.solid = p;
        } else if (!applyGradientValue(val)) return;
        update();
      });
      b.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        saved[kind].splice(idx, 1);
        persistSaved();
        renderSwatches(kind);
      });
      box.appendChild(b);
    });
  }

  function renderGradient(skipList) {
    const g = S.grad;
    sortStopsInPlace();
    $('g-fill').style.background = gradientCss();
    const line = $('g-line');
    line.setAttribute('x1', g.pStart.x + '%'); line.setAttribute('y1', g.pStart.y + '%');
    line.setAttribute('x2', g.pEnd.x + '%'); line.setAttribute('y2', g.pEnd.y + '%');
    $('g-type').value = g.type;
    $('g-angle').disabled = g.type === 'radial';
    if (document.activeElement !== $('g-angle')) $('g-angle').value = g.angle + '°';
    $('g-bar-f').style.background = `linear-gradient(90deg, ${stopsCss()})`;
    renderHandles();
    if (skipList) {
      $('g-stops').querySelectorAll('.cp-stop-row').forEach((r) => r.classList.toggle('on', +r.dataset.id === g.activeId));
    } else renderStopList();
    const st = activeStop();
    const idx = g.stops.indexOf(st) + 1;
    $('g-stop-title').textContent = `Stop #${idx} (${Math.round(st.pos)}%)`;
    placeSliders('g', st);
    $('g-add').disabled = g.stops.length >= MAX_STOPS;
    renderSwatches('grad');
  }

  function renderHandles() {
    const g = S.grad;
    const areaBox = $('g-handles'), barBox = $('g-bar-h');
    areaBox.innerHTML = ''; barBox.innerHTML = '';
    g.stops.forEach((st, i) => {
      const color = toCss(st), on = st.id === g.activeId ? 'true' : 'false';
      const pt = stop2D(i);
      const mk = (left, top, drag) => {
        const h = document.createElement('button');
        h.type = 'button'; h.className = 'cp-handle';
        h.style.left = left + '%'; if (top != null) h.style.top = top + '%';
        h.style.background = color; h.dataset.active = on;
        h.setAttribute('aria-label', `Điểm màu ${Math.round(st.pos)}%`);
        h.addEventListener('pointerdown', (e) => drag(e, st, h));
        return h;
      };
      areaBox.appendChild(mk(pt.x, pt.y, dragStop2D));
      barBox.appendChild(mk(st.pos, null, dragStopBar));
    });
  }

  function renderStopList() {
    const g = S.grad, box = $('g-stops');
    box.innerHTML = '';
    g.stops.forEach((st) => {
      const row = document.createElement('div');
      row.className = 'cp-stop-row' + (st.id === g.activeId ? ' on' : '');
      row.dataset.id = st.id;
      const mkCell = (cls, aria, val, onChange) => {
        const cell = document.createElement('div'); cell.className = 'cp-cell ' + cls;
        const inp = document.createElement('input'); inp.value = val; inp.setAttribute('aria-label', aria);
        inp.addEventListener('focus', () => { if (g.activeId !== st.id) { g.activeId = st.id; renderGradient(true); } });
        inp.addEventListener('change', () => onChange(inp.value));
        cell.appendChild(inp);
        return { cell, inp };
      };
      const pos = mkCell('is-solo is-pos', 'Vị trí %', Math.round(st.pos) + '%', (v) => {
        const n = parseInt(String(v).replace(/[^0-9]/g, ''), 10);
        if (!Number.isNaN(n)) { st.pos = clamp(n, 0, 100); syncEndpointsFromPos(); }
        update();
      });
      const group = document.createElement('div'); group.className = 'cp-group';
      const hex = mkCell('is-wide is-hex', 'Màu hex', toHex({ ...st, a: 1 }), (v) => {
        const p = parseColor(v);
        if (p) { st.h = p.h; st.s = p.s; st.b = p.b; }
        update();
      });
      hex.inp.className = 'cp-mono is-left';
      const dot = document.createElement('button');
      dot.type = 'button'; dot.className = 'cp-dot'; dot.style.background = toCss({ ...st, a: 1 }); dot.title = 'Chọn điểm màu này';
      dot.addEventListener('click', () => { g.activeId = st.id; renderGradient(); });
      hex.cell.insertBefore(dot, hex.inp);
      const al = mkCell('is-alpha', 'Độ đục %', Math.round(st.a * 100) + '%', (v) => {
        const n = parseFloat(String(v).replace(/[^0-9.]/g, ''));
        if (Number.isFinite(n)) st.a = clamp(n, 0, 100) / 100;
        update();
      });
      group.append(hex.cell, al.cell);
      const del = document.createElement('button');
      del.type = 'button'; del.className = 'cp-stop-del'; del.innerHTML = ICON.minus;
      del.setAttribute('aria-label', 'Xóa điểm màu'); del.disabled = g.stops.length <= 2;
      del.addEventListener('click', () => {
        if (g.stops.length <= 2) return;
        g.stops = g.stops.filter((s) => s.id !== st.id);
        if (g.activeId === st.id) g.activeId = g.stops[0].id;
        syncEndpointsFromPos();
        update();
      });
      row.append(pos.cell, group, del);
      box.appendChild(row);
    });
  }

  function renderTabs() {
    pop.querySelectorAll('.cp-tab').forEach((b) => {
      const on = b.dataset.mode === S.mode;
      b.dataset.active = on ? 'true' : 'false';
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    pop.querySelectorAll('.cp-pane').forEach((p) => { p.hidden = p.dataset.pane !== S.mode; });
  }
  function render() {
    renderTabs();
    if (S.mode === 'solid') renderSolid(); else renderGradient();
  }

  /* ================= Apply (live) ================= */
  function paintSwatch(el, val) {
    if (!el) return;
    el.classList.toggle('qr-cp-empty', !val);
    el.style.background = val || '';
  }
  function writeValue(val) {
    const t = S.target;
    if (!t) return;
    S.dirty = true;
    t.input.value = val;
    paintSwatch(t.swatch, val);
    t.input.dispatchEvent(new Event('input', { bubbles: true }));
  }
  // render + áp dụng ngay vào input
  function update() { render(); writeValue(currentValue()); }

  /* ================= Drag helpers ================= */
  function dragWindow(onMove, onEnd) {
    const up = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      if (onEnd) onEnd();
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  }
  function dragXY(el, fn) {
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 && e.pointerType === 'mouse') return;
      e.preventDefault();
      el.focus?.();
      const move = (ev) => {
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height) return;
        fn(clamp((ev.clientX - r.left) / r.width, 0, 1), clamp((ev.clientY - r.top) / r.height, 0, 1));
        update();
      };
      move(e);
      dragWindow(move);
    });
  }
  const arrowKeys = (el, get, set, fn) => el.addEventListener('keydown', (e) => {
    const step = e.shiftKey ? 10 : 2;
    const d = { ArrowRight: [1, 0], ArrowLeft: [-1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] }[e.key];
    if (!d) return;
    e.preventDefault();
    const c = get();
    fn(c, d, step);
    set(c);
    update();
  });

  function dragStop2D(e, st, handleEl) {
    e.stopPropagation(); e.preventDefault();
    const g = S.grad;
    g.activeId = st.id;
    const idx = g.stops.indexOf(st);
    const isFirst = idx === 0, isLast = idx === g.stops.length - 1;
    const sS = { ...g.pStart }, sE = { ...g.pEnd };
    handleEl.dataset.dragging = 'true';
    const area = $('g-area');
    renderGradient();
    dragWindow((ev) => {
      const r = area.getBoundingClientRect();
      if (!r.width || !r.height) return;
      const p = { x: clamp(((ev.clientX - r.left) / r.width) * 100, 0, 100), y: clamp(((ev.clientY - r.top) / r.height) * 100, 0, 100) };
      if (isFirst) {
        if (Math.hypot(p.x - sE.x, p.y - sE.y) < 3) return;
        syncLineFromEndpoints(p, sE);
      } else if (isLast) {
        if (Math.hypot(p.x - sS.x, p.y - sS.y) < 3) return;
        syncLineFromEndpoints(sS, p);
      } else {
        const dx = sE.x - sS.x, dy = sE.y - sS.y, l2 = dx * dx + dy * dy || 1;
        const t = clamp(((p.x - sS.x) * dx + (p.y - sS.y) * dy) / l2, 0.04, 0.96);
        const on = lerpPt(sS, sE, t);
        const ox = p.x - on.x, oy = p.y - on.y;
        syncLineFromEndpoints(
          { x: clamp(sS.x + ox, 0, 100), y: clamp(sS.y + oy, 0, 100) },
          { x: clamp(sE.x + ox, 0, 100), y: clamp(sE.y + oy, 0, 100) });
        const first = g.stops[0].pos, last = g.stops[g.stops.length - 1].pos;
        st.pos = clamp(Math.round(first + t * (last - first)), first + 1, last - 1);
      }
      render(); writeValue(currentValue());
    });
  }
  function dragStopBar(e, st) {
    e.stopPropagation(); e.preventDefault();
    const g = S.grad;
    g.activeId = st.id;
    const bar = $('g-bar');
    const move = (ev) => {
      const r = bar.getBoundingClientRect();
      if (!r.width) return;
      st.pos = clamp(Math.round(((ev.clientX - r.left) / r.width) * 100), 0, 100);
      syncEndpointsFromPos();
      update();
    };
    move(e);
    dragWindow(move);
  }
  // Bấm vào chỗ trống trên thanh → thêm stop tại đó rồi kéo luôn
  function onBarDown(e) {
    if (e.target.closest('.cp-handle')) return;
    const g = S.grad;
    if (g.stops.length >= MAX_STOPS) return;
    const r = $('g-bar').getBoundingClientRect();
    const pos = clamp(Math.round(((e.clientX - r.left) / r.width) * 100), 1, 99);
    const st = newStop(pos, interpolateAt(pos));
    g.stops.push(st);
    g.activeId = st.id;
    syncEndpointsFromPos();
    dragStopBar(e, st);
  }

  /* ================= Bindings ================= */
  // Solid
  dragXY($('s-area'), (x, y) => { S.solid.s = x * 100; S.solid.b = (1 - y) * 100; });
  dragXY($('s-hue'), (x) => { S.solid.h = Math.min(359.99, x * 360); });
  dragXY($('s-alpha'), (x) => { S.solid.a = +x.toFixed(2); });
  arrowKeys($('s-area'), () => S.solid, (c) => { S.solid = c; }, (c, d, step) => {
    c.s = clamp(c.s + d[0] * step, 0, 100); c.b = clamp(c.b + d[1] * step, 0, 100);
  });
  $('s-format').addEventListener('change', (e) => { S.format = e.target.value; renderSolid(); });
  $('s-save').addEventListener('click', () => {
    const v = toHex(S.solid);
    if (!saved.solid.some((x) => x.toUpperCase() === v.toUpperCase())) { saved.solid.push(v); persistSaved(); }
    renderSwatches('solid');
  });
  // Gradient: kéo trên vùng 2D → nắm handle gần nhất
  $('g-area').addEventListener('pointerdown', (e) => {
    if (e.target.closest('.cp-handle')) return;
    const r = $('g-area').getBoundingClientRect();
    if (!r.width) return;
    const p = { x: ((e.clientX - r.left) / r.width) * 100, y: ((e.clientY - r.top) / r.height) * 100 };
    let best = 0, dist = Infinity;
    S.grad.stops.forEach((_, i) => {
      const q = stop2D(i), d = Math.hypot(p.x - q.x, p.y - q.y);
      if (d < dist) { dist = d; best = i; }
    });
    const st = S.grad.stops[best];
    const handle = $('g-handles').children[best];
    if (handle) dragStop2D(e, st, handle);
  });
  $('g-bar').addEventListener('pointerdown', onBarDown);
  $('g-type').addEventListener('change', (e) => { S.grad.type = e.target.value; update(); });
  $('g-angle').addEventListener('change', (e) => {
    const n = parseInt(String(e.target.value).replace(/[^0-9-]/g, ''), 10);
    if (Number.isNaN(n)) { render(); return; }
    setAngle(n);
    update();
  });
  $('g-reverse').addEventListener('click', () => {
    const g = S.grad;
    g.stops.forEach((st) => { st.pos = 100 - st.pos; });
    sortStopsInPlace();
    const t = g.pStart; g.pStart = g.pEnd; g.pEnd = t;
    g.pStart = lerpPt(g.line.start, g.line.end, g.stops[0].pos / 100);
    g.pEnd = lerpPt(g.line.start, g.line.end, g.stops[g.stops.length - 1].pos / 100);
    update();
  });
  $('g-add').addEventListener('click', () => {
    const g = S.grad;
    if (g.stops.length >= MAX_STOPS) return;
    const all = sortedStops();
    let bi = 0, bg = -1;
    for (let i = 0; i < all.length - 1; i++) { const gap = all[i + 1].pos - all[i].pos; if (gap > bg) { bg = gap; bi = i; } }
    const pos = clamp(Math.round((all[bi].pos + all[bi + 1].pos) / 2), 1, 99);
    const st = newStop(pos, interpolateAt(pos));
    g.stops.push(st);
    g.activeId = st.id;
    syncEndpointsFromPos();
    update();
  });
  const withActive = (fn) => (x) => { fn(activeStop(), x); };
  dragXY($('g-hue'), withActive((st, x) => {
    st.h = Math.min(359.99, x * 360);
    if (st.s === 0) st.s = 75;
    if (st.b === 0) st.b = 85;
  }));
  dragXY($('g-alpha'), withActive((st, x) => { st.a = +x.toFixed(2); }));
  $('g-save').addEventListener('click', () => {
    const v = gradientCss();
    if (!saved.grad.includes(v)) { saved.grad.push(v); persistSaved(); }
    renderSwatches('grad');
  });

  // EyeDropper (nếu trình duyệt hỗ trợ)
  async function sample(cb) {
    if (!HAS_EYEDROPPER) return;
    try {
      const r = await new window.EyeDropper().open();
      const p = parseColor(r.sRGBHex);
      if (p) cb(p);
    } catch { /* user hủy */ }
  }
  $('s-eye').addEventListener('click', () => sample((p) => { S.solid = { ...p, a: S.solid.a }; update(); }));
  $('g-eye').addEventListener('click', () => sample((p) => {
    const st = activeStop(); st.h = p.h; st.s = p.s; st.b = p.b; update();
  }));

  // Tabs (đổi tab chỉ xem; áp dụng khi chỉnh)
  pop.querySelectorAll('.cp-tab').forEach((b) => b.addEventListener('click', () => { S.mode = b.dataset.mode; render(); place(); }));
  $('cp-done').addEventListener('click', () => close());
  $('cp-clear').addEventListener('click', () => { writeValue(''); close(); });

  /* ================= Open / Close ================= */
  function loadFromValue(val) {
    val = String(val || '').trim();
    S.mode = 'solid'; S.solid = DEFAULT_SOLID(); S.grad = defaultGrad(); S.dirty = false;
    if (!val) return;
    if (/gradient\(/i.test(val)) {
      if (applyGradientValue(val)) {
        S.mode = 'gradient';
        const st = S.grad.stops[0];
        S.solid = { h: st.h, s: st.s, b: st.b, a: st.a };
      }
    } else {
      const p = parseColor(val);
      if (p) S.solid = p;
    }
  }
  function open(target) {
    if (S.target && S.target !== target) close();
    S.target = target;
    loadFromValue(target.input.value);
    const wrap = target.input.closest('.color-field');
    if (wrap && pop.parentElement !== wrap) wrap.appendChild(pop);
    builtFormat = '';
    render();
    pop.hidden = false;
    place();
  }
  // Giữ popup trong khung nhìn: lật lên trên / dịch sang trái nếu bị tràn
  function place() {
    pop.style.top = ''; pop.style.bottom = ''; pop.style.left = ''; pop.style.right = '';
    const r = pop.getBoundingClientRect();
    const wrap = pop.parentElement.getBoundingClientRect();
    if (r.bottom > window.innerHeight - 8 && wrap.top > window.innerHeight - wrap.bottom) {
      pop.style.top = 'auto'; pop.style.bottom = 'calc(100% + 8px)';
    }
    if (r.right > window.innerWidth - 8) { pop.style.left = 'auto'; pop.style.right = '0'; }
  }
  function close() {
    const t = S.target, dirty = S.dirty;
    pop.hidden = true;
    S.target = null; S.dirty = false;
    if (!t) return;
    if (typeof t.onChange === 'function' && dirty) { try { t.onChange(t.input.value); } catch { /* ignore */ } }
  }

  document.addEventListener('mousedown', (e) => {
    if (pop.hidden || !S.target) return;
    const t = S.target;
    if (pop.contains(e.target) || t.input.contains(e.target) || (t.swatch && t.swatch.contains(e.target))) return;
    close();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !pop.hidden) close(); });

  /* ================= Public API ================= */
  window.QrColorPicker = {
    attach(inputId, swatchId, opts = {}) {
      const input = document.getElementById(inputId);
      const swatch = document.getElementById(swatchId);
      if (!input || !swatch) return null;
      const target = { input, swatch, onChange: opts.onChange };
      paintSwatch(swatch, input.value.trim());
      swatch.style.cursor = 'pointer';
      swatch.setAttribute('role', 'button');
      swatch.setAttribute('tabindex', '0');
      swatch.setAttribute('aria-label', 'Mở bảng chọn màu');
      const toggle = (e) => { e.preventDefault(); if (!pop.hidden && S.target === target) close(); else open(target); };
      swatch.addEventListener('click', toggle);
      swatch.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') toggle(e); });
      input.addEventListener('click', () => { if (pop.hidden || S.target !== target) open(target); });
      // Gõ tay → cập nhật swatch (và picker nếu đang mở)
      input.addEventListener('input', () => {
        paintSwatch(swatch, input.value.trim());
      });
      return {
        set(val) { input.value = val; paintSwatch(swatch, val); },
        get() { return input.value; },
      };
    },
  };
})();
