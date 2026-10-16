/* QR Color Picker — Untitled UI style (Solid + Gradient), dialog dùng chung.
 * Mở khi click vào ô input hoặc swatch. Không dùng Tailwind. */
(function () {
  'use strict';

  /* ================= Color math (HSB) + vector 2D ================= */
  const CM = {
    clamp(v, min, max) { return Math.min(max, Math.max(min, v)); },
    lerp(a, b, t) { return a + (b - a) * t; },
    lerpPoint(p1, p2, t) {
      return { x: this.lerp(p1.x, p2.x, t), y: this.lerp(p1.y, p2.y, t) };
    },
    // Kéo dài đường thẳng qua p1→p2 ra tới biên [0,100]² (port từ bản gốc)
    extendLineToEdges(p1, p2) {
      let dx = p2.x - p1.x, dy = p2.y - p1.y;
      if (Math.hypot(dx, dy) < 0.001) { dx = 1; dy = 1; }
      let tMin = -Infinity, tMax = Infinity;
      if (Math.abs(dx) > 1e-6) {
        const tx0 = (0 - p1.x) / dx, tx1 = (100 - p1.x) / dx;
        tMin = Math.max(tMin, Math.min(tx0, tx1));
        tMax = Math.min(tMax, Math.max(tx0, tx1));
      }
      if (Math.abs(dy) > 1e-6) {
        const ty0 = (0 - p1.y) / dy, ty1 = (100 - p1.y) / dy;
        tMin = Math.max(tMin, Math.min(ty0, ty1));
        tMax = Math.min(tMax, Math.max(ty0, ty1));
      }
      return {
        start: { x: this.clamp(p1.x + tMin * dx, 0, 100), y: this.clamp(p1.y + tMin * dy, 0, 100) },
        end: { x: this.clamp(p1.x + tMax * dx, 0, 100), y: this.clamp(p1.y + tMax * dy, 0, 100) },
      };
    },
    projectPointOntoLine(pt, start, end) {
      const dx = end.x - start.x, dy = end.y - start.y;
      const lenSq = dx * dx + dy * dy;
      if (lenSq < 1e-6) return 0;
      return this.clamp(((pt.x - start.x) * dx + (pt.y - start.y) * dy) / lenSq, 0, 1);
    },
    hsbToRgb(h, s, b) {
      h = ((h % 360) + 360) % 360;
      s = this.clamp(s, 0, 100) / 100;
      b = this.clamp(b, 0, 100) / 100;
      const k = (n) => (n + h / 60) % 6;
      const f = (n) => b * (1 - s * Math.max(0, Math.min(k(n), 4 - k(n), 1)));
      return {
        r: Math.round(255 * f(5)),
        g: Math.round(255 * f(3)),
        b: Math.round(255 * f(1)),
      };
    },
    rgbToHsb(r, g, b) {
      r = this.clamp(r, 0, 255) / 255;
      g = this.clamp(g, 0, 255) / 255;
      b = this.clamp(b, 0, 255) / 255;
      const max = Math.max(r, g, b), min = Math.min(r, g, b);
      const d = max - min;
      let h = 0;
      const sv = max === 0 ? 0 : d / max;
      const vv = max;
      if (d !== 0) {
        if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) * 60;
        else if (max === g) h = ((b - r) / d + 2) * 60;
        else h = ((r - g) / d + 4) * 60;
      }
      return { h: Math.round(h), s: Math.round(sv * 100), b: Math.round(vv * 100) };
    },
    rgbToHex(r, g, b) {
      const hx = (n) => this.clamp(Math.round(n), 0, 255).toString(16).padStart(2, '0').toUpperCase();
      return '#' + hx(r) + hx(g) + hx(b);
    },
    hsbaToHex(h, s, b, a) {
      const { r, g, b: bb } = this.hsbToRgb(h, s, b);
      let hex = this.rgbToHex(r, g, bb);
      if (a < 1) hex += Math.round(a * 255).toString(16).padStart(2, '0').toUpperCase();
      return hex;
    },
    hsbaToCss(h, s, b, a) {
      const { r, g, b: bb } = this.hsbToRgb(h, s, b);
      return a >= 1 ? `rgb(${r},${g},${bb})` : `rgba(${r},${g},${bb},${+a.toFixed(2)})`;
    },
    parseHex8(str) {
      const m = /^#?([0-9a-fA-F]{6})([0-9a-fA-F]{2})?$/.exec(String(str || '').trim());
      if (!m) return null;
      const r = parseInt(m[1].slice(0, 2), 16);
      const g = parseInt(m[1].slice(2, 4), 16);
      const b = parseInt(m[1].slice(4, 6), 16);
      const hsb = this.rgbToHsb(r, g, b);
      hsb.a = m[2] ? parseInt(m[2], 16) / 255 : 1;
      return hsb;
    },
    parseGradient(str) {
      // linear/radial/conic-gradient(...) — stops dạng #RRGGBB(AA) + %
      const m = String(str).match(/(linear|radial|conic)-gradient\((.*)\)\s*$/s);
      if (!m) return null;
      let type = m[1] === 'conic' ? 'angular' : m[1];
      const inner = m[2];
      const parts = [];
      let depth = 0, cur = '';
      for (const ch of inner) {
        if (ch === '(') depth++;
        if (ch === ')') depth--;
        if (ch === ',' && depth === 0) { parts.push(cur.trim()); cur = ''; }
        else cur += ch;
      }
      if (cur.trim()) parts.push(cur.trim());
      let angle = 135, startIdx = 0;
      const degM = parts[0] && parts[0].match(/(\d+)\s*deg/);
      if (degM) { angle = +degM[1]; startIdx = 1; }
      else if (parts[0] && /circle|ellipse|at\s|from\s/i.test(parts[0])) {
        startIdx = 1;
        // conic at X% Y% (không phải 50% 50%) → diamond
        if (type === 'angular') {
          const atM = parts[0].match(/at\s+(\d+)%\s+(\d+)%/i);
          if (atM && (+atM[1] !== 50 || +atM[2] !== 50)) type = 'diamond';
        }
      }
      const stops = [];
      for (let i = startIdx; i < parts.length; i++) {
        const pm = parts[i].match(/(#[0-9a-fA-F]{6,8}|rgba?\([^)]+\))\s*(\d+(?:\.\d+)?)?\s*%?/);
        if (!pm) continue;
        const color = pm[1];
        const pos = pm[2] !== undefined && pm[2] !== '' ? +pm[2] : (i === startIdx ? 0 : 100);
        let hsb = { h: 0, s: 0, b: 0, a: 1 };
        if (color[0] === '#') {
          const p = this.parseHex8(color);
          if (p) hsb = p;
        } else {
          const cm = color.match(/rgba?\((\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([\d.]+))?\)/);
          if (cm) {
            const h = this.rgbToHsb(+cm[1], +cm[2], +cm[3]);
            hsb = { h: h.h, s: h.s, b: h.b, a: cm[4] !== undefined ? +cm[4] : 1 };
          }
        }
        stops.push({ pos, h: hsb.h, s: hsb.s, b: hsb.b, a: hsb.a });
      }
      if (stops.length < 2) return null;
      stops.sort((x, y) => x.pos - y.pos);
      return { type, angle, stops };
    },
  };

  /* ================= State ================= */
  const S = {
    target: null, // { input, swatch, onChange }
    mode: 'solid',
    solid: { h: 0, s: 100, b: 100, a: 1 },
    grad: {
      type: 'linear', angle: 135, active: 0,
      pStart: { x: 12, y: 12 },
      pEnd: { x: 88, y: 88 },
      line: { start: { x: 0, y: 0 }, end: { x: 100, y: 100 } },
      stops: [
        { pos: 0, h: 0, s: 100, b: 100, a: 1 },
        { pos: 100, h: 0, s: 100, b: 60, a: 1 },
      ],
    },
  };

  /* 2D helpers cho gradient (port từ bản gốc) */
  function endpointsToAngle(start, end) {
    const dx = end.x - start.x, dy = end.y - start.y;
    const deg = Math.round((Math.atan2(dy, dx) * 180) / Math.PI + 90);
    return ((deg % 360) + 360) % 360;
  }
  function getStop2DPoint(index) {
    const g = S.grad, all = g.stops;
    if (index === 0) return { ...g.pStart };
    if (index === all.length - 1) return { ...g.pEnd };
    const firstPos = all[0].pos, lastPos = all[all.length - 1].pos;
    const span = Math.max(1, lastPos - firstPos);
    const relT = CM.clamp((all[index].pos - firstPos) / span, 0, 1);
    return CM.lerpPoint(g.pStart, g.pEnd, relT);
  }
  function syncLineFromEndpoints(newPStart, newPEnd) {
    const g = S.grad, all = g.stops;
    const oldSpan = Math.max(1, all[all.length - 1].pos - all[0].pos);
    const innerFractions = all.map((st, idx) => {
      if (idx === 0) return 0;
      if (idx === all.length - 1) return 1;
      return CM.clamp((st.pos - all[0].pos) / oldSpan, 0.02, 0.98);
    });
    g.pStart = { x: CM.clamp(newPStart.x, 0, 100), y: CM.clamp(newPStart.y, 0, 100) };
    g.pEnd = { x: CM.clamp(newPEnd.x, 0, 100), y: CM.clamp(newPEnd.y, 0, 100) };
    const ext = CM.extendLineToEdges(g.pStart, g.pEnd);
    g.line.start = ext.start; g.line.end = ext.end;
    g.angle = endpointsToAngle(g.pStart, g.pEnd);
    const t0 = CM.projectPointOntoLine(g.pStart, g.line.start, g.line.end);
    const t1 = CM.projectPointOntoLine(g.pEnd, g.line.start, g.line.end);
    all[0].pos = Math.round(t0 * 100);
    all[all.length - 1].pos = Math.max(all[0].pos + 1, Math.round(t1 * 100));
    const newSpan = Math.max(1, all[all.length - 1].pos - all[0].pos);
    all.forEach((st, idx) => {
      if (idx > 0 && idx < all.length - 1) {
        st.pos = CM.clamp(
          Math.round(all[0].pos + innerFractions[idx] * newSpan),
          all[0].pos + 1, all[all.length - 1].pos - 1);
      }
    });
  }

  /* ================= DOM (build 1 lần) ================= */
  // Popup nhỏ absolute dưới ô màu — KHÔNG dùng backdrop fullscreen
  const pop = document.createElement('div');
  pop.className = 'qr-cp-pop';
  pop.hidden = true;
  pop.innerHTML = `
    <div class="uui-cp-dialog" role="dialog" aria-label="Chọn màu">
      <div class="uui-tabs-list" role="tablist" aria-label="Kiểu màu">
        <button type="button" class="uui-tab-trigger" data-mode="solid" data-active="true" role="tab" aria-selected="true">Solid</button>
        <button type="button" class="uui-tab-trigger" data-mode="gradient" data-active="false" role="tab" aria-selected="false">Gradient</button>
      </div>

      <!-- SOLID -->
      <div id="qr-cp-pane-solid">
        <div id="qr-cp-solid-area" class="uui-cp-area" tabindex="0" role="slider" aria-label="Độ bão hòa và độ sáng">
          <div class="uui-cp-area-white"></div>
          <div class="uui-cp-area-black"></div>
          <div id="qr-cp-solid-thumb" class="uui-cp-thumb"></div>
        </div>
        <div class="qr-cp-sliders">
          <div id="qr-cp-solid-hue" class="uui-cp-slider uui-cp-hue-track" tabindex="0" role="slider" aria-label="Hue">
            <div id="qr-cp-solid-hue-thumb" class="uui-cp-slider-thumb"></div>
          </div>
          <div id="qr-cp-solid-alpha" class="uui-cp-slider uui-checkerboard" tabindex="0" role="slider" aria-label="Độ trong suốt">
            <div id="qr-cp-solid-alpha-grad" class="qr-cp-abs-fill"></div>
            <div id="qr-cp-solid-alpha-thumb" class="uui-cp-slider-thumb"></div>
          </div>
        </div>
        <div class="uui-input-group">
          <div class="uui-input-cell" data-position="first"><input id="qr-cp-solid-hex" class="qr-cp-mono" spellcheck="false" aria-label="Mã hex" placeholder="#E31E24"></div>
          <div class="uui-input-cell" data-position="last"><input id="qr-cp-solid-alpha-inp" aria-label="Độ đục %" placeholder="100%"></div>
        </div>
        <div class="qr-cp-preview">
          <span id="qr-cp-solid-preview" class="qr-cp-preview-dot uui-checkerboard"></span>
          <code id="qr-cp-solid-code" class="qr-cp-mono"></code>
        </div>
      </div>

      <!-- GRADIENT (giống bản gốc: 2D vector + type + slider + stops) -->
      <div id="qr-cp-pane-gradient" hidden>
        <div id="qr-cp-grad-2d" class="uui-cp-area uui-checkerboard qr-cp-grad-2d" role="group" aria-label="Hướng gradient và các điểm màu">
          <div id="qr-cp-grad-2d-fill" class="qr-cp-grad-2d-fill"></div>
          <svg id="qr-cp-grad-2d-svg" class="qr-cp-grad-2d-svg" aria-hidden="true">
            <line id="qr-cp-grad-vector" x1="12%" y1="12%" x2="88%" y2="88%"
              stroke="rgba(255,255,255,0.65)" stroke-width="2"
              stroke-dasharray="3 5" stroke-linecap="round" />
          </svg>
          <div id="qr-cp-grad-2d-handles" class="qr-cp-grad-2d-handles"></div>
        </div>
        <div class="qr-cp-row">
          <select id="qr-cp-grad-type" class="uui-select" aria-label="Kiểu gradient">
            <option value="linear">Linear</option>
            <option value="radial">Radial</option>
            <option value="angular">Angular</option>
            <option value="diamond">Diamond</option>
          </select>
          <div class="uui-input-cell" data-position="only" id="qr-cp-grad-angle-wrap" title="Góc (độ)">
            <input id="qr-cp-grad-angle" inputmode="numeric" aria-label="Góc gradient">
          </div>
          <button type="button" id="qr-cp-grad-reverse" class="qr-cp-mini-btn" title="Đảo ngược gradient" aria-label="Đảo ngược gradient">⇄</button>
          <button type="button" id="qr-cp-grad-add" class="qr-cp-mini-btn">+ Thêm</button>
        </div>
        <div id="qr-cp-grad-bar" class="uui-cp-slider uui-checkerboard" role="slider" aria-label="Vị trí các điểm màu">
          <div id="qr-cp-grad-bar-fill" class="qr-cp-abs-fill"></div>
          <div id="qr-cp-grad-handles"></div>
        </div>
        <div id="qr-cp-grad-stops"></div>
        <div class="qr-cp-stop-editor">
          <div class="qr-cp-stop-editor-head"><span id="qr-cp-grad-active-label">Điểm 1</span></div>
          <div id="qr-cp-grad-area" class="uui-cp-area uui-cp-area-sm" tabindex="0" role="slider" aria-label="Màu điểm đang chọn">
            <div class="uui-cp-area-white"></div>
            <div class="uui-cp-area-black"></div>
            <div id="qr-cp-grad-thumb" class="uui-cp-thumb"></div>
          </div>
          <div class="qr-cp-sliders">
            <div id="qr-cp-grad-hue" class="uui-cp-slider uui-cp-hue-track" tabindex="0" role="slider" aria-label="Hue điểm đang chọn">
              <div id="qr-cp-grad-hue-thumb" class="uui-cp-slider-thumb"></div>
            </div>
            <div id="qr-cp-grad-alpha" class="uui-cp-slider uui-checkerboard" tabindex="0" role="slider" aria-label="Độ trong suốt điểm đang chọn">
              <div id="qr-cp-grad-alpha-grad" class="qr-cp-abs-fill"></div>
              <div id="qr-cp-grad-alpha-thumb" class="uui-cp-slider-thumb"></div>
            </div>
          </div>
        </div>
      </div>

      <div class="qr-cp-actions">
        <button type="button" id="qr-cp-clear" class="qr-cp-btn qr-cp-btn-ghost">Xóa</button>
        <span class="qr-cp-spacer"></span>
        <button type="button" id="qr-cp-cancel" class="qr-cp-btn qr-cp-btn-ghost">Hủy</button>
        <button type="button" id="qr-cp-apply" class="qr-cp-btn qr-cp-btn-primary">Chọn</button>
      </div>
    </div>`;
  const $ = (id) => document.getElementById(id);
  const dlg = pop.querySelector('.uui-cp-dialog');

  /* ================= Helpers ================= */
  function gradientCss() {
    const g = S.grad;
    const sorted = [...g.stops].sort((a, b) => a.pos - b.pos);
    // Backend gradientStops() chỉ match #RRGGBB — dùng hex, không dùng rgb()
    const parts = sorted.map((st) => `${CM.hsbaToHex(st.h, st.s, st.b, st.a)} ${Math.round(st.pos)}%`);
    const cx = Math.round(g.pStart.x), cy = Math.round(g.pStart.y);
    if (g.type === 'radial') return `radial-gradient(circle at 50% 50%, ${parts.join(', ')})`;
    if (g.type === 'angular') return `conic-gradient(from ${g.angle}deg at 50% 50%, ${parts.join(', ')})`;
    if (g.type === 'diamond') return `conic-gradient(from ${g.angle}deg at ${cx}% ${cy}%, ${parts.join(', ')})`;
    return `linear-gradient(${g.angle}deg, ${parts.join(', ')})`;
  }
  function currentValue() {
    const sl = S.solid;
    return S.mode === 'solid' ? CM.hsbaToHex(sl.h, sl.s, sl.b, sl.a) : gradientCss();
  }
  function paintSwatch(swatchEl, val) {
    if (!swatchEl) return;
    swatchEl.classList.toggle('qr-cp-empty', !val);
    swatchEl.style.background = val || '';
  }

  /* ================= Render ================= */
  function renderTabs() {
    pop.querySelectorAll('.uui-tab-trigger').forEach((b) => {
      const on = b.dataset.mode === S.mode;
      b.dataset.active = on ? 'true' : 'false';
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    $('qr-cp-pane-solid').hidden = S.mode !== 'solid';
    $('qr-cp-pane-gradient').hidden = S.mode !== 'gradient';
  }

  function renderSolid() {
    const sl = S.solid;
    const hex = CM.hsbaToHex(sl.h, sl.s, sl.b, sl.a);
    const rgb = CM.hsbToRgb(sl.h, sl.s, sl.b);
    const area = $('qr-cp-solid-area'), thumb = $('qr-cp-solid-thumb');
    area.style.backgroundColor = `hsl(${sl.h},100%,50%)`;
    thumb.style.left = sl.s + '%';
    thumb.style.top = (100 - sl.b) + '%';
    thumb.style.backgroundColor = CM.rgbToHex(rgb.r, rgb.g, rgb.b);
    const hueThumb = $('qr-cp-solid-hue-thumb');
    hueThumb.style.left = (sl.h / 360 * 100) + '%';
    hueThumb.style.backgroundColor = `hsl(${sl.h},100%,50%)`;
    $('qr-cp-solid-alpha-grad').style.background =
      `linear-gradient(to right, rgba(${rgb.r},${rgb.g},${rgb.b},0), rgba(${rgb.r},${rgb.g},${rgb.b},1))`;
    const aThumb = $('qr-cp-solid-alpha-thumb');
    aThumb.style.left = (sl.a * 100) + '%';
    aThumb.style.backgroundColor = CM.hsbaToCss(sl.h, sl.s, sl.b, sl.a);
    const hexInp = $('qr-cp-solid-hex'), aInp = $('qr-cp-solid-alpha-inp');
    if (document.activeElement !== hexInp) hexInp.value = hex;
    if (document.activeElement !== aInp) aInp.value = Math.round(sl.a * 100) + '%';
    $('qr-cp-solid-preview').style.background = CM.hsbaToCss(sl.h, sl.s, sl.b, sl.a);
    $('qr-cp-solid-code').textContent = hex;
  }

  function renderGradient() {
    const g = S.grad;
    const css = gradientCss();
    $('qr-cp-grad-type').value = g.type;
    const angleInp = $('qr-cp-grad-angle');
    if (document.activeElement !== angleInp) angleInp.value = g.angle + '°';
    // Bar ngang luôn hiện linear 90deg để dễ kéo stops
    const sorted = [...g.stops].sort((a, b) => a.pos - b.pos);
    $('qr-cp-grad-bar-fill').style.background =
      `linear-gradient(90deg, ${sorted.map((st) => `${CM.hsbaToHex(st.h, st.s, st.b, st.a)} ${Math.round(st.pos)}%`).join(', ')})`;
    renderGrad2D(css);
    renderGradHandles();
    renderGradStops();
    renderGradEditor();
  }

  // 2D vector area: fill gradient + đường dashed nối pStart→pEnd + handles kéo 2D
  function renderGrad2D(css) {
    const g = S.grad;
    $('qr-cp-grad-2d-fill').style.background = css;
    const line = $('qr-cp-grad-vector');
    line.setAttribute('x1', g.pStart.x + '%');
    line.setAttribute('y1', g.pStart.y + '%');
    line.setAttribute('x2', g.pEnd.x + '%');
    line.setAttribute('y2', g.pEnd.y + '%');
    const wrap = $('qr-cp-grad-2d-handles');
    wrap.innerHTML = '';
    g.stops.forEach((st, idx) => {
      const pt = getStop2DPoint(idx);
      const h = document.createElement('button');
      h.type = 'button';
      h.className = 'uui-grad-handle';
      h.style.left = pt.x + '%';
      h.style.top = pt.y + '%';
      h.style.background = CM.hsbaToCss(st.h, st.s, st.b, st.a);
      h.dataset.active = idx === g.active ? 'true' : 'false';
      h.setAttribute('aria-label', `Điểm màu ${idx + 1} (${Math.round(st.pos)}%)`);
      h.addEventListener('pointerdown', (e) => start2DStopDrag(e, idx, h));
      wrap.appendChild(h);
    });
  }

  // Kéo handle trên mặt phẳng 2D (port từ bản gốc)
  function start2DStopDrag(e, idx, handleEl) {
    e.stopPropagation();
    e.preventDefault();
    const g = S.grad;
    g.active = idx;
    handleEl.dataset.dragging = 'true';
    const areaEl = $('qr-cp-grad-2d');
    const isFirst = idx === 0, isLast = idx === g.stops.length - 1;
    const endSnapshot = { ...g.pEnd };
    const startSnapshot = { ...g.pStart };
    renderGradient();
    const move = (ev) => {
      const rect = areaEl.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const px = CM.clamp(((ev.clientX - rect.left) / rect.width) * 100, 0, 100);
      const py = CM.clamp(((ev.clientY - rect.top) / rect.height) * 100, 0, 100);
      if (isFirst) {
        if (Math.hypot(px - endSnapshot.x, py - endSnapshot.y) < 3) return;
        syncLineFromEndpoints({ x: px, y: py }, endSnapshot);
      } else if (isLast) {
        if (Math.hypot(px - startSnapshot.x, py - startSnapshot.y) < 3) return;
        syncLineFromEndpoints(startSnapshot, { x: px, y: py });
      } else {
        // Điểm giữa: trượt % dọc vector + tịnh tiến vector theo chuột
        const t = CM.projectPointOntoLine({ x: px, y: py }, g.line.start, g.line.end);
        const sorted = [...g.stops].sort((a, b) => a.pos - b.pos);
        const firstPos = sorted[0].pos, lastPos = sorted[sorted.length - 1].pos;
        g.stops[idx].pos = CM.clamp(Math.round(firstPos + t * (lastPos - firstPos)), firstPos + 1, lastPos - 1);
      }
      renderGradient();
    };
    const up = () => {
      handleEl.dataset.dragging = 'false';
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  }

  function renderGradHandles() {
    const g = S.grad;
    const wrap = $('qr-cp-grad-handles');
    wrap.innerHTML = '';
    const sorted = [...g.stops].sort((a, b) => a.pos - b.pos);
    sorted.forEach((st) => {
      const idx = g.stops.indexOf(st);
      const h = document.createElement('button');
      h.type = 'button';
      h.className = 'uui-grad-handle';
      h.style.left = st.pos + '%';
      h.style.top = '50%';
      h.style.background = CM.hsbaToCss(st.h, st.s, st.b, st.a);
      h.dataset.active = idx === g.active ? 'true' : 'false';
      h.setAttribute('aria-label', `Điểm màu ${Math.round(st.pos)}%`);
      h.addEventListener('pointerdown', (e) => {
        e.stopPropagation();
        e.preventDefault();
        g.active = idx;
        renderGradient();
        const bar = $('qr-cp-grad-bar');
        const move = (ev) => {
          const rect = bar.getBoundingClientRect();
          st.pos = CM.clamp(((ev.clientX - rect.left) / rect.width) * 100, 0, 100);
          renderGradient();
        };
        const up = () => {
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', up);
          window.removeEventListener('pointercancel', up);
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
        window.addEventListener('pointercancel', up);
      });
      wrap.appendChild(h);
    });
  }

  function renderGradStops() {
    const g = S.grad;
    const box = $('qr-cp-grad-stops');
    box.innerHTML = '';
    const sorted = [...g.stops].sort((a, b) => a.pos - b.pos);
    sorted.forEach((st) => {
      const idx = g.stops.indexOf(st);
      const row = document.createElement('div');
      row.className = 'qr-cp-stop-row' + (idx === g.active ? ' on' : '');
      row.innerHTML =
        `<span class="qr-cp-stop-dot" style="background:${CM.hsbaToCss(st.h, st.s, st.b, st.a)}"></span>` +
        `<span class="qr-cp-mono">${Math.round(st.pos)}%</span>` +
        (g.stops.length > 2 ? `<button type="button" class="qr-cp-stop-del" aria-label="Xóa điểm">×</button>` : `<span></span>`);
      row.querySelector('.qr-cp-stop-dot').addEventListener('click', () => { g.active = idx; renderGradient(); });
      const del = row.querySelector('.qr-cp-stop-del');
      if (del) del.addEventListener('click', (e) => {
        e.stopPropagation();
        g.stops.splice(idx, 1);
        g.active = Math.min(g.active, g.stops.length - 1);
        renderGradient();
      });
      box.appendChild(row);
    });
  }

  function renderGradEditor() {
    const g = S.grad;
    const st = g.stops[g.active] || g.stops[0];
    if (!st) return;
    $('qr-cp-grad-active-label').textContent = `Điểm ${g.active + 1} (${Math.round(st.pos)}%)`;
    const rgb = CM.hsbToRgb(st.h, st.s, st.b);
    const area = $('qr-cp-grad-area'), thumb = $('qr-cp-grad-thumb');
    area.style.backgroundColor = `hsl(${st.h},100%,50%)`;
    thumb.style.left = st.s + '%';
    thumb.style.top = (100 - st.b) + '%';
    thumb.style.backgroundColor = CM.rgbToHex(rgb.r, rgb.g, rgb.b);
    const hueThumb = $('qr-cp-grad-hue-thumb');
    hueThumb.style.left = (st.h / 360 * 100) + '%';
    hueThumb.style.backgroundColor = `hsl(${st.h},100%,50%)`;
    $('qr-cp-grad-alpha-grad').style.background =
      `linear-gradient(to right, rgba(${rgb.r},${rgb.g},${rgb.b},0), rgba(${rgb.r},${rgb.g},${rgb.b},1))`;
    const aThumb = $('qr-cp-grad-alpha-thumb');
    aThumb.style.left = (st.a * 100) + '%';
    aThumb.style.backgroundColor = CM.hsbaToCss(st.h, st.s, st.b, st.a);
  }

  function render() {
    renderTabs();
    if (S.mode === 'solid') renderSolid();
    else renderGradient();
  }

  /* ================= Drag helper ================= */
  function dragXY(el, fn) {
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 && e.pointerType === 'mouse') return;
      e.preventDefault();
      el.focus?.();
      const move = (ev) => {
        const rect = el.getBoundingClientRect();
        const x = CM.clamp((ev.clientX - rect.left) / rect.width, 0, 1);
        const y = CM.clamp((ev.clientY - rect.top) / rect.height, 0, 1);
        fn(x, y);
        render();
      };
      move(e);
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        window.removeEventListener('pointercancel', up);
      };
      window.addEventListener('pointermove', move, { passive: true });
      window.addEventListener('pointerup', up);
      window.addEventListener('pointercancel', up);
    });
  }

  /* Solid bindings */
  dragXY($('qr-cp-solid-area'), (x, y) => {
    S.solid.s = Math.round(x * 100);
    S.solid.b = Math.round((1 - y) * 100);
  });
  dragXY($('qr-cp-solid-hue'), (x) => { S.solid.h = Math.round(x * 360); });
  dragXY($('qr-cp-solid-alpha'), (x) => { S.solid.a = +x.toFixed(2); });

  /* Gradient editor bindings */
  dragXY($('qr-cp-grad-area'), (x, y) => {
    const st = S.grad.stops[S.grad.active];
    if (st) { st.s = Math.round(x * 100); st.b = Math.round((1 - y) * 100); }
  });
  dragXY($('qr-cp-grad-hue'), (x) => {
    const st = S.grad.stops[S.grad.active];
    if (st) st.h = Math.round(x * 360);
  });
  dragXY($('qr-cp-grad-alpha'), (x) => {
    const st = S.grad.stops[S.grad.active];
    if (st) st.a = +x.toFixed(2);
  });

  /* Keyboard cho 2D areas */
  function bindAreaKeys(el, get, set) {
    el.addEventListener('keydown', (e) => {
      const step = e.shiftKey ? 10 : 2;
      const c = get();
      let used = true;
      if (e.key === 'ArrowRight') c.s = CM.clamp(c.s + step, 0, 100);
      else if (e.key === 'ArrowLeft') c.s = CM.clamp(c.s - step, 0, 100);
      else if (e.key === 'ArrowUp') c.b = CM.clamp(c.b + step, 0, 100);
      else if (e.key === 'ArrowDown') c.b = CM.clamp(c.b - step, 0, 100);
      else used = false;
      if (used) { e.preventDefault(); set(c); render(); }
    });
  }
  bindAreaKeys($('qr-cp-solid-area'), () => ({ ...S.solid }), (c) => Object.assign(S.solid, c));
  bindAreaKeys($('qr-cp-grad-area'),
    () => ({ ...(S.grad.stops[S.grad.active] || {}) }),
    (c) => Object.assign(S.grad.stops[S.grad.active] || {}, c));

  /* Hex input (solid) */
  $('qr-cp-solid-hex').addEventListener('change', (e) => {
    const p = CM.parseHex8(e.target.value);
    if (p) Object.assign(S.solid, { h: p.h, s: p.s, b: p.b, a: p.a });
    render();
  });
  $('qr-cp-solid-alpha-inp').addEventListener('change', (e) => {
    const v = parseInt(String(e.target.value).replace(/[^0-9]/g, ''), 10);
    if (!isNaN(v)) S.solid.a = CM.clamp(v, 0, 100) / 100;
    render();
  });

  /* Tabs */
  pop.querySelectorAll('.uui-tab-trigger').forEach((b) => {
    b.addEventListener('click', () => { S.mode = b.dataset.mode; render(); });
  });

  /* Gradient controls */
  $('qr-cp-grad-type').addEventListener('change', (e) => {
    S.grad.type = e.target.value;
    render();
  });
  $('qr-cp-grad-angle').addEventListener('change', (e) => {
    const v = parseInt(String(e.target.value).replace(/[^0-9]/g, ''), 10);
    if (isNaN(v)) { render(); return; }
    const g = S.grad;
    g.angle = CM.clamp(v, 0, 360);
    // Xoay vector 2D theo góc (cho linear)
    if (g.type === 'linear') {
      const rad = ((g.angle - 90) * Math.PI) / 180;
      const cx = 50, cy = 50, r = 38;
      g.pStart = { x: CM.clamp(cx - Math.cos(rad) * r, 0, 100), y: CM.clamp(cy - Math.sin(rad) * r, 0, 100) };
      g.pEnd = { x: CM.clamp(cx + Math.cos(rad) * r, 0, 100), y: CM.clamp(cy + Math.sin(rad) * r, 0, 100) };
      const ext = CM.extendLineToEdges(g.pStart, g.pEnd);
      g.line.start = ext.start; g.line.end = ext.end;
    }
    render();
  });
  $('qr-cp-grad-add').addEventListener('click', () => {
    const g = S.grad;
    if (g.stops.length >= 5) return;
    const src = g.stops[g.active] || g.stops[0];
    g.stops.push({ pos: 50, h: src.h, s: src.s, b: src.b, a: src.a });
    g.active = g.stops.length - 1;
    render();
  });
  // Đảo ngược gradient: đảo thứ tự stops + hoán đổi pStart/pEnd
  $('qr-cp-grad-reverse').addEventListener('click', () => {
    const g = S.grad;
    g.stops.reverse();
    g.stops.forEach((st) => { st.pos = 100 - st.pos; });
    g.stops.sort((a, b) => a.pos - b.pos);
    const tmp = g.pStart; g.pStart = g.pEnd; g.pEnd = tmp;
    const ext = CM.extendLineToEdges(g.pStart, g.pEnd);
    g.line.start = ext.start; g.line.end = ext.end;
    g.angle = endpointsToAngle(g.pStart, g.pEnd);
    g.active = 0;
    render();
  });

  /* ================= Open / Close / Commit ================= */
  function loadFromValue(val) {
    val = String(val || '').trim();
    // reset về mặc định mỗi lần mở
    S.mode = 'solid';
    S.solid = { h: 0, s: 100, b: 100, a: 1 };
    S.grad = {
      type: 'linear', angle: 135, active: 0,
      pStart: { x: 12, y: 12 },
      pEnd: { x: 88, y: 88 },
      line: { start: { x: 0, y: 0 }, end: { x: 100, y: 100 } },
      stops: [
        { pos: 0, h: 0, s: 100, b: 100, a: 1 },
        { pos: 100, h: 0, s: 100, b: 60, a: 1 },
      ],
    };
    if (!val) return;
    if (/^(linear|radial|conic)-gradient/i.test(val)) {
      const g = CM.parseGradient(val);
      if (g) {
        S.mode = 'gradient';
        S.grad.type = g.type;
        S.grad.angle = g.angle;
        S.grad.stops = g.stops;
        S.grad.active = 0;
        // Dựng lại pStart/pEnd từ angle cho linear
        if (g.type === 'linear') {
          const rad = ((g.angle - 90) * Math.PI) / 180;
          const cx = 50, cy = 50, r = 38;
          S.grad.pStart = { x: CM.clamp(cx - Math.cos(rad) * r, 0, 100), y: CM.clamp(cy - Math.sin(rad) * r, 0, 100) };
          S.grad.pEnd = { x: CM.clamp(cx + Math.cos(rad) * r, 0, 100), y: CM.clamp(cy + Math.sin(rad) * r, 0, 100) };
          const ext = CM.extendLineToEdges(S.grad.pStart, S.grad.pEnd);
          S.grad.line.start = ext.start; S.grad.line.end = ext.end;
        }
        const st = g.stops[0];
        S.solid = { h: st.h, s: st.s, b: st.b, a: st.a };
      }
    } else {
      const p = CM.parseHex8(val);
      if (p) S.solid = { h: p.h, s: p.s, b: p.b, a: p.a };
    }
  }

  function open(target) {
    S.target = target;
    loadFromValue(target.input.value);
    render();
    // Popup absolute trong .color-field bọc quanh input+swatch (không fullscreen)
    const wrap = target.input.closest('.color-field');
    if (wrap && pop.parentElement !== wrap) wrap.appendChild(pop);
    pop.hidden = false;
  }
  function close() {
    pop.hidden = true;
    S.target = null;
  }
  async function commit(val) {
    const t = S.target;
    if (!t) { close(); return; }
    const isPrimary = t.input.id === 'qrPrimary';
    t.input.value = val;
    paintSwatch(t.swatch, val);
    t.input.dispatchEvent(new Event('input', { bubbles: true }));
    if (typeof t.onChange === 'function') { try { t.onChange(val); } catch {} }
    close();
    // Auto-suggest màu phụ khi vừa chọn màu chính mà ô phụ đang trống
    if (isPrimary && val) {
      const secInput = document.getElementById('qrSecondary');
      if (secInput && !secInput.value.trim()) {
        try {
          const r = await fetch(`/api/qr/palette?primary=${encodeURIComponent(val)}`, { credentials: 'same-origin' });
          const d = await r.json();
          const sug = d && d.ok && d.vars && d.vars['--qr-secondary'];
          if (sug) {
            secInput.value = sug;
            paintSwatch(document.getElementById('qrSecondarySwatch'), sug);
            secInput.dispatchEvent(new Event('input', { bubbles: true }));
          }
        } catch { /* bỏ qua */ }
      }
    }
  }

  $('qr-cp-apply').addEventListener('click', () => commit(currentValue()));
  $('qr-cp-clear').addEventListener('click', () => commit(''));
  $('qr-cp-cancel').addEventListener('click', close);
  // Click outside popup → đóng (không chặn thao tác khác trên page)
  document.addEventListener('mousedown', (e) => {
    if (pop.hidden || !S.target) return;
    const t = S.target;
    if (pop.contains(e.target)) return;
    if (t.input.contains(e.target) || (t.swatch && t.swatch.contains(e.target))) return;
    close();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !pop.hidden) close();
  });

  /* ================= Public API ================= */
  window.QrColorPicker = {
    attach(inputId, swatchId, opts = {}) {
      const input = document.getElementById(inputId);
      const swatch = document.getElementById(swatchId);
      if (!input || !swatch) return null;
      const target = { input, swatch, onChange: opts.onChange };
      // Vẽ swatch theo giá trị hiện tại (trống → checkerboard)
      paintSwatch(swatch, input.value.trim());
      swatch.style.cursor = 'pointer';
      swatch.setAttribute('role', 'button');
      swatch.setAttribute('tabindex', '0');
      swatch.setAttribute('aria-label', 'Mở bảng chọn màu');
      const doOpen = (e) => { e.preventDefault(); open(target); };
      swatch.addEventListener('click', doOpen);
      swatch.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') doOpen(e);
      });
      // Click vào input cũng mở picker (thay vì gõ tay); vẫn cho phép gõ tay bằng cách focus rồi gõ?
      // → Mở picker khi click, user vẫn gõ được khi picker đóng vì input không readonly.
      input.addEventListener('click', () => open(target));
      // Gõ tay → cập nhật swatch
      input.addEventListener('input', () => paintSwatch(swatch, input.value.trim()));
      return {
        set(val) { input.value = val; paintSwatch(swatch, val); },
        get() { return input.value; },
      };
    },
  };
})();
