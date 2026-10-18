import { test, type TestContext } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { EventEmitter } from 'node:events';
import type { spawn } from 'node:child_process';
import { AsrService, asrEndpoint, pcmWav, parseAsrSegments } from '../src/main/asr';
import { defaultAsrSettings, type AsrSettings, type AsrRequest, type AsrProgress } from '../src/shared/asr';

const vault = {
  encrypt: (value: string) => `encrypted:${Buffer.from(value).toString('base64')}`,
  decrypt: (value: string) => {
    if (!value.startsWith('encrypted:')) throw new Error('private vault error');
    return Buffer.from(value.slice(10), 'base64').toString();
  },
};
const settings = (patch: Partial<AsrSettings> = {}): AsrSettings => ({ ...defaultAsrSettings, ...patch });
const segments = (text = 'Hello') => ({ segments: [{ start: 0, end: 1, text }] });

async function fixture(action: (context: {
  service: AsrService; file: string; media: string; progress: AsrProgress[]; outputs: string[];
  setSize: (size: number) => void; setHold: (value: boolean) => void;
}) => Promise<void>): Promise<void> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lingvoice-asr-test-'));
  const outputs: string[] = [];
  const progress: AsrProgress[] = [];
  let size = 32000;
  let hold = false;
  const fakeSpawn = ((executable: string, args: string[], options: { shell: boolean; stdio: string }) => {
    assert.equal(executable, 'test-ffmpeg');
    assert.equal(options.shell, false);
    assert.equal(options.stdio, 'ignore');
    assert.equal(args[args.indexOf('-protocol_whitelist') + 1], 'file,pipe');
    assert.equal(args[args.indexOf('-t') + 1], '21601');
    assert.equal(args[args.indexOf('-ac') + 1], '1');
    assert.equal(args[args.indexOf('-ar') + 1], '16000');
    assert.equal(args[args.indexOf('-f') + 1], 's16le');
    const output = args.at(-1)!;
    outputs.push(output);
    const child = new EventEmitter() as EventEmitter & { kill: () => boolean };
    let killed = false;
    child.kill = () => { killed = true; queueMicrotask(() => child.emit('close', null)); return true; };
    if (!hold) void (async () => {
      const handle = await fs.open(output, 'w');
      try { await handle.truncate(size); } finally { await handle.close(); }
      if (!killed) child.emit('close', 0);
    })().catch(error => child.emit('error', error));
    return child;
  }) as unknown as typeof spawn;
  try {
    const file = path.join(directory, 'asr.json');
    const media = path.join(directory, 'media with spaces.mp4');
    await fs.writeFile(media, 'local media fixture');
    const service = new AsrService(file, vault, 'test-ffmpeg', value => progress.push(value), { spawn: fakeSpawn });
    await action({ service, file, media, progress, outputs, setSize: value => { size = value; }, setHold: value => { hold = value; } });
  } finally {
    for (const output of outputs) assert.equal(await fs.stat(path.dirname(output)).then(() => true, () => false), false, 'temporary extraction directory was removed');
    await fs.rm(directory, { recursive: true, force: true });
  }
}
function mockFetch(t: TestContext, callback: (url: string, init: RequestInit) => unknown | Promise<unknown>): void {
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request, init: RequestInit) => Response.json(await callback(String(url), init)));
}

test('ASR config copies defaults and encrypts, retains, reloads and clears credentials', async () => {
  await fixture(async ({ service, file }) => {
    const initial = await service.getConfig();
    assert.deepEqual(initial, { settings: defaultAsrSettings, hasApiKey: false });
    initial.settings.model = 'mutated';
    assert.equal((await service.getConfig()).settings.model, 'whisper-1');
    const saved = await service.saveConfig({ settings: settings(), apiKey: 'private-api-key' });
    assert.deepEqual(saved, { settings: defaultAsrSettings, hasApiKey: true });
    const disk = await fs.readFile(file, 'utf8');
    assert.ok(!disk.includes('private-api-key'));
    assert.ok(disk.includes('encrypted:'));
    const reload = new AsrService(file, vault, '', () => {});
    assert.deepEqual(await reload.getConfig(), saved);
    assert.equal((await reload.saveConfig({ settings: settings({ model: 'new' }) })).hasApiKey, true);
    assert.equal((await reload.saveConfig({ settings: settings(), apiKey: '' })).hasApiKey, false);
  });
});

