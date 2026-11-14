import { test, type TestContext } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { EventEmitter } from 'node:events';
import type { spawn } from 'node:child_process';
import { AsrService, asrEndpoint, pcmWav, parseAsrSegments, gateNonVoicedPcm } from '../src/main/asr';
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
    assert.equal((await service.getConfig()).settings.model, 'qwen-audio-3.1-asr-flash');
    assert.equal(initial.settings.baseUrl, 'https://dashscope.aliyuncs.com/compatible-mode/v1');
    assert.equal(initial.settings.fullUrl, false);
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

test('legacy ASR fullUrl remains readable but is always persisted as false', async () => {
  await fixture(async ({ service, file }) => {
    const saved = await service.saveConfig({ settings: settings({ baseUrl: 'https://example.com/v1/audio/transcriptions', fullUrl: true }) });
    assert.equal(saved.settings.fullUrl, false);
    assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).settings.fullUrl, false);
    const reloaded = new AsrService(file, vault, '', () => {});
    assert.equal((await reloaded.getConfig()).settings.fullUrl, false);
    assert.equal(asrEndpoint((await reloaded.getConfig()).settings), 'https://example.com/v1/chat/completions');
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

test('endpoint supports compatible chat URLs, proxy prefixes, versions, queries and legacy transcription URLs', () => {
  for (const [baseUrl, fullUrl, expected] of [
    ['https://example.com', false, 'https://example.com/compatible-mode/v1/chat/completions'],
    ['https://example.com/v1/', false, 'https://example.com/v1/chat/completions'],
    ['https://example.com/proxy', false, 'https://example.com/proxy/compatible-mode/v1/chat/completions'],
    ['https://example.com/proxy/v2?api-version=1', false, 'https://example.com/proxy/v2/chat/completions?api-version=1'],
    ['https://example.com/v1/audio/transcriptions?version=x', true, 'https://example.com/v1/chat/completions?version=x'],
    ['https://example.com/proxy/v2/audio/transcriptions', false, 'https://example.com/proxy/v2/chat/completions'],
    ['https://example.com/compatible-mode/v1', true, 'https://example.com/compatible-mode/v1/chat/completions'],
    ['https://example.com/v1/chat/completions', true, 'https://example.com/v1/chat/completions'],
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

test('JSON chat upload sends saved fields and WAV chunks with exact byte-based offsets', async t => {
  let calls = 0;
  mockFetch(t, async (url, init) => {
    assert.equal(url, 'https://example.com/v1/chat/completions');
    assert.equal(init.redirect, 'error');
    assert.deepEqual(init.headers, { 'Content-Type': 'application/json', Authorization: 'Bearer private-api-key' });
    assert.ok(init.signal);
    const body = JSON.parse(init.body as string);
    const audio = body.messages[1].content[0];
    assert.equal(audio.type, 'input_audio');
    assert.match(audio.input_audio.data, /^data:audio\/wav;base64,/);
    const wav = Buffer.from(audio.input_audio.data.split(',')[1], 'base64');
    assert.deepEqual(body, {
      model: 'custom-asr',
      messages: [
        { role: 'system', content: 'Names' },
        { role: 'user', content: [{ type: 'input_audio', input_audio: { data: `data:audio/wav;base64,${wav.toString('base64')}` } }] },
      ],
      stream: false,
      asr_options: { enable_itn: false, language: 'zh' },
    });
    assert.equal(wav.length, (calls === 0 ? 9600000 : 48000) + 44);
    assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
    assert.equal(wav.readUInt32LE(40), wav.length - 44);
    calls++;
    return { segments: [{ start: 0.25, end: 1.25, text: ` chunk ${calls} ` }] };
  });
  await fixture(async ({ service, media, progress, setSize }) => {
    setSize(9600000 + 48000);
    await service.saveConfig({ settings: settings({ baseUrl: 'https://example.com/v1', model: 'custom-asr', language: 'zh', prompt: 'Names' }), apiKey: 'private-api-key' });
    assert.deepEqual(await service.transcribe({ file: media }), [
      { id: 1, start: 0.25, end: 1.25, text: 'chunk 1' }, { id: 2, start: 300.25, end: 301.25, text: 'chunk 2' },
    ]);
    assert.equal(service.busy, false);
    assert.deepEqual(progress.at(-1), { stage: 'transcribing', completed: 2, total: 2 });
  });
  assert.equal(calls, 2);
});

test('saved Qwen 3.1 model survives reload, connection test and transcription without falling back to the default model', async t => {
  await fixture(async ({ service, file, media }) => {
    await service.saveConfig({ settings: settings({ model: 'qwen-audio-3.1-asr-flash' }) });
    const reloaded = new AsrService(file, vault, '', () => {});
    assert.equal((await reloaded.getConfig()).settings.model, 'qwen-audio-3.1-asr-flash');
    let calls = 0;
    mockFetch(t, (_url, init) => {
      calls++;
      assert.equal(JSON.parse(init.body as string).model, 'qwen-audio-3.1-asr-flash');
      return segments();
    });
    await reloaded.test();
    await service.transcribe({ file: media });
    assert.equal(calls, 2);
  });
});

test('DashScope native endpoint retry preserves the selected Qwen 3.1 model', async t => {
  await fixture(async ({ service, media }) => {
    await service.saveConfig({ settings: settings({ model: 'qwen-audio-3.1-asr-flash' }) });
    const urls: string[] = [];
    t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
      urls.push(String(url));
      const body = JSON.parse(init.body as string);
      assert.equal(body.model, 'qwen-audio-3.1-asr-flash');
      if (urls.length % 2 === 1) return new Response('', { status: 400 });
      assert.ok(Array.isArray(body.input.messages));
      return Response.json(segments());
    });
    await service.test();
    await service.transcribe({ file: media });
    assert.deepEqual(urls, [
      'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
      'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation',
      'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
      'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation',
    ]);
  });
});

test('automatic language and empty prompt are omitted, valid silence gives explicit no-speech error', async t => {
  mockFetch(t, (_url, init) => {
    const body = JSON.parse(init.body as string);
    assert.deepEqual(body.asr_options, { enable_itn: false });
    assert.equal(body.messages.length, 1);
    assert.equal(body.messages[0].role, 'user');
    assert.equal(body.stream, false);
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

test('ASR distinguishes safe transport causes and malformed JSON without disclosing raw exceptions', async t => {
  let code = '';
  t.mock.method(globalThis, 'fetch', async () => {
    if (code === 'json') return new Response('private-response-not-json');
    throw new TypeError('private-url-with-api-key', { cause: Object.assign(new Error('private-provider-message'), { code }) });
  });
  await fixture(async ({ service }) => {
    await service.saveConfig({ settings: settings(), apiKey: 'private-api-key' });
    for (const [next, expected] of [
      ['ENOTFOUND', /DNS lookup failed/], ['EAI_AGAIN', /DNS lookup failed/],
      ['ECONNREFUSED', /Connection refused/], ['ECONNRESET', /Connection interrupted/],
      ['UND_ERR_CONNECT_TIMEOUT', /timed out/], ['UND_ERR_BODY_TIMEOUT', /timed out/],
      ['CERT_HAS_EXPIRED', /TLS certificate verification failed/],
      ['PRIVATE_UNKNOWN_CODE', /without usable HTTP error details/], ['json', /invalid or incomplete JSON/],
    ] as const) {
      code = next;
      await assert.rejects(service.test(), error => {
        assert.ok(error instanceof Error);
        assert.match(error.message, expected);
        assert.ok(!error.message.includes('private-') && !error.message.includes('PRIVATE_UNKNOWN_CODE'));
        assert.equal(error.cause, undefined);
        return true;
      });
    }
  });
});

test('ASR exposes structured provider errors with credentials redacted', async t => {
  let payload: unknown;
  t.mock.method(globalThis, 'fetch', async () => Response.json(payload, { status: 400 }));
  await fixture(async ({ service }) => {
    await service.saveConfig({ settings: settings(), apiKey: 'private-api-key' });
    for (payload of [
      { Code: 'InvalidParameter', Message: 'Invalid audio private-api-key Bearer secret-token' },
      { code: 'InvalidParameter', message: 'Invalid audio private-api-key Bearer secret-token' },
      { error: { code: 'InvalidParameter', message: 'Invalid audio private-api-key Bearer secret-token' } },
    ]) {
      await assert.rejects(service.test(), error => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /HTTP 400.*InvalidParameter.*Invalid audio/);
        assert.ok(!error.message.includes('private-api-key'));
        assert.ok(!error.message.includes('secret-token'));
        return true;
      });
    }
    payload = { Code: 'InvalidModel' };
    await assert.rejects(service.test(), /HTTP 400.*InvalidModel/);
  });
});

test('Qwen no-speech rejection passes connection test but produces no invented subtitles', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ Code: 'CLIENT_ERROR', Message: 'ASR_RESPONSE_HAVE_NO_WORDS' }, { status: 400 }));
  await fixture(async ({ service, media }) => {
    await service.saveConfig({ settings: settings(), apiKey: 'key' });
    await service.test();
    await assert.rejects(service.transcribe({ file: media }), /No speech found/);
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

test('service.test validates provider ASR endpoint and catches 404 with helpful guidance', async t => {
  mockFetch(t, () => segments());
  await fixture(async ({ service }) => {
    await service.saveConfig({ settings: settings({ providerId: 'test-prov' }), apiKey: 'test-key' });
    await service.test();
  });

  t.mock.method(globalThis, 'fetch', async () => new Response('Not Found', { status: 404 }));
  await fixture(async ({ service }) => {
    await service.saveConfig({ settings: settings({ providerId: 'test-prov' }), apiKey: 'test-key' });
    await assert.rejects(service.test(), /HTTP 404 Not Found/);
  });
});

test('service.test and transcribe work with custom Base URL without a providerId', async t => {
  let requestedUrl = '';
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request) => {
    requestedUrl = String(url);
    return Response.json(segments('Custom ASR'));
  });
  await fixture(async ({ service, media }) => {
    await service.saveConfig({
      settings: settings({ providerId: '', baseUrl: 'https://custom-asr.example/v1', model: 'custom-asr' }),
      apiKey: 'custom-secret',
    });
    await service.test();
    assert.equal(requestedUrl, 'https://custom-asr.example/v1/chat/completions');

    const cues = await service.transcribe({ file: media });
    assert.equal(cues[0].text, 'Custom ASR');
  });
});

test('proportional ASR segments align to voiced PCM windows and filter out BGM hallucinations', () => {
  // 10s buffer at 16 kHz mono 16-bit PCM: 0..3s silence/BGM, 3..7s speech, 7..10s silence/BGM
  const duration = 10;
  const samples = duration * 16000;
  const pcm = new Uint8Array(samples * 2);
  const view = new DataView(pcm.buffer);
  for (let i = 3 * 16000; i < 7 * 16000; i++) {
    view.setInt16(i * 2, Math.round(Math.sin(i * 2 * Math.PI * 300 / 16000) * 8000), true);
  }
  const parsed = {
    _proportional: true,
    segments: [
      { start: 0, end: 0.5, text: '♪ [音乐] 第一句台词' },
      { start: 0.5, end: 1.0, text: '第二句台词 (Music)' },
    ],
  };
  const cues = parseAsrSegments(parsed, duration, 0, pcm);
  assert.equal(cues.length, 2);
  assert.equal(cues[0].text, '第一句台词');
  assert.equal(cues[1].text, '第二句台词');
  assert.ok(cues[0].start >= 2.8, `expected speech start >= 2.8s, got ${cues[0].start}`);
  assert.ok(cues[1].end <= 7.2, `expected speech end <= 7.2s, got ${cues[1].end}`);

  // Verify VAD gating attenuates BGM in non-voiced intervals (e.g. at 1.0s) while preserving speech at 5.0s
  for (let i = 0; i < 2 * 16000; i++) {
    view.setInt16(i * 2, 400, true); // Low-level BGM floor in 0..2s
  }
  const gated = gateNonVoicedPcm(pcm, duration);
  const gatedView = new DataView(gated.buffer, gated.byteOffset, gated.byteLength);
  assert.ok(Math.abs(gatedView.getInt16(16000 * 2, true)) <= 15, 'non-voiced BGM interval should be attenuated');
  assert.equal(gatedView.getInt16(5 * 16000 * 2 + 20, true), view.getInt16(5 * 16000 * 2 + 20, true), 'active speech interval should remain intact');
});


