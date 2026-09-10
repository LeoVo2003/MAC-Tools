import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  getLiveSession,
  listLiveSessions,
  pushSnapshotOnLog,
  scheduleSnapshotOnLog,
  startSnapshotLive,
  startScreencastLive,
  stopLiveSession,
} from '../src/liveSession.js';

afterEach(async () => {
  await Promise.all(listLiveSessions().map(stopLiveSession));
});

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function mockCdp({ failStart = false } = {}) {
  const client = new EventEmitter();
  client.calls = [];
  client.detached = false;
  client.send = async (method, params) => {
    client.calls.push({ method, params });
    if (failStart && method === 'Page.startScreencast') throw new Error('start failed');
  };
  client.detach = async () => { client.detached = true; };
  return { client, page: { createCDPSession: async () => client } };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

test('screencast forwards every frame from concurrent sessions at native viewport size', async () => {
  const first = mockCdp();
  const second = mockCdp();
  const frames = [];
  await startScreencastLive('first', {}, first.page, (frame) => frames.push(frame));
  await startScreencastLive('second', {}, second.page, (frame) => frames.push(frame));

  for (let i = 0; i < 3; i += 1) {
    first.client.emit('Page.screencastFrame', { sessionId: i, data: `first-${i}` });
    second.client.emit('Page.screencastFrame', { sessionId: i + 10, data: `second-${i}` });
  }
  await flush();

  assert.deepEqual(frames.map((frame) => [frame.sessionId, frame.image]), [
    ['first', 'first-0'], ['second', 'second-0'],
    ['first', 'first-1'], ['second', 'second-1'],
    ['first', 'first-2'], ['second', 'second-2'],
  ]);
  for (const { client } of [first, second]) {
    const start = client.calls.find((call) => call.method === 'Page.startScreencast');
    assert.equal(start.params.everyNthFrame, 1);
    assert.equal(start.params.maxWidth, undefined);
    assert.equal(start.params.maxHeight, undefined);
    assert.equal(client.calls.filter((call) => call.method === 'Page.screencastFrameAck').length, 3);
  }
});

test('snapshot shows the initial and current log frame immediately', async () => {
  let image = 'initial';
  const page = { screenshot: async () => image };
  const frames = [];
  await startSnapshotLive('snapshot', {}, page, (frame) => frames.push(frame));
  assert.deepEqual(frames.map((frame) => frame.image), ['initial']);

  image = 'current-log';
  scheduleSnapshotOnLog('snapshot');
  await getLiveSession('snapshot').captureChain;
  assert.deepEqual(frames.map((frame) => frame.image), ['initial', 'current-log']);
  assert.equal(frames[1].meta.lag, undefined);
});

test('snapshot capture failure does not replay stale images and recovers on the next log', async () => {
  let failed = false;
  let image = 'initial';
  const page = { screenshot: async () => {
    if (failed) throw new Error('page navigating');
    return image;
  } };
  const frames = [];
  await startSnapshotLive('snapshot', {}, page, (frame) => frames.push(frame.image));
  failed = true;
  await pushSnapshotOnLog('snapshot');
  assert.deepEqual(frames, ['initial']);
  failed = false;
  image = 'recovered';
  await pushSnapshotOnLog('snapshot');
  assert.deepEqual(frames, ['initial', 'recovered']);
});

test('stopped snapshot sessions discard in-flight and queued captures after replacement', async () => {
  const capture = deferred();
  let oldCalls = 0;
  const oldPage = { screenshot: async () => {
    oldCalls += 1;
    return oldCalls === 1 ? 'old-initial' : capture.promise;
  } };
  const frames = [];
  const oldEntry = await startSnapshotLive('snapshot', {}, oldPage, (frame) => frames.push(frame.image));
  scheduleSnapshotOnLog('snapshot');
  scheduleSnapshotOnLog('snapshot');
  await flush();
  await stopLiveSession('snapshot');

  let newCalls = 0;
  const newPage = { screenshot: async () => {
    newCalls += 1;
    return 'new-initial';
  } };
  await startSnapshotLive('snapshot', {}, newPage, (frame) => frames.push(frame.image));
  capture.resolve('stale-capture');
  await oldEntry.captureChain;
  assert.deepEqual(frames, ['old-initial', 'new-initial']);
  assert.equal(oldCalls, 2);
  assert.equal(newCalls, 1);
});

test('screencast stop cleans up CDP and suppresses frames already awaiting acknowledgement', async () => {
  const { client, page } = mockCdp();
  const acknowledgement = deferred();
  const originalSend = client.send;
  client.send = async (method, params) => {
    await originalSend(method, params);
    if (method === 'Page.screencastFrameAck') await acknowledgement.promise;
  };
  const frames = [];
  await startScreencastLive('screen', {}, page, (frame) => frames.push(frame));
  client.emit('Page.screencastFrame', { sessionId: 1, data: 'in-flight' });
  await stopLiveSession('screen');
  acknowledgement.resolve();
  await flush();

  assert.equal(frames.length, 0);
  assert.equal(client.listenerCount('Page.screencastFrame'), 0);
  assert.equal(client.detached, true);
  assert.equal(getLiveSession('screen'), null);
  assert.equal(client.calls.filter((call) => call.method === 'Page.stopScreencast').length, 1);
});

test('failed screencast startup removes the session and detaches CDP', async () => {
  const { client, page } = mockCdp({ failStart: true });
  await assert.rejects(startScreencastLive('screen', {}, page, () => {}), /start failed/);
  assert.equal(getLiveSession('screen'), null);
  assert.equal(client.listenerCount('Page.screencastFrame'), 0);
  assert.equal(client.detached, true);
});