test('config updates serialize and failed atomic saves preserve committed state', async () => {
  await fixture(async ({ service, file }) => {
    await Promise.all([
      service.saveConfig({ settings: settings({ model: 'first' }), apiKey: 'private' }),
      service.saveConfig({ settings: settings({ model: 'last' }) }),
    ]);
    const committed = await service.getConfig();
    assert.equal(committed.settings.model, 'last');
    assert.equal(committed.hasApiKey, true);
    await fs.rm(file); await fs.mkdir(file);
    await assert.rejects(service.saveConfig({ settings: settings({ model: 'failed' }), apiKey: '' }), /Unable to save/);
    assert.deepEqual(await service.getConfig(), committed);
    assert.deepEqual((await fs.readdir(path.dirname(file))).filter(name => name.endsWith('.tmp')), []);
  });
});

test('corrupt configuration and vault failures produce sanitized errors', async () => {
  await fixture(async ({ file, media }) => {
    await fs.writeFile(file, '{private invalid JSON');
    const service = new AsrService(file, vault, '', () => {});
    await assert.rejects(service.getConfig(), /Invalid saved ASR configuration/);
    await fs.rm(file);
    const broken = new AsrService(file, {
      encrypt() { throw new Error('private-api-key'); }, decrypt: vault.decrypt,
    }, '', () => {});
    await assert.rejects(broken.saveConfig({ settings: settings(), apiKey: 'private-api-key' }), /Unable to securely store/);
    assert.equal((await broken.getConfig()).hasApiKey, false);
    await fs.writeFile(file, JSON.stringify({ settings: settings(), apiKey: 'bad ciphertext' }));
    const reload = new AsrService(file, vault, '', () => {});
    await assert.rejects(reload.transcribe({ file: media }), /Unable to decrypt/);
    assert.equal(reload.busy, false);
  });
});

test('FFmpeg launch and exit errors are sanitized and release the busy lock', async () => {
  await fixture(async ({ file, media }) => {
    for (const mode of ['throw', 'error', 'close']) {
      const service = new AsrService(file, vault, '', () => {}, { spawn: (() => {
        if (mode === 'throw') throw new Error('private process details');
        const child = new EventEmitter();
        queueMicrotask(() => {
          if (mode === 'error') child.emit('error', new Error('private process details'));
          child.emit('close', 1);
        });
        return child;
      }) as unknown as typeof spawn });
      await assert.rejects(service.transcribe({ file: media }), error => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /FFmpeg/);
        assert.ok(!error.message.includes('private process details'));
        return true;
      });
      assert.equal(service.busy, false);
    }
  });
});

test('endpoint supports base URLs, proxy prefixes, versions, queries and explicit full URLs', () => {
  for (const [baseUrl, fullUrl, expected] of [
    ['https://example.com', false, 'https://example.com/v1/audio/transcriptions'],
    ['https://example.com/v1/', false, 'https://example.com/v1/audio/transcriptions'],
    ['https://example.com/proxy', false, 'https://example.com/proxy/v1/audio/transcriptions'],
    ['https://example.com/proxy/v2?api-version=1', false, 'https://example.com/proxy/v2/audio/transcriptions?api-version=1'],
    ['http://localhost:1234/custom?version=x', true, 'http://localhost:1234/custom?version=x'],
  ] as const) assert.equal(asrEndpoint(settings({ baseUrl, fullUrl })), expected);
  for (const baseUrl of ['file:///tmp/a', 'ftp://example.com', 'https://user:key@example.com', 'https://example.com/#', 'not-url']) {
    assert.throws(() => asrEndpoint(settings({ baseUrl })), /Invalid/);
  }
});

test('WAV wrapper includes correct PCM format and permits final partial chunks', () => {
  const pcm = new Uint8Array([1, 2, 3, 4]);
  const wav = Buffer.from(pcmWav(pcm));
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.readUInt32LE(4), 40);
  assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
  assert.equal(wav.readUInt16LE(20), 1);
  assert.equal(wav.readUInt16LE(22), 1);
  assert.equal(wav.readUInt32LE(24), 16000);
  assert.equal(wav.readUInt32LE(28), 32000);
  assert.equal(wav.readUInt16LE(34), 16);
  assert.equal(wav.readUInt32LE(40), 4);
  assert.deepEqual(wav.subarray(44), Buffer.from(pcm));
  for (const size of [0, 1, 9600002]) assert.throws(() => pcmWav(new Uint8Array(size)), /Invalid/);
});

test('timestamps sort, offset, reindex, clamp tolerance and skip valid blank segments', () => {
  assert.deepEqual(parseAsrSegments({ segments: [
    { start: 1, end: 2.1, text: ' second ' }, { start: 0, end: 0.5, text: 'first' }, { start: 0.5, end: 1, text: '  ' },
  ] }, 2, 300), [
    { id: 1, start: 300, end: 300.5, text: 'first' }, { id: 2, start: 301, end: 302, text: 'second' },
  ]);
  assert.deepEqual(parseAsrSegments({ segments: [] }, 1), []);
});

