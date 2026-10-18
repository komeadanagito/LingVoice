import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { Downloader, normalizeUrl, summarize, formatSelector, parseProgress } from '../src/main/downloader';
import type { DownloadEvent, DownloadResult, VideoInfo } from '../src/shared/contracts';
import { LocalizedError, translate } from '../src/shared/i18n/translate';

const url = 'https://www.bilibili.com/video/BV1xx411c7mD';

test('normalizes a video URL and keeps only its selected part', () => {
  assert.equal(normalizeUrl(`${url}/?p=2&share_source=copy#reply`), `${url}/?p=2`);
});
test('extracts links from Chinese share text', () => {
  assert.equal(normalizeUrl(`推荐视频 ${url}，快来看看`), url);
});
test('normalizes mobile, HTTP and short-link hosts', () => {
  assert.equal(normalizeUrl('http://m.bilibili.com/video/av123'), 'https://www.bilibili.com/video/av123');
  assert.equal(normalizeUrl('https://www.b23.tv/abc123?share=1'), 'https://b23.tv/abc123');
});
test('normalizes YouTube watch, shorts, and youtu.be links', () => {
  assert.equal(normalizeUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s'), 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  assert.equal(normalizeUrl('https://youtu.be/dQw4w9WgXcQ?si=abc'), 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  assert.equal(normalizeUrl('https://www.youtube.com/shorts/dQw4w9WgXcQ'), 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  assert.equal(normalizeUrl('分享视频：https://youtu.be/dQw4w9WgXcQ 很好看'), 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
});
test('rejects other sites, misleading hosts, credentials, ports, and non-video pages', () => {
  for (const input of ['https://example.com/video/BV123', 'https://bilibili.com.evil.test/video/BV123',
    'https://user:pass@bilibili.com/video/av123', 'https://bilibili.com:444/video/av123',
    'https://bilibili.com/bangumi/play/ep123', 'file:///tmp/video', '', '--exec evil']) {
    assert.throws(() => normalizeUrl(input), input);
  }
});
test('summarizes unique video heights, excluding audio-only formats', () => {
  const info: VideoInfo = summarize({ title: '<img onerror=evil>', formats: [
    { height: 1080, vcodec: 'avc1' }, { height: 720, vcodec: 'hevc' },
    { height: 1080, vcodec: 'hevc' }, { height: 2160, vcodec: 'none' },
  ], thumbnail: 'javascript:evil' });
  assert.deepEqual(info.heights, [1080, 720]);
  assert.equal(info.thumbnail, '');
  assert.equal(info.title, '<img onerror=evil>');
});
test('selects best format or caps the requested height', () => {
  assert.equal(formatSelector('best'), 'bv*+ba/b');
  assert.equal(formatSelector('720'), 'bv*[height<=720]+ba/b[height<=720]');
  for (const invalid of ['720;evil', 0, -1, 99999, null, true, [720], {}]) assert.throws(() => formatSelector(invalid));
});
test('parses machine-readable progress and handles estimated totals', () => {
  const progress = parseProgress('LINGVOICE_PROGRESS:{"downloaded_bytes":512,"total_bytes_estimate":1024,"speed":100,"eta":5,"status":"downloading"}');
  assert.ok(progress);
  assert.equal(progress.percent, 50);
  assert.equal(progress.speed, 100);
  const unknownTotal = parseProgress('LINGVOICE_PROGRESS:{"downloaded_bytes":512}');
  assert.ok(unknownTotal);
  assert.equal(unknownTotal.percent, null);
  assert.equal(parseProgress('LINGVOICE_PROGRESS:not-json'), null);
  assert.equal(parseProgress('[Merger] Merging formats'), null);
});
test('rejects overlapping operations and releases the lock after errors', async () => {
  const downloader = new Downloader({ dataDir: '.', emit() {} });
  let finish: () => void = () => { throw new Error('Action did not start'); };
  const first = downloader.exclusive(() => new Promise<void>(resolve => { finish = resolve; }));
  await assert.rejects(downloader.exclusive(async () => {}), /已有任务/);
  finish();
  await first;
  await assert.rejects(downloader.exclusive(async () => { throw new Error('test'); }), /test/);
  assert.equal(downloader.busy, false);
  assert.equal(await downloader.exclusive(async () => 42), 42);
});
test('inspection uses cookie arguments safely and rejects playlists', async () => {
  const downloader = new Downloader({ dataDir: '.', emit() {} });
  let args: string[] = [];
  downloader.run = async options => { args = options; return '{"title":"演示","formats":[]}'; };
  assert.equal((await downloader.inspect(url, 'C:\\my cookies.txt')).title, '演示');
  assert.equal(args[args.indexOf('--cookies') + 1], 'C:\\my cookies.txt');
  assert.ok(args.includes('--ignore-config'));
  assert.equal(args.at(-2), '--');
  downloader.run = async () => '{"_type":"playlist"}';
  await assert.rejects(downloader.inspect(url), /暂不支持合集/);
});
test('download forwards progress and only returns existing in-folder output', async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'lingvoice-test-'));
  try {
    const file = path.join(folder, 'video.mp4');
    await fs.writeFile(file, 'fixture');
    const events: DownloadEvent[] = [];
    const downloader = new Downloader({ dataDir: folder, ffmpegPath: file, emit: event => events.push(event) });
    downloader.run = async (args, line) => {
      assert.ok(args.includes('--ffmpeg-location'));
      assert.ok(args.includes('bv*[height<=720]+ba/b[height<=720]'));
      assert.ok(line);
      line('LINGVOICE_PROGRESS:{"downloaded_bytes":10,"total_bytes":20}');
      line('[Merger] Merging formats');
      line(`LINGVOICE_FILE:${file}`);
      return '';
    };
    const result: DownloadResult = await downloader.download({ url, folder, height: '720' });
    assert.deepEqual(result, { file });
    const progress = events[0];
    assert.ok(progress && progress.type === 'progress');
    assert.equal(progress.percent, 50);
    assert.deepEqual(events[1], { type: 'status', message: '[Merger] Merging formats' });
    downloader.run = async (_args, line) => {
      assert.ok(line);
      line(`LINGVOICE_FILE:${path.join(folder, '..', 'outside.mp4')}`);
      return '';
    };
    await assert.rejects(downloader.download({ url, folder, height: 'best' }), /路径异常/);
    downloader.run = async () => '';
    await assert.rejects(downloader.download({ url, folder, height: 'best' }), /未返回下载文件/);
    downloader.run = async (_args, line) => {
      assert.ok(line);
      line(`LINGVOICE_FILE:${path.join(folder, 'missing.mp4')}`);
      return '';
    };
    await assert.rejects(downloader.download({ url, folder, height: 'best' }), /ENOENT/);
  } finally { await fs.rm(folder, { recursive: true, force: true }); }
});
test('cancellation before process launch prevents execution', async () => {
  const downloader = new Downloader({ dataDir: '.', emit() {} });
  downloader.ensureBinary = async () => 'not-executed.exe';
  downloader.cancel();
  const result: Promise<string> = downloader.run([]);
  await assert.rejects(result, /已取消任务/);
});
test('validates external video JSON and keeps shared contract field types', () => {
  for (const invalid of [null, [], 'video', 42]) assert.throws(() => summarize(invalid), /视频信息无效/);
  const info = summarize({ id: 42, title: {}, uploader: [], duration: 'Infinity', playlist_count: {}, formats: [null, 42, { vcodec: 'avc1', height: '720' }, { vcodec: 'avc1', height: 'Infinity' }] });
  assert.deepEqual(info, { id: undefined, title: '未命名视频', uploader: '未知 UP 主', titleKey: 'video.untitled', uploaderKey: 'video.unknownUploader', duration: 0, thumbnail: '', heights: [720], partCount: 1 });
});
test('validates malformed progress JSON and normalizes untrusted field values', () => {
  for (const value of ['null', '[]', '42', '"progress"']) assert.equal(parseProgress(`LINGVOICE_PROGRESS:${value}`), null);
  const progress = parseProgress('LINGVOICE_PROGRESS:{"status":{},"downloaded_bytes":"20","total_bytes":"10","speed":"Infinity","eta":{},"filename":42}');
  assert.deepEqual(progress, { status: undefined, percent: 100, downloaded: 20, total: 10, speed: 0, eta: 0, filename: '' });
});
test('inspection rejects invalid JSON shapes and releases its lock', async () => {
  const downloader = new Downloader({ dataDir: '.', emit() {} });
  for (const raw of ['null', '[]', 'not-json']) {
    downloader.run = async () => raw;
    await assert.rejects(downloader.inspect(url));
    assert.equal(downloader.busy, false);
  }
  downloader.run = async () => '{"title":"Recovered"}';
  assert.equal((await downloader.inspect(url)).title, 'Recovered');
});
test('missing optional FFmpeg configuration fails explicitly and releases its lock', async () => {
  const downloader = new Downloader({ dataDir: '.', emit() {} });
  await assert.rejects(downloader.download({ url, folder: '.', height: 'best' }), /未配置 FFmpeg/);
  assert.equal(downloader.busy, false);
});

