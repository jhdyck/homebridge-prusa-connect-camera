const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, rm } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
let Platform;
require('../index')({ registerPlatform: (_id, _alias, ctor) => { Platform = ctor; } });
const jpeg = Buffer.from([0xff, 0xd8, 1, 2, 0xff, 0xd9]);
function platform(config = {}) {
  const logs = [];
  const p = new Platform(message => logs.push(message), config, { on() {} });
  p.logs = logs;
  return p;
}
test('uploads current API contract and registers before first snapshot', async () => {
  const p = platform({ fingerprint: 'a'.repeat(24), name: 'Workshop' });
  p.token = 'A'.repeat(20);
  const calls = [];
  p.uploadClient.defaults.adapter = async config => {
    calls.push(config);
    return { status: 200, data: {}, headers: {}, config };
  };
  await p.uploadSnapshot(jpeg);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, 'https://camera-service.prusa3d.com/v1/camera-info');
  const body = JSON.parse(calls[0].data);
  assert.deepEqual(body.config, { name: 'Workshop' });
  assert.equal(body.device.type, 'WEB');
  assert.ok(body.device.firmware_version);
  assert.equal(calls[0].headers.get('Content-Type'), 'application/json');
  assert.equal(calls[1].url, 'https://camera-service.prusa3d.com/v1/snapshot');
  assert.equal(calls[1].headers.get('Token'), p.token);
  assert.equal(calls[1].headers.get('User-Agent'), `homebridge-prusa-connect-camera/${require('../package.json').version}`);
  assert.equal(calls[1].maxRedirects, 0);
  assert.equal(calls[1].headers.get('Fingerprint'), p.fingerprint);
  assert.equal(calls[1].headers.get('Content-Length'), String(jpeg.length));
  assert.equal(calls[1].headers.get('Content-Type'), 'image/jpeg');
  await p.uploadSnapshot(jpeg);
  assert.equal(calls.length, 3);
  p.shutdown();
});
test('generated fingerprints persist across restart and concurrent initialization', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'prusa-test-'));
  try {
    const first = platform(); const second = platform();
    for (const p of [first, second]) { p.token = 'B'.repeat(20); p.api.user = { storagePath: () => directory }; }
    const [a, b] = await Promise.all([first.ensureFingerprint(), second.ensureFingerprint()]);
    assert.equal(a, b); assert.match(a, /^[a-f0-9]{32}$/);
    const restarted = platform(); restarted.token = first.token; restarted.api = first.api;
    assert.equal(await restarted.ensureFingerprint(), a);
    first.shutdown(); second.shutdown(); restarted.shutdown();
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('keeps legacy 16–64 character identities and rejects invalid fingerprints', async () => {
  for (const size of [16, 24, 64]) { const p = platform({ fingerprint: 'x'.repeat(size) }); assert.equal(await p.ensureFingerprint(), 'x'.repeat(size)); p.shutdown(); }
  for (const size of [15, 65]) { const p = platform({ fingerprint: 'x'.repeat(size) }); await assert.rejects(p.ensureFingerprint(), /16–64/); p.shutdown(); }
});
test('rejects invalid/oversized JPEGs without network activity', async () => {
  const p = platform(); p.uploadClient.put = () => assert.fail('must not upload');
  await assert.rejects(p.uploadSnapshot(Buffer.from('not jpeg')), /JPEG/);
  const large = Buffer.alloc(1000001); large.set([255,216]); large.set([255,217], large.length - 2);
  await assert.rejects(p.uploadSnapshot(large), /1 MB/); p.shutdown();
});
test('runtime intervals respect rate limit and shutdown cancels sleeps', async () => {
  const p = platform({ snapshotInterval: 1, rebroadcastPort: 99999 });
  assert.equal(p.snapshotIntervalSeconds, 10); assert.equal(p.rebroadcastPort, 65535);
  const sleeping = p.sleep(60000); p.shutdown(); await sleeping;
  assert.equal(p.pendingSleeps.size, 0); assert.ok(p.abortController.signal.aborted);
});
test('disconnects slow MJPEG viewers', () => {
  const p = platform(); let destroyed = false;
  const res = { writableLength: 3 * 1024 * 1024, destroy() { destroyed = true; }, write() { assert.fail('must not queue'); } };
  p.streamClients.add(res); p.writeMjpegFrame(res, jpeg);
  assert.ok(destroyed); assert.equal(p.streamClients.size, 0); p.shutdown();
});
test('missing FFmpeg rejects cleanly rather than emitting an unhandled error', async () => {
  const p = platform({ ffmpegPath: '/nonexistent/prusa-ffmpeg' });
  await assert.rejects(p.captureSnapshotToBuffer(1), /ENOENT/); p.shutdown();
});
test('credentials are redacted from logs', () => {
  const p = platform({ fingerprint: 'f'.repeat(24) }); p.token = 'T'.repeat(20);
  p.logError(`${p.token} ${p.fingerprint} rtsp://user:pass@host/live?password=secret`);
  const last = p.logs.at(-1);
  for (const secret of [p.token, p.fingerprint, 'user:pass', 'secret']) assert.ok(!last.includes(secret));
  p.shutdown();
});
test('authentication failure stops retries with actionable instructions', async () => {
  const p = platform(); p.token = 'A'.repeat(20); let calls = 0;
  p.registerCamera = async () => { calls++; throw { response: { status: 403 } }; };
  p.startSnapshotLoop(); await p.snapshotLoop;
  assert.equal(calls, 1); assert.match(p.logs.at(-1), /15-minute/); p.shutdown();
});
test('transient failure backs off and honours Retry-After', async () => {
  const p = platform({ snapshotInterval: 10 }); p.token = 'A'.repeat(20); let calls = 0; const delays = [];
  p.registerCamera = async () => { calls++; throw { response: { status: 503, headers: { 'retry-after': '120' } } }; };
  p.sleep = async ms => { delays.push(ms); if (calls === 2) p.shutdown(); };
  p.startSnapshotLoop(); await p.snapshotLoop;
  assert.deepEqual(delays, [120000, 120000]);
});
test('real FFmpeg captures a synthetic source and respects quoted arguments', async () => {
  const p = platform({ videoSource: '-f lavfi -i "color=c=blue:s=320x240:r=1"' });
  try {
    const image = await p.captureSnapshotToBuffer(1);
    assert.equal(image.readUInt16BE(0), 0xffd8);
    assert.equal(image.readUInt16BE(image.length - 2), 0xffd9);
    assert.ok(image.length < 1000000);
  } finally { p.shutdown(); }
});
test('real FFmpeg continuous capture produces frames and shuts down', async () => {
  const p = platform({ videoSource: '-re -f lavfi -i testsrc=size=160x120:rate=5' });
  p.rebroadcastEnabled = true;
  try {
    p.startCapturePipeline();
    await new Promise((resolve, reject) => {
      const deadline = Date.now() + 5000;
      const poll = setInterval(() => {
        if (p.latestFrame) { clearInterval(poll); resolve(); }
        else if (Date.now() > deadline) { clearInterval(poll); reject(new Error(p.logs.join('\n'))); }
      }, 25);
    });
    assert.equal(p.latestFrame.readUInt16BE(0), 0xffd8);
    const child = p.captureProcess;
    const closed = new Promise(resolve => child.once('close', resolve));
    p.shutdown(); await closed;
    assert.equal(p.captureProcess, null); assert.equal(p.captureRestartTimer, null);
  } finally { p.shutdown(); }
});
