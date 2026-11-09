import test from 'node:test';
import assert from 'node:assert/strict';
import { rebindCF7, findCf7FormId } from '../src/qr/elementor.js';

const jetWidget = () => ({
  id: '0440b55',
  elType: 'widget',
  widgetType: 'contact-form-7',
  settings: { _css_classes: 'btn-s btn', input_padding: { unit: 'px', top: '15' } },
  elements: [],
});

test('rebindCF7 giữ widget JetElements, chọn form theo value "{id}::{title}"', () => {
  const els = [{ id: 'c1', elType: 'container', settings: {}, elements: [jetWidget()] }];
  assert.equal(rebindCF7(els, { id: 10400, title: '33009 Lamia Nails Spa Hallandale' }), 1);
  const w = els[0].elements[0];
  assert.equal(w.widgetType, 'contact-form-7');
  assert.equal(w.settings.form_shortcode, '10400::33009 Lamia Nails Spa Hallandale');
  assert.equal(w.settings._css_classes, 'btn-s btn');
  assert.deepEqual(w.settings.input_padding, { unit: 'px', top: '15' });
  assert.equal(findCf7FormId(w), 10400);
});

test('findCf7FormId đọc được page cũ (contact_form / shortcode widget)', () => {
  const old = jetWidget();
  old.settings.contact_form = '10337';
  assert.equal(findCf7FormId(old), 10337);
  assert.equal(findCf7FormId({ widgetType: 'shortcode', settings: { shortcode: '<style></style>\n[contact-form-7 id="10400" title="A"]' } }), 10400);
  assert.equal(findCf7FormId({ widgetType: 'shortcode', settings: { shortcode: '[gallery]' } }), null);
});