test('application errors expose translation keys while preserving Chinese messages', () => {
  assert.throws(() => normalizeUrl(''), error => {
    assert.ok(error instanceof LocalizedError);
    assert.equal(error.key, 'errors.urlMissing');
    assert.match(error.message, /请粘贴完整/);
    assert.notEqual(translate('en', error.key), error.message);
    return true;
  });
  assert.throws(() => formatSelector('invalid'), { key: 'errors.quality' });
  assert.throws(() => summarize(null), { key: 'errors.videoInfo' });
});

test('metadata fallback keys appear only when source labels are missing', () => {
  const known = summarize({ title: 'Title', uploader: 'Uploader' });
  assert.equal('titleKey' in known, false);
  assert.equal('uploaderKey' in known, false);
  const missing = summarize({ title: '', uploader: null });
  assert.equal(missing.titleKey, 'video.untitled');
  assert.equal(missing.uploaderKey, 'video.unknownUploader');
});

test('initial component preparation provides a translation key', { skip: process.platform !== 'win32' }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lingvoice-tools-'));
  const events: DownloadEvent[] = [];
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response('', { status: 503 });
    const downloader = new Downloader({ dataDir: directory, emit: event => events.push(event) });
    await assert.rejects(downloader.ensureBinary(), { key: 'errors.toolsFetch' });
    assert.deepEqual(events, [{ type: 'status', message: '首次使用：正在下载并校验下载组件，请稍候…', messageKey: 'status.preparingTools' }]);
  } finally {
    globalThis.fetch = originalFetch;
    await fs.rm(directory, { recursive: true, force: true });
  }
});
