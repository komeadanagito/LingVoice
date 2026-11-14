import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { Downloader } from '../src/main/downloader';
import {
  canonicalizeBiliUrl, inspectBilibili, parseBilibiliVideo, parseNetscapeCookies,
  resetPlayurlCache, resetWbiCache, selectHeight, signWbi, windowsFileName,
} from '../src/main/bilibili';

const url = 'https://www.bilibili.com/video/BV1xx411c7mD';

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

function viewPayload() {
  return {
    code: 0,
    data: {
      bvid: 'BV1xx411c7mD', aid: 1, title: '演示视频', pic: 'http://i0.hdslb.com/bfs/cover.jpg', duration: 15,
      owner: { name: '测试UP' },
      pages: [
        { cid: 11, page: 1, part: '上', duration: 8 },
        { cid: 12, page: 2, part: '下', duration: 7 },
      ],
    },
  };
}

function playurlPayload() {
  return {
    code: 0,
    data: {
      dash: {
        video: [
          { baseUrl: 'https://upos.example/v1080.m4s', height: 1080, bandwidth: 2000 },
          { base_url: 'https://upos.example/v720.m4s', height: 720, bandwidth: 1000 },
        ],
        audio: [{ baseUrl: 'https://upos.example/a.m4s', bandwidth: 128 }],
      },
    },
  };
}

async function withFetch<T>(handler: (url: string) => Response | Promise<Response>, action: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  resetWbiCache();
  resetPlayurlCache();
  globalThis.fetch = (async (input: RequestInfo | URL) => handler(String(input))) as typeof fetch;
  try { return await action(); }
  finally { globalThis.fetch = original; resetWbiCache(); resetPlayurlCache(); }
}

test('canonicalizes Bilibili video URLs and parses BV, av, and part numbers', () => {
  assert.equal(canonicalizeBiliUrl(`${url}/?p=2&trackid=web_pegasus_1#reply`), `${url}/?p=2`);
  assert.deepEqual(parseBilibiliVideo(`${url}/?p=2`), { bvid: 'BV1xx411c7mD', page: 2 });
  assert.deepEqual(parseBilibiliVideo('https://www.bilibili.com/video/av123'), { aid: '123', page: 1 });
});

test('selects the highest available height at or below the requested cap', () => {
  const streams = [{ height: 1080 }, { height: 720 }, { height: 480 }];
  assert.equal(selectHeight(streams, 'best'), 1080);
  assert.equal(selectHeight(streams, '720'), 720);
  assert.equal(selectHeight(streams, '360'), 480);
  assert.throws(() => selectHeight([], 'best'), /音视频流/);
  assert.throws(() => selectHeight(streams, '720;evil'), /清晰度/);
});

test('falls back to the legacy playurl endpoint when WBI signing is rejected', async () => {
  const info = await withFetch(url => {
    if (url.includes('/x/web-interface/view') || url.includes('/wbi/view')) return json(viewPayload());
    if (url.includes('/x/web-interface/nav')) {
      return json({ code: -101, data: { wbi_img: { img_url: 'https://i0.hdslb.com/bfs/wbi/imgkey.png', sub_url: 'https://i0.hdslb.com/bfs/wbi/subkey.png' } } });
    }
    if (url.includes('/x/player/wbi/playurl')) return json({ code: -352, message: 'risk control' });
    if (url.includes('/x/player/playurl')) return json(playurlPayload());
    throw new Error(`unexpected ${url}`);
  }, () => inspectBilibili(url));
  assert.deepEqual(info.heights, [1080, 720]);
});

test('surfaces the Bilibili error code when every playurl attempt fails', async () => {
  const downloader = new Downloader({ dataDir: '.', ffmpegPath: process.execPath, emit() {} });
  await withFetch(url => {
    if (url.includes('/x/web-interface/view') || url.includes('/wbi/view')) return json(viewPayload());
    if (url.includes('/x/web-interface/nav')) {
      return json({ code: -101, data: { wbi_img: { img_url: 'https://i0.hdslb.com/bfs/wbi/imgkey.png', sub_url: 'https://i0.hdslb.com/bfs/wbi/subkey.png' } } });
    }
    if (url.includes('playurl')) return json({ code: -10403, message: '区域限制' });
    throw new Error(`unexpected ${url}`);
  }, async () => {
    const info = await downloader.inspect(url);
    assert.deepEqual(info.heights, []);
    await assert.rejects(
      downloader.download({ url, folder: os.tmpdir(), height: 'best' }),
      (error: unknown) => {
        assert.equal((error as { key?: string }).key, 'errors.bilibiliStreamDetail');
        assert.equal((error as { values?: { code?: string } }).values?.code, '-10403');
        return true;
      },
    );
  });
});

