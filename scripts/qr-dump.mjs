/**
 * QR dump element: lấy 1 element (kèm settings) theo element ID để so sánh.
 * Usage: node scripts/qr-dump.mjs <postId> <elementId>
 * (dùng .env: QR_WP_BASE, QR_WP_USER, QR_WP_APP_PASSWORD)
 */
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env') });

const [postId, elementId] = process.argv.slice(2);
if (!postId || !elementId) {
  console.error('Usage: node scripts/qr-dump.mjs <postId> <elementId>');
  process.exit(1);
}

const base = (process.env.QR_WP_BASE || 'https://qr.macmarketing.us').replace(/\/$/, '');
const user = process.env.QR_WP_USER || '';
const pass = process.env.QR_WP_APP_PASSWORD || '';
const auth = 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');

const res = await fetch(`${base}/wp-json/qr/v1/dump-element/${postId}/${elementId}`, {
  headers: { Authorization: auth },
});
const data = await res.json().catch(() => ({}));
if (!res.ok || !data.ok) {
  console.error('Lỗi:', data.error || `HTTP ${res.status}`);
  process.exit(1);
}
console.log(JSON.stringify(data.element, null, 2));
