import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCsvText, importRunsFromCsv, listRuns, deleteRunsByIds } from '../src/tracking.js';

test('parseCsvText đọc header + cell có dấu phẩy trong quotes', () => {
  const { headers, records } = parseCsvText(
    'startedAt,error\n2026-01-01T00:00:00.000Z,"a, b"\n'
  );
  assert.deepEqual(headers, ['startedAt', 'error']);
  assert.equal(records.length, 1);
  assert.equal(records[0].error, 'a, b');
});

test('importRunsFromCsv nhận User Guide CSV và bỏ trùng lần 2', () => {
  const csv = [
    'startedAt,finishedAt,durationMs,toolUser,websiteUrl,status,username,error',
    '2099-01-01T00:00:00.000Z,2099-01-01T00:01:00.000Z,60000,tester@macusaone.com,https://example-import-test.com,success,example-admin,',
  ].join('\n');
  const first = importRunsFromCsv(csv, { kind: 'f-package', importedBy: 'admin' });
  assert.equal(first.ok, true);
  assert.equal(first.inserted, 1);
  const second = importRunsFromCsv(csv, { kind: 'f-package', importedBy: 'admin' });
  assert.equal(second.inserted, 0);
  assert.equal(second.skipped, 1);
  const runs = listRuns({ limit: 2000, user: 'tester@macusaone.com' });
  const hit = runs.filter((r) => r.websiteUrl === 'https://example-import-test.com');
  assert.ok(hit.length >= 1);
  deleteRunsByIds(hit.map((r) => r.id));
});

test('importRunsFromCsv nhận Review Link CSV', () => {
  const csv = [
    '"Time","Platform","IP","Input URL","Source URL","ID","Review URL"',
    '"2099-02-01T00:00:00.000Z","google","1.1.1.1","https://maps.app.goo.gl/x","https://maps.google.com/x","ChIJtestImport","https://search.google.com/local/writereview?placeid=ChIJtestImport"',
  ].join('\n');
  const first = importRunsFromCsv(csv, { kind: 'auto', importedBy: 'admin' });
  assert.equal(first.kind, 'review-link');
  assert.equal(first.inserted, 1);
  const second = importRunsFromCsv(csv, { kind: 'auto' });
  assert.equal(second.skipped, 1);
  const runs = listRuns({ limit: 2000, tool: 'review-link' });
  const hit = runs.filter((r) => r.importKey?.includes('ChIJtestImport'));
  assert.ok(hit.length >= 1);
  deleteRunsByIds(hit.map((r) => r.id));
});