test('sanitizes Windows filenames and reads Bilibili Netscape cookies', () => {
  assert.equal(windowsFileName('a<>:"/\\|?*b. '), 'a_________b');
  const cookies = parseNetscapeCookies([
    '# Netscape HTTP Cookie File',
    '.bilibili.com\tTRUE\t/\tTRUE\t0\tSESSDATA\tabc',
    '#HttpOnly_.bilibili.com\tTRUE\t/\tTRUE\t0\tbili_jct\tdef',
    '.example.com\tTRUE\t/\tTRUE\t0\tignore\t1',
  ].join('\n'));
  assert.equal(cookies, 'SESSDATA=abc; bili_jct=def');
});

test('WBI signatures are stable for a known mixin key and timestamp', () => {
  const signed = signWbi({ bvid: 'BV1xx411c7mD', cid: 11 }, 'mixin-key-for-tests-32-chars!!', 1700000000);
  assert.equal(signed.wts, '1700000000');
  assert.match(signed.w_rid, /^[a-f0-9]{32}$/);
  assert.equal(signWbi({ cid: 11, bvid: 'BV1xx411c7mD' }, 'mixin-key-for-tests-32-chars!!', 1700000000).w_rid, signed.w_rid);
});

test('inspects Bilibili videos through the public API instead of page initial state', async () => {
  const info = await withFetch(url => {
    if (url.includes('/x/web-interface/view') || url.includes('/wbi/view')) return json(viewPayload());
    if (url.includes('/x/web-interface/nav')) {
      return json({ code: -101, data: { wbi_img: { img_url: 'https://i0.hdslb.com/bfs/wbi/imgkey.png', sub_url: 'https://i0.hdslb.com/bfs/wbi/subkey.png' } } });
    }
    if (url.includes('/x/player/wbi/playurl')) return json(playurlPayload());
    throw new Error(`unexpected ${url}`);
  }, () => inspectBilibili(`${url}?trackid=web_pegasus_1`));
  assert.equal(info.title, '演示视频');
  assert.equal(info.uploader, '测试UP');
  assert.equal(info.thumbnail, 'https://i0.hdslb.com/bfs/cover.jpg');
  assert.equal(info.duration, 8);
  assert.equal(info.partCount, 2);
  assert.deepEqual(info.heights, [1080, 720]);
});

test('Downloader inspects Bilibili without launching yt-dlp', async () => {
  const downloader = new Downloader({ dataDir: '.', emit() {} });
  downloader.run = async () => { throw new Error('yt-dlp should not run for Bilibili'); };
  const info = await withFetch(url => {
    if (url.includes('/x/web-interface/view') || url.includes('/wbi/view')) return json(viewPayload());
    if (url.includes('/x/web-interface/nav')) {
      return json({ code: -101, data: { wbi_img: { img_url: 'https://i0.hdslb.com/bfs/wbi/imgkey.png', sub_url: 'https://i0.hdslb.com/bfs/wbi/subkey.png' } } });
    }
    if (url.includes('/x/player/wbi/playurl')) return json(playurlPayload());
    throw new Error(`unexpected ${url}`);
  }, () => downloader.inspect(url));
  assert.equal(info.title, '演示视频');
  assert.equal(downloader.busy, false);
});

test('Downloader inspect keeps Bilibili metadata when playurl is unavailable', async () => {
  const downloader = new Downloader({ dataDir: '.', emit() {} });
  const info = await withFetch(url => {
    if (url.includes('/x/web-interface/view') || url.includes('/wbi/view')) return json(viewPayload());
    if (url.includes('/x/web-interface/nav')) return json({ code: 0, data: {} });
    throw new Error(`unexpected ${url}`);
  }, () => downloader.inspect(`${url}/?p=2`));
  assert.equal(info.title, '演示视频');
  assert.equal(info.duration, 7);
  assert.deepEqual(info.heights, []);
});

test('inspectBilibili can send Netscape cookies to the view API', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lingvoice-bili-'));
  const cookieFile = path.join(directory, 'cookies.txt');
  await fs.writeFile(cookieFile, '# Netscape HTTP Cookie File\n.bilibili.com\tTRUE\t/\tFALSE\t0\tSESSDATA\tlogin-token\n');
  try {
    let cookie = '';
    await withFetch(url => {
      if (url.includes('/x/web-interface/wbi/view') || url.includes('/x/web-interface/view')) return json(viewPayload());
      if (url.includes('/x/web-interface/nav')) return json({ code: 0, data: {} });
      throw new Error(`unexpected ${url}`);
    }, async () => {
      const original = globalThis.fetch;
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        cookie = String(new Headers(init?.headers).get('cookie') || '');
        return original(input, init);
      }) as typeof fetch;
      return inspectBilibili(url, cookieFile);
    });
    assert.match(cookie, /SESSDATA=login-token/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
