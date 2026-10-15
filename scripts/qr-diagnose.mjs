/**
 * QR diagnose: quét _elementor_data của 1 page tìm settings hỏng.
 * Usage: node scripts/qr-diagnose.mjs <pageId>
 * (dùng .env: QR_WP_BASE, QR_WP_USER, QR_WP_APP_PASSWORD)
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
const res = await fetch(`${base}/wp-json/qr/v1/diagnose/${pageId}`, {
  headers: { Authorization: auth },
});
const text = await res.text();
let data;
try { data = JSON.parse(text); } catch { data = { _raw: text.slice(0, 500) }; }

if (!res.ok) {
  console.error(`HTTP ${res.status}:`, data.message || data._raw || '');
  process.exit(1);
}

console.log(`Page #${data.id}: raw_len=${data.raw_len}, json_ok=${data.json_ok}, top_level=${data.top_level}`);
console.log('meta_rows:', JSON.stringify(data.meta_rows));
console.log(`bad_count=${data.bad_count}`);
for (const b of data.bad || []) console.log('  ✗', b);
if (!data.bad_count) console.log('  (không tìm thấy settings hỏng theo heuristic)');
