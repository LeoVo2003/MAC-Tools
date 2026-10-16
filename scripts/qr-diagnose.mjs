/**
 * QR diagnose: quét _elementor_data của 1 page/template tìm settings hỏng.
 * Usage: node scripts/qr-diagnose.mjs <pageId>
 * (dùng .env: QR_WP_BASE, QR_WP_USER, QR_WP_APP_PASSWORD)
 *
 * - /diagnose  : heuristic (settings/list-item không phải array) + meta_rows + raw_len
 * - /diagnose2 : dùng CHÍNH repeater controls của Elementor để tìm row hỏng
 *                (replicate điều kiện gây TypeError sanitize_settings)
 */
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env') });

const pageId = process.argv[2];
if (!pageId) {
  console.error('Usage: node scripts/qr-diagnose.mjs <pageId>');
  process.exit(1);
}

const base = (process.env.QR_WP_BASE || 'https://qr.macmarketing.us').replace(/\/$/, '');
const user = process.env.QR_WP_USER || '';
const pass = process.env.QR_WP_APP_PASSWORD || '';
if (!user || !pass) {
  console.error('Thiếu QR_WP_USER / QR_WP_APP_PASSWORD trong .env');
  process.exit(1);
}

const auth = 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');

async function call(endpoint) {
  const res = await fetch(`${base}/wp-json/qr/v1/${endpoint}/${pageId}`, {
    headers: { Authorization: auth },
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { _raw: text.slice(0, 300) }; }
  if (!res.ok) {
    console.error(`${endpoint}: HTTP ${res.status}`, data.message || data._raw || '');
    process.exit(1);
  }
  return data;
}

const d1 = await call('diagnose');
console.log(`[diagnose] Page #${d1.id}: raw_len=${d1.raw_len}, json_ok=${d1.json_ok}, top_level=${d1.top_level}`);
console.log(`[diagnose] meta_rows: ${JSON.stringify(d1.meta_rows)}`);
console.log(`[diagnose] bad_count=${d1.bad_count}`);
for (const b of d1.bad || []) console.log('  ✗', b);

const d2 = await call('diagnose2');
console.log(`[diagnose2] bad_count=${d2.bad_count}`);
for (const b of d2.bad || []) console.log('  ✗', b);
if (!d2.bad_count) console.log('  (không tìm thấy repeater row hỏng)');