test('timestamp parser rejects text-only and malformed data instead of fabricating timings', () => {
  for (const value of [null, { text: 'secret response body' }, { segments: null }]) assert.throws(() => parseAsrSegments(value, 1), /timestamped/);
  for (const patch of [
    { start: -1 }, { start: NaN }, { start: Infinity }, { start: '0' }, { start: 1 },
    { end: 0 }, { end: -1 }, { end: Infinity }, { end: NaN }, { end: 1.26 }, { text: 1 },
  ]) assert.throws(() => parseAsrSegments({ segments: [{ start: 0, end: 1, text: 'hello', ...patch }] }, 1), /invalid/);
  assert.throws(() => parseAsrSegments({ segments: Array(100001).fill({ start: 0, end: 1, text: 'hello' }) }, 1), /too many/);
});

test('multipart upload sends saved fields and WAV chunks with exact byte-based offsets', async t => {
  let calls = 0;
  mockFetch(t, async (url, init) => {
    assert.equal(url, 'https://example.com/v1/audio/transcriptions');
    assert.equal(init.redirect, 'error');
    assert.equal((init.headers as Record<string, string>).Authorization, 'Bearer private-api-key');
    assert.ok(init.signal);
    const form = init.body as FormData;
    assert.equal(form.get('model'), 'custom-whisper');
    assert.equal(form.get('language'), 'zh');
    assert.equal(form.get('prompt'), 'Names');
    assert.equal(form.get('response_format'), 'verbose_json');
    assert.deepEqual(form.getAll('timestamp_granularities[]'), ['segment']);
    const audio = form.get('file') as File;
    assert.equal(audio.type, 'audio/wav');
    assert.equal(audio.name, 'audio.wav');
    assert.equal(audio.size, (calls === 0 ? 9600000 : 48000) + 44);
    const header = Buffer.from(await audio.arrayBuffer());
    assert.equal(header.readUInt32LE(40), audio.size - 44);
    calls++;
    return { segments: [{ start: 0.25, end: 1.25, text: ` chunk ${calls} ` }] };
  });
  await fixture(async ({ service, media, progress, setSize }) => {
    setSize(9600000 + 48000);
    await service.saveConfig({ settings: settings({ baseUrl: 'https://example.com/v1', model: 'custom-whisper', language: 'zh', prompt: 'Names' }), apiKey: 'private-api-key' });
    assert.deepEqual(await service.transcribe({ file: media }), [
      { id: 1, start: 0.25, end: 1.25, text: 'chunk 1' }, { id: 2, start: 300.25, end: 301.25, text: 'chunk 2' },
    ]);
    assert.equal(service.busy, false);
    assert.deepEqual(progress.at(-1), { stage: 'transcribing', completed: 2, total: 2 });
  });
  assert.equal(calls, 2);
});

test('automatic language and empty prompt are omitted, valid silence gives explicit no-speech error', async t => {
  mockFetch(t, (_url, init) => {
    const form = init.body as FormData;
    assert.equal(form.has('language'), false); assert.equal(form.has('prompt'), false);
    assert.equal((init.headers as Record<string, string>).Authorization, undefined);
    return { segments: [] };
  });
  await fixture(async ({ service, media }) => {
    await assert.rejects(service.transcribe({ file: media }), /No speech found/);
    assert.equal(service.busy, false);
  });
});

test('runtime path and configuration validation blocks unsafe requests before extraction or network', async t => {
  mockFetch(t, () => assert.fail('unexpected network access'));
  await fixture(async ({ service, media, outputs }) => {
    for (const request of [null, {}, { file: 1 }, { file: 'relative.mp4' }, { file: 'https://example.com/media' }, { file: 'file:///tmp/test' }, { file: '\\\\server\\share\\a.mp4' }, { file: media, settings: {} }, { file: path.dirname(media) }, { file: `${media}.missing` }]) {
      await assert.rejects(service.transcribe(request as AsrRequest));
      assert.equal(service.busy, false);
    }
    assert.equal(outputs.length, 0);
    for (const patch of [{ model: '' }, { fullUrl: 'true' }, { language: 1 }, { prompt: 'x'.repeat(10001) }, { baseUrl: 'file:///a' }]) {
      await assert.rejects(service.saveConfig({ settings: settings(patch as Partial<AsrSettings>) }), /Invalid/);
    }
    await assert.rejects(service.saveConfig({ settings: settings(), apiKey: 3 as unknown as string }), /Invalid/);
  });
});

