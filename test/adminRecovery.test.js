import test from 'node:test';
import assert from 'node:assert/strict';

test('POST /api/admin-recovery yêu cầu secret đã cấu hình', async () => {
  const prev = process.env.ADMIN_RECOVERY_SECRET;
  delete process.env.ADMIN_RECOVERY_SECRET;
  process.env.NODE_ENV = process.env.NODE_ENV || 'development';
  const { createApp } = await import('../server.js');
  const app = createApp();
  const server = app.listen(0);
  try {
    const { port } = server.address();
    const res = await fetch(`http://127.0.0.1:${port}/api/admin-recovery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'leo.vo@macusaone.com', secret: 'x' }),
    });
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.match(String(body.error || ''), /ADMIN_RECOVERY_SECRET/i);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    if (prev == null) delete process.env.ADMIN_RECOVERY_SECRET;
    else process.env.ADMIN_RECOVERY_SECRET = prev;
  }
});
