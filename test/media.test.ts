import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { byteRange, mediaResponse } from '../src/main/media';
import { filePathToMediaUrl } from '../src/renderer/utils/media';

test('media paths preserve Chinese, spaces, #, ? and percent characters', () => {
  const source = 'D:\\视频\\标题 #1? 100%.mp4';
  const url = new URL(filePathToMediaUrl(source));
  assert.equal(url.hash, '');
  assert.equal(url.search, '');
  assert.equal(decodeURIComponent(url.pathname), '/D:/视频/标题 #1? 100%.mp4');
});
test('byte ranges support seeking, suffixes and reject impossible requests', () => {
  assert.deepEqual(byteRange('bytes=2-5', 10), { start: 2, end: 5 });
  assert.deepEqual(byteRange('bytes=7-', 10), { start: 7, end: 9 });
  assert.deepEqual(byteRange('bytes=-3', 10), { start: 7, end: 9 });
  for (const header of ['bytes=10-', 'bytes=5-2', 'bytes=-0', 'bytes=0-1,3-4', 'nonsense']) assert.equal(byteRange(header, 10), null);
});
test('local media returns real file bytes, MIME type and seekable partial responses', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'lingvoice-media-'));
  const file = path.join(directory, '视频 #100%.mp4');
  try {
    await writeFile(file, '0123456789');
    const url = filePathToMediaUrl(file);
    const response = await mediaResponse(new Request(url));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'video/mp4');
    assert.equal(await response.text(), '0123456789');
    const partial = await mediaResponse(new Request(url, { headers: { Range: 'bytes=2-5' } }));
    assert.equal(partial.status, 206);
    assert.equal(partial.headers.get('content-range'), 'bytes 2-5/10');
    assert.equal(await partial.text(), '2345');
    const head = await mediaResponse(new Request(url, { method: 'HEAD' }));
    assert.equal(head.headers.get('content-length'), '10');
    assert.equal(await head.text(), '');
    const invalid = await mediaResponse(new Request(url, { headers: { Range: 'bytes=50-' } }));
    assert.equal(invalid.status, 416);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