test('busy spans extraction and cancellation kills FFmpeg, cleans up and permits another run', async t => {
  mockFetch(t, () => segments());
  await fixture(async ({ service, media, outputs, setHold }) => {
    setHold(true);
    const operation = service.transcribe({ file: media });
    assert.equal(service.busy, true);
    await assert.rejects(service.transcribe({ file: media }), /already busy/);
    while (!outputs.length) await new Promise(resolve => setImmediate(resolve));
    service.cancel();
    await assert.rejects(operation, /cancelled/);
    assert.equal(service.busy, false);
    setHold(false);
    assert.equal((await service.transcribe({ file: media }))[0].text, 'Hello');
  });
});

test('upload cancellation aborts fetch and stops future chunks with cleanup', async t => {
  let ready!: () => void;
  const started = new Promise<void>(resolve => { ready = resolve; });
  let calls = 0;
  t.mock.method(globalThis, 'fetch', (_url: unknown, init: RequestInit) => new Promise((_resolve, reject) => {
    calls++;
    init.signal!.addEventListener('abort', () => reject(new Error('private abort details')), { once: true });
    ready();
  }));
  await fixture(async ({ service, media, setSize }) => {
    setSize(9600000 + 32000);
    const operation = service.transcribe({ file: media });
    await started;
    service.cancel();
    await assert.rejects(operation, /cancelled/);
    assert.equal(calls, 1); assert.equal(service.busy, false);
  });
});

test('per-upload timeout aborts pending network requests', async t => {
  let ready!: () => void;
  const started = new Promise<void>(resolve => { ready = resolve; });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.method(globalThis, 'fetch', (_url: unknown, init: RequestInit) => new Promise((_resolve, reject) => {
    init.signal!.addEventListener('abort', () => reject(new Error('private details')), { once: true });
    ready();
  }));
  await fixture(async ({ service, media }) => {
    const operation = service.transcribe({ file: media });
    await started;
    t.mock.timers.tick(180000);
    await assert.rejects(operation, /upload timed out/);
    assert.equal(service.busy, false);
  });
  t.mock.timers.reset();
});

test('extraction timeout kills pending FFmpeg and cleans up', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await fixture(async ({ service, media, outputs, setHold }) => {
    setHold(true);
    const operation = service.transcribe({ file: media });
    while (!outputs.length) await new Promise(resolve => setImmediate(resolve));
    t.mock.timers.tick(30 * 60 * 1000);
    await assert.rejects(operation, /extraction timed out/);
    assert.equal(service.busy, false);
  });
  t.mock.timers.reset();
});

test('over-six-hour and invalid PCM extraction are rejected before upload', async t => {
  mockFetch(t, () => assert.fail('unexpected upload'));
  await fixture(async ({ service, media, setSize }) => {
    for (const [size, message] of [[21600 * 32000 + 2, /six-hour/], [0, /No speech/], [1, /invalid PCM/]] as const) {
      setSize(size);
      await assert.rejects(service.transcribe({ file: media }), message);
      assert.equal(service.busy, false);
    }
  });
});

test('provider failures, bounded responses and invalid JSON never reveal bodies or credentials', async t => {
  let kind = '';
  t.mock.method(globalThis, 'fetch', async () => {
    if (kind === 'network') throw new Error('private-api-key private-body');
    if (kind === 'http') return new Response('private-api-key private-body', { status: 401 });
    if (kind === 'declared') return new Response('private-body', { headers: { 'content-length': '4000001' } });
    if (kind === 'stream') return new Response('x'.repeat(4000001));
    return new Response('private-api-key private-body');
  });
  await fixture(async ({ service, media }) => {
    await service.saveConfig({ settings: settings(), apiKey: 'private-api-key' });
    for (kind of ['network', 'http', 'declared', 'stream', 'json']) {
      await assert.rejects(service.transcribe({ file: media }), error => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /provider request failed/);
        assert.ok(!error.message.includes('private-api-key') && !error.message.includes('private-body'));
        assert.equal(error.cause, undefined);
        return true;
      });
      assert.equal(service.busy, false);
    }
  });
});

test('invalid timestamp response stops later chunks and cleans up', async t => {
  let calls = 0;
  mockFetch(t, () => { calls++; return { text: 'private-body' }; });
  await fixture(async ({ service, media, setSize }) => {
    setSize(9600000 + 32000);
    await assert.rejects(service.transcribe({ file: media }), /timestamped segments/);
    assert.equal(calls, 1);
  });
});
