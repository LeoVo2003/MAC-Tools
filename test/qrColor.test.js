import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPalette, contrast, parseHex, isGradient, sanitizeColorInput, logoFilterCss } from '../src/qr/qrColor.js';

const SAMPLES = ['#E31E24', '#1D1BE0', '#FFD400', '#F5A623', '#00A86B', '#7A8B99',
  '#0B1F3A', '#FF6F61', '#111111', '#989898', '#26A69A', '#E31E24CC',
  'linear-gradient(90deg,#FF512F,#F09819)', 'linear-gradient(135deg,#0F2027,#2C5364)'];

test('chữ trên nút primary/secondary/soft luôn đạt WCAG AA (>= 4.5)', () => {
  for (const p of SAMPLES) {
    const { report } = buildPalette(p);
    assert.ok(report.onPrimary >= 4.5, `${p}: onPrimary ${report.onPrimary}`);
    assert.ok(report.onSecondary >= 4.5, `${p}: onSecondary ${report.onSecondary}`);
    assert.ok(report.onSoft >= 4.5, `${p}: onSoft ${report.onSoft}`);
    assert.ok(report.textOnBg >= 7, `${p}: textOnBg ${report.textOnBg}`);
  }
});

test('secondary tự sinh luôn phân biệt được với primary (hex)', () => {
  for (const p of SAMPLES.filter((s) => !isGradient(s))) {
    const { report } = buildPalette(p);
    assert.ok(report.primaryVsSecondary >= 1.8, `${p}: P/S ${report.primaryVsSecondary}`);
  }
});

test('luôn trả đủ 11 biến, kể cả gradient / alpha', () => {
  for (const p of SAMPLES) {
    const { vars } = buildPalette(p);
    for (const k of ['--qr-primary', '--qr-primary-bg', '--qr-secondary', '--qr-primary-soft', '--qr-bg', '--qr-text',
      '--qr-text-on-primary', '--qr-text-on-secondary', '--qr-text-on-soft', '--qr-accent-ink']) {
      assert.ok(vars[k], `${p} thiếu ${k}`);
    }
    assert.ok(parseHex(vars['--qr-secondary'].slice(0, 7)) || isGradient(vars['--qr-secondary']));
  }
});

test('--qr-primary-bg giữ gradient, --qr-primary luôn đặc', () => {
  const g = buildPalette('linear-gradient(90deg,#FF512F,#F09819)');
  assert.ok(isGradient(g.vars['--qr-primary-bg']), 'primary-bg phải giữ gradient');
  assert.ok(parseHex(g.vars['--qr-primary']), 'primary phải là màu đặc');
  const s = buildPalette('#E31E24');
  assert.equal(s.vars['--qr-primary-bg'], s.vars['--qr-primary'], 'màu đặc: bg = primary');
});

test('contrast đen/trắng = 21', () => assert.equal(Math.round(contrast('#000000', '#FFFFFF')), 21));
test('màu rác → throw', () => assert.throws(() => buildPalette('red')));

test('sanitize: chuẩn hoá hex, chặn gradient chèn CSS', () => {
  assert.equal(sanitizeColorInput('e31e24'), '#E31E24');
  assert.equal(sanitizeColorInput('#e31'), '#EE3311');
  assert.throws(() => sanitizeColorInput('linear-gradient(red);}body{display:none}'));
  assert.throws(() => sanitizeColorInput('linear-gradient(#fff)'));
  assert.ok(sanitizeColorInput('linear-gradient(90deg,#FF512F,#F09819)'));
});
test('logo filter auto theo chữ trên primary', () => {
  assert.equal(logoFilterCss('auto', '#FFFFFF'), 'brightness(0) invert(1)');
  assert.equal(logoFilterCss('auto', '#141414'), 'brightness(0)');
  assert.equal(logoFilterCss('none', '#FFFFFF'), 'none');
});
