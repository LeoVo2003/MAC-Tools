import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server.js';

test('GET /api/health không cần đăng nhập và không lộ chi tiết', async () => {
  const app = createApp();
  const server = app.listen(0);
  try {
    const { port } = server.address();
    const res = await fetch(`http://127.0.0.1:${port}/api/health`);
    const body = await res.json();
    assert.equal(typeof body.ok, 'boolean');
    assert.ok(body.version);
    assert.equal(body.chrome, undefined);
    assert.equal(body.queue, undefined);
    assert.equal(body.disk, undefined);
    assert.ok(res.status === 200 || res.status === 503);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
