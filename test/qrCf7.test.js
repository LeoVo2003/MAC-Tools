import test from 'node:test';
import assert from 'node:assert/strict';
import { rebindCF7, findCf7FormId } from '../src/qr/elementor.js';

const jetWidget = () => ({
  id: '0440b55',
  elType: 'widget',
  widgetType: 'contact-form-7',
  settings: {
    input_padding: { unit: 'px', top: '15', right: '15', bottom: '15', left: '15' },
    input_border_radius: { unit: 'px', top: '25', right: '25', bottom: '25', left: '25' },
    textarea_min_height: 140,
    input_typography_font_size: { unit: 'px', size: 16 },
    input_typography_font_size_mobile: { unit: 'px', size: 14 },
    __globals__: { text_color: 'globals/colors?id=text', submit_bg_color: 'globals/colors?id=secondary' },
    _css_classes: 'btn-s btn',
    jedv_conditions: [{ _id: 'x' }],
  },
  elements: [],
});

test('rebindCF7 đổi widget JetElements sang shortcode trỏ đúng form, giữ class + style', () => {
  const els = [{ id: 'c1', elType: 'container', settings: {}, elements: [jetWidget()] }];
  assert.equal(rebindCF7(els, { id: 10400, title: '33009 "Lamia" [Nails]' }), 1);
  const w = els[0].elements[0];
  assert.equal(w.id, '0440b55');
  assert.equal(w.widgetType, 'shortcode');
  assert.equal(w.settings._css_classes, 'btn-s btn');
  assert.equal(w.settings.jedv_conditions, undefined);
  assert.match(w.settings.shortcode, /\[contact-form-7 id="10400" title="33009 Lamia Nails"\]$/);
  assert.match(w.settings.shortcode, /elementor-element-0440b55 \.wpcf7/);
  assert.match(w.settings.shortcode, /padding:15px 15px 15px 15px;/);
  assert.match(w.settings.shortcode, /min-height:140px;/);
  assert.match(w.settings.shortcode, /color:var\( --e-global-color-text \)/);
  assert.match(w.settings.shortcode, /@media\(max-width:767px\)\{[^}]*\{font-size:14px;\}\}/);
  assert.equal(findCf7FormId(w), 10400);
});

test('rebindCF7 trên shortcode widget đã rebind chỉ thay id form', () => {
  const els = [jetWidget()];
  rebindCF7(els, { id: 1, title: 'A' });
  const before = els[0].settings.shortcode;
  rebindCF7(els, { id: 2, title: 'B $&' });
  assert.equal(els[0].settings.shortcode, before.replace('id="1" title="A"', () => 'id="2" title="B $&"'));
  assert.equal(findCf7FormId(els[0]), 2);
});

test('findCf7FormId đọc được widget JetElements cũ có contact_form', () => {
  const w = jetWidget();
  w.settings.contact_form = '10337';
  assert.equal(findCf7FormId(w), 10337);
  assert.equal(findCf7FormId({ widgetType: 'shortcode', settings: { shortcode: '[gallery]' } }), null);
});
