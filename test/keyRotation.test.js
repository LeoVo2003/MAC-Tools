import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

// Đặt env TRƯỚC khi import module (module đọc env lúc gọi hàm, nhưng
// cảnh báo ADMIN_EMAILS chạy lúc load nên set NODE_ENV=test cho sạch)
process.env.NODE_ENV = 'test';

const { encryptSecret, decryptSecret } = await import('../src/userStore.js');

const KEY_A = 'a'.repeat(40); // 40 ký tự, đủ mạnh
const KEY_B = 'b'.repeat(40);
const KEY_C = 'c'.repeat(40);

function keyId(secret) {
  return crypto.createHash('sha256').update(secret).digest('hex').slice(0, 8);
}

let savedEnv;
beforeEach(() => {
  savedEnv = { APP_SECRET: process.env.APP_SECRET, APP_SECRET_PREVIOUS: process.env.APP_SECRET_PREVIOUS };
  delete process.env.APP_SECRET_PREVIOUS;
});
afterEach(() => {
  if (savedEnv.APP_SECRET === undefined) delete process.env.APP_SECRET;
  else process.env.APP_SECRET = savedEnv.APP_SECRET;
  if (savedEnv.APP_SECRET_PREVIOUS === undefined) delete process.env.APP_SECRET_PREVIOUS;
  else process.env.APP_SECRET_PREVIOUS = savedEnv.APP_SECRET_PREVIOUS;
});

test('encrypt → decrypt roundtrip với 1 key, format v2 + keyId đúng', () => {
  process.env.APP_SECRET = KEY_A;
  const blob = encryptSecret('mat-khau-wpm-123');
  assert.ok(blob.startsWith(`v2:${keyId(KEY_A)}:`), `format sai: ${blob.slice(0, 20)}...`);
  assert.equal(decryptSecret(blob), 'mat-khau-wpm-123');
});

test('xoay khóa: data mã bằng key A vẫn đọc được khi A thành PREVIOUS', () => {
  process.env.APP_SECRET = KEY_A;
  const oldBlob = encryptSecret('bi-mat-cu');

  // Xoay khóa: B thành current, A thành previous
  process.env.APP_SECRET = KEY_B;
  process.env.APP_SECRET_PREVIOUS = KEY_A;

  // Data cũ vẫn giải mã được
  assert.equal(decryptSecret(oldBlob), 'bi-mat-cu');

  // Data mới mã bằng key B (keyId của B)
  const newBlob = encryptSecret('bi-mat-moi');
  assert.ok(newBlob.startsWith(`v2:${keyId(KEY_B)}:`));
  assert.equal(decryptSecret(newBlob), 'bi-mat-moi');

  // Hai blob dùng keyId khác nhau
  assert.notEqual(oldBlob.split(':')[1], newBlob.split(':')[1]);
});

test('xóa PREVIOUS khi không còn data cũ → data mới vẫn OK', () => {
  process.env.APP_SECRET = KEY_B;
  process.env.APP_SECRET_PREVIOUS = KEY_A;
  const blob = encryptSecret('chi-dung-key-b');
  delete process.env.APP_SECRET_PREVIOUS;
  assert.equal(decryptSecret(blob), 'chi-dung-key-b');
});

test('data mã bằng key đã bị xóa (không còn trong current/previous) → lỗi rõ ràng', () => {
  process.env.APP_SECRET = KEY_A;
  const oldBlob = encryptSecret('se-mat');

  process.env.APP_SECRET = KEY_C; // key hoàn toàn mới, A không còn ở đâu
  delete process.env.APP_SECRET_PREVIOUS;

  assert.throws(() => decryptSecret(oldBlob), /APP_SECRET_PREVIOUS/);
});

test('backward compat: format v1 cũ vẫn giải mã bằng key hiện tại', () => {
  process.env.APP_SECRET = KEY_A;
  // Tự dựng blob v1 bằng key A (mô phỏng data từ bản cũ)
  const key = crypto.createHash('sha256').update(KEY_A).digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update('legacy-data', 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  const v1blob = `v1:${iv.toString('base64')}:${tag.toString('base64')}:${enc.toString('base64')}`;

  assert.equal(decryptSecret(v1blob), 'legacy-data');
});

test('decryptSecret: input rỗng / plaintext trả về nguyên', () => {
  process.env.APP_SECRET = KEY_A;
  assert.equal(decryptSecret(''), '');
  assert.equal(decryptSecret(null), '');
  assert.equal(decryptSecret('plain-text-khong-ma-hoa'), 'plain-text-khong-ma-hoa');
});

test('v2 sai format → throw', () => {
  process.env.APP_SECRET = KEY_A;
  assert.throws(() => decryptSecret('v2:chi-co-2-phan'), /không hợp lệ/);
});
