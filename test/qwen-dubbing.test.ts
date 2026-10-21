import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import https from 'node:https';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { QwenDubbingClient, QWEN_DUBBING_MODEL, type QwenDubbingOptions, type QwenVoice } from '../src/main/qwen-dubbing';

const baseUrl = 'https://workspace-123.ap-southeast-1.maas.aliyuncs.com/api/v1';
const key = 'private-test-secret';
const id = `${QWEN_DUBBING_MODEL}-lingvoice-abc123`;
const signedUrl = 'https://dashscope-result.oss-ap-southeast-1.aliyuncs.com/audio.wav?Signature=private-signed-token';
function pcm(seconds = 5, rate = 16000, channels = 1): Buffer {
  const bytes = seconds * rate * channels * 2;
  const data = Buffer.alloc(44 + bytes);
  data.write('RIFF', 0); data.writeUInt32LE(data.length - 8, 4); data.write('WAVEfmt ', 8);
  data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(channels, 22);
  data.writeUInt32LE(rate, 24); data.writeUInt32LE(rate * channels * 2, 28);
  data.writeUInt16LE(channels * 2, 32); data.writeUInt16LE(16, 34);
  data.write('data', 36); data.writeUInt32LE(bytes, 40);
  return data;
}
function json(output: unknown): Response { return Response.json({ output }); }
type Handler = (url: string, init: RequestInit) => Response | Promise<Response>;
function client(handler: Handler, options: QwenDubbingOptions = {}, base = baseUrl): QwenDubbingClient {
  return new QwenDubbingClient({ baseUrl: base, apiKey: key }, {
    fetch: (async (url, init) => handler(String(url), init!)) as typeof fetch,
    resolveHost: async () => ['8.8.8.8'], pollIntervalMs: 1, ...options,
  });
}
function input(init: RequestInit): Record<string, unknown> {
  const body = JSON.parse(init.body as string);
  assert.equal(body.model, 'voice-enrollment');
  return body.input;
}
async function temporary(action: (file: string, directory: string) => Promise<void>): Promise<void> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-dubbing-'));
  try { await action(path.join(directory, 'out.wav'), directory); }
  finally { await fs.rm(directory, { recursive: true, force: true }); }
}
function safeError(error: unknown): boolean {
  return error instanceof Error && !error.message.includes(key) && !error.message.includes('private-signed-token') && /Qwen dubbing/.test(error.message);
}

test('Qwen constructor is offline, fixes the exact model and preserves supported endpoint regions', () => {
  for (const [base, region] of [
    [baseUrl, 'ap-southeast-1'],
    ['https://test.cn-beijing.maas.aliyuncs.com/api/v1/', 'cn-beijing'],
    ['https://dashscope.aliyuncs.com/api/v1', 'cn-beijing'],
    ['https://dashscope-intl.aliyuncs.com/api/v1', 'ap-southeast-1'],
  ]) {
    const service = client(() => { throw new Error('Unexpected I/O'); }, {}, base);
    assert.equal(service.region, region);
  }
  assert.equal(QWEN_DUBBING_MODEL, 'qwen-audio-3.1-tts-plus');
  const service30 = new QwenDubbingClient({ baseUrl, apiKey: key, model: 'qwen-audio-3.0-tts-plus' });
  assert.equal(service30.model, 'qwen-audio-3.0-tts-plus');
  assert.throws(() => new QwenDubbingClient({ baseUrl, apiKey: key, model: 'invalid' as any }), /Unsupported/);
  for (const base of [
    'http://dashscope.aliyuncs.com/api/v1', 'https://evil.example/api/v1',
    'https://dashscope.aliyuncs.com.evil.example/api/v1', 'https://127.0.0.1/api/v1',
    'https://u:p@dashscope.aliyuncs.com/api/v1', 'https://dashscope.aliyuncs.com:444/api/v1',
    'https://dashscope.aliyuncs.com/api/v1?key=secret', 'https://dashscope.aliyuncs.com/api/v1#x',
    'https://dashscope.aliyuncs.com/api/v1#', 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    'https://test.us-east-1.maas.aliyuncs.com/api/v1', 'https://a.b.cn-beijing.maas.aliyuncs.com/api/v1',
  ]) assert.throws(() => client(() => json({}), {}, base));
  for (const value of ['', 'a\nb', 'a b', 'x'.repeat(4097)]) {
    assert.throws(() => new QwenDubbingClient({ baseUrl, apiKey: value }));
  }
  for (const options of [{ timeoutMs: 0 }, { timeoutMs: 300001 }, { timeoutMs: NaN }, { pollIntervalMs: 0 }, { pollIntervalMs: 10001 }]) {
    assert.throws(() => client(() => json({}), options));
  }
});

test('Qwen native HTTPS transport pins checked DNS addresses and preserves hostname and TLS defaults', async t => {
  let requests = 0;
  t.mock.method(https, 'request', ((url: URL, options: https.RequestOptions, respond: (response: unknown) => void) => {
    requests++;
    assert.equal(url.hostname, 'workspace-123.ap-southeast-1.maas.aliyuncs.com');
    assert.equal(options.agent, false);
    assert.equal(options.rejectUnauthorized, undefined);
    assert.equal(options.checkServerIdentity, undefined);
    assert.equal(options.signal?.aborted, false);
    assert.equal((options.headers as Record<string, string>).authorization, `Bearer ${key}`);
    options.lookup!('ignored-hostname', {}, (error, address, family) => {
      assert.equal(error, null); assert.equal(address, '8.8.8.8'); assert.equal(family, 4);
    });
    options.lookup!('ignored-hostname', { all: true }, (error, addresses) => {
      assert.equal(error, null); assert.deepEqual(addresses, [{ address: '8.8.8.8', family: 4 }]);
    });
    const request = new EventEmitter() as EventEmitter & { end: (body: string) => void };
    request.end = body => {
      assert.deepEqual(JSON.parse(body), { model: 'voice-enrollment', input: { action: 'query_voice', voice_id: id } });
      const response = Object.assign(Readable.from([Buffer.from(JSON.stringify({ output: { status: 'OK' } }))]), {
        statusCode: 200, headers: { 'content-type': 'application/json' },
      });
      respond(response);
    };
    return request;
  }) as typeof https.request);
  const service = new QwenDubbingClient({ baseUrl, apiKey: key }, { resolveHost: async () => ['8.8.8.8'] });
  assert.equal((await service.queryVoice(id)).status, 'OK');
  assert.equal(requests, 1);
});

test('Qwen enrollment uploads WAV data URI with exact protocol and polls DEPLOYING to OK', async () => {
  const audio = pcm();
  const actions: string[] = [];
  const service = client((url, init) => {
    assert.equal(url, `${baseUrl}/services/audio/tts/customization`);
    assert.equal(init.method, 'POST'); assert.equal(init.redirect, 'error');
    assert.equal((init.headers as Record<string, string>).Authorization, `Bearer ${key}`);
    assert.ok(init.signal instanceof AbortSignal);
    const body = input(init); actions.push(body.action as string);
    if (body.action === 'create_voice') {
      assert.deepEqual(body, { action: 'create_voice', target_model: QWEN_DUBBING_MODEL, prefix: 'lingvoice', audio: `data:audio/wav;base64,${audio.toString('base64')}` });
      return json({ voice_id: id });
    }
    assert.deepEqual(body, { action: 'query_voice', voice_id: id });
    return json({ status: actions.length === 2 ? 'DEPLOYING' : 'OK', target_model: QWEN_DUBBING_MODEL, extra: key });
  });
  assert.deepEqual(await service.createVoice(audio), { voiceId: id, model: QWEN_DUBBING_MODEL, status: 'OK' });
  assert.deepEqual(actions, ['create_voice', 'query_voice', 'query_voice']);
});

test('Qwen awaits the created-voice callback before the first query', async () => {
  const events: string[] = [];
  let entered!: () => void;
  const callbackEntered = new Promise<void>(resolve => { entered = resolve; });
  let release!: () => void;
  const persist = new Promise<void>(resolve => { release = resolve; });
  const service = client((_url, init) => {
    const action = input(init).action as string;
    events.push(action);
    return json(action === 'create_voice' ? { voice_id: id } : { status: 'OK' });
  });
  const pending = service.createVoice(pcm(), undefined, async voice => {
    assert.deepEqual(voice, { voiceId: id, model: QWEN_DUBBING_MODEL, status: 'DEPLOYING' });
    events.push('callback'); entered();
    await persist;
    events.push('persisted');
  });
  await callbackEntered;
  assert.deepEqual(events, ['create_voice', 'callback']);
  release();
  assert.equal((await pending).status, 'OK');
  assert.deepEqual(events, ['create_voice', 'callback', 'persisted', 'query_voice']);
});

test('Qwen hands off the created ID for persistence even when subsequent polling fails', async () => {
  await temporary(async file => {
    for (const status of ['UNDEPLOYED', 'FAILED']) {
      const service = client((_url, init) => json(input(init).action === 'create_voice' ? { voice_id: id } : { status }));
      await assert.rejects(service.createVoice(pcm(), undefined, async voice => {
        await fs.writeFile(file, JSON.stringify(voice));
      }), safeError);
      assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), { voiceId: id, model: QWEN_DUBBING_MODEL, status: 'DEPLOYING' });
    }
  });
});

test('Qwen retains the caller-persisted ID when polling is cancelled', async () => {
  await temporary(async file => {
    const controller = new AbortController();
    let queried!: () => void;
    const queryStarted = new Promise<void>(resolve => { queried = resolve; });
    const service = client((_url, init) => {
      if (input(init).action === 'create_voice') return json({ voice_id: id });
      queried();
      return new Promise<Response>(() => {});
    });
    const pending = service.createVoice(pcm(), controller.signal, async voice => {
      await fs.writeFile(file, JSON.stringify(voice));
    });
    const rejected = assert.rejects(pending, /cancelled/);
    await queryStarted;
    controller.abort(); await rejected;
    assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), { voiceId: id, model: QWEN_DUBBING_MODEL, status: 'DEPLOYING' });
  });
});

test('Qwen callback failure stops enrollment before any query or synthesis', async () => {
  let calls = 0;
  let received: QwenVoice | undefined;
  const service = client(() => { calls++; return json({ voice_id: id }); });
  await assert.rejects(service.createVoice(pcm(), undefined, async voice => {
    received = voice;
    throw new Error(`Persistence failed: ${key}`);
  }), safeError);
  assert.deepEqual(received, { voiceId: id, model: QWEN_DUBBING_MODEL, status: 'DEPLOYING' });
  assert.equal(calls, 1);
});

test('Qwen cancellation while persisting prevents polling after the callback completes', async () => {
  const controller = new AbortController();
  let received: QwenVoice | undefined;
  let calls = 0;
  const service = client(() => { calls++; return json({ voice_id: id }); });
  await assert.rejects(service.createVoice(pcm(), controller.signal, async voice => {
    received = voice;
    controller.abort();
    await Promise.resolve();
  }), /cancelled/);
  assert.equal(received?.voiceId, id);
  assert.equal(calls, 1);
});

test('Qwen rejects invalid created IDs before invoking the persistence callback', async () => {
  let invoked = false;
  await assert.rejects(client(() => json({ voice_id: 'foreign-model-voice' })).createVoice(pcm(), undefined, async () => {
    invoked = true;
  }), safeError);
  assert.equal(invoked, false);
});

test('Qwen enrollment accepts bounded local files and 5/60-second 16-bit PCM boundaries', async () => {
  await temporary(async (_file, directory) => {
    let creates = 0;
    const service = client((_url, init) => {
      if (input(init).action === 'create_voice') { creates++; return json({ voice_id: id }); }
      return json({ status: 'OK' });
    });
    const file = path.join(directory, 'reference.wav');
    await fs.writeFile(file, pcm());
    await service.createVoice(file);
    await service.createVoice(pcm(60));
    await service.createVoice(pcm(5, 48000, 2));
    assert.equal(creates, 3);
    await assert.rejects(service.createVoice(directory), safeError);
    await assert.rejects(service.createVoice(path.join(directory, 'missing')), safeError);
    const large = await fs.open(file, 'w');
    await large.truncate(10 * 1024 * 1024 + 1); await large.close();
    await assert.rejects(service.createVoice(file), safeError);
    assert.equal(creates, 3);
  });
});

test('Qwen rejects malformed, short, long, low-rate, non-PCM, oversized reference WAV before fetch', async () => {
  const invalid: Buffer[] = [Buffer.alloc(0), Buffer.from('not audio'), pcm(4), pcm(61), pcm(5, 8000), Buffer.alloc(10 * 1024 * 1024 + 1)];
  for (const mutate of [
    (b: Buffer) => b.writeUInt16LE(3, 20),
    (b: Buffer) => b.writeUInt16LE(8, 34),
    (b: Buffer) => b.writeUInt32LE(12, 28),
    (b: Buffer) => b.writeUInt32LE(99999999, 40),
    (b: Buffer) => b.writeUInt32LE(1, 4),
    (b: Buffer) => b.writeUInt16LE(4, 32),
    (b: Buffer) => b.writeUInt16LE(0, 22),
  ]) { const b = pcm(); mutate(b); invalid.push(b); }
  const service = client(() => { assert.fail('Invalid reference must not be uploaded'); });
  for (const buffer of invalid) await assert.rejects(service.createVoice(buffer), safeError);
});

test('Qwen enrollment exits on failed/unknown statuses and rejects foreign model IDs', async () => {
  for (const status of ['UNDEPLOYED', 'FAILED', '', 'ok', ['OK'], { status: 'OK' }, null]) {
    let calls = 0;
    const service = client((_url, init) => {
      calls++;
      return json(input(init).action === 'create_voice' ? { voice_id: id } : { status });
    });
    await assert.rejects(service.createVoice(pcm()), safeError);
    assert.equal(calls, 2);
  }
  for (const other of ['cosyvoice-v3-abc', 'qwen-audio-3.1-tts-flash-abc', `${QWEN_DUBBING_MODEL}-`, `${id}\n`, 'x'.repeat(257)]) {
    const service = client(() => { assert.fail('Foreign model ID must not be sent'); });
    await assert.rejects(service.queryVoice(other), safeError);
    await assert.rejects(service.deleteVoice(other), safeError);
    await assert.rejects(service.synthesize('hello', other, 'unused.wav'), safeError);
    await assert.rejects(client(() => json({ voice_id: other })).createVoice(pcm()), safeError);
  }
  const service = client(() => json({ status: 'OK', target_model: 'qwen-audio-3.1-tts-flash' }));
  await assert.rejects(service.queryVoice(id), safeError);
});

test('Qwen official query and delete use voice_id and return bounded projections only', async () => {
  const actions: string[] = [];
  const service = client((_url, init) => {
    const body = input(init); actions.push(body.action as string);
    assert.deepEqual(body, { action: body.action, voice_id: id });
    return json(body.action === 'delete_voice' ? {} : { status: 'UNDEPLOYED', target_model: QWEN_DUBBING_MODEL, resource_link: signedUrl, extra: key });
  });
  assert.deepEqual(await service.queryVoice(id), { voiceId: id, model: QWEN_DUBBING_MODEL, status: 'UNDEPLOYED' });
  assert.deepEqual(await service.deleteVoice(id), { voiceId: id, deleted: true });
  assert.deepEqual(actions, ['query_voice', 'query_voice', 'delete_voice']);
  let calls = 0;
  await assert.rejects(client(() => { calls++; return json({ status: 'OK', target_model: 'foreign' }); }).deleteVoice(id));
  assert.equal(calls, 1);
});

test('Qwen synthesis verifies ready model, sends exact WAV request, downloads without credentials and writes validated audio', async () => {
  await temporary(async file => {
    const audio = pcm(1, 24000);
    let calls = 0;
    const service = client((url, init) => {
      calls++;
      assert.equal(init.redirect, 'error');
      if (calls === 1) { assert.equal(input(init).action, 'query_voice'); return json({ status: 'OK', target_model: QWEN_DUBBING_MODEL }); }
      if (calls === 2) {
        assert.equal(url, `${baseUrl}/services/audio/tts/SpeechSynthesizer`);
        assert.deepEqual(JSON.parse(init.body as string), { model: QWEN_DUBBING_MODEL, input: { text: '你好\nworld', voice: id, format: 'wav', sample_rate: 24000 } });
        return json({ audio: { url: signedUrl } });
      }
      assert.equal(url, signedUrl); assert.equal(init.method, 'GET'); assert.equal(init.headers, undefined);
      return new Response(new Uint8Array(audio), { headers: { 'content-type': 'audio/wav' } });
    });
    assert.deepEqual(await service.synthesize('你好\nworld', id, file), { outputFile: file, bytes: audio.length, sampleRate: 24000, durationSeconds: 1 });
    assert.deepEqual(await fs.readFile(file), audio);
    assert.equal(calls, 3);
  });
});

test('Qwen synthesis rejects unsafe download URLs before any download or file write', async () => {
  await temporary(async file => {
    for (const url of [
      'http://dashscope-result.oss-cn-beijing.aliyuncs.com/a.wav', 'https://127.0.0.1/a.wav',
      'https://localhost/a.wav', 'https://169.254.169.254/a.wav', 'https://[::1]/a.wav',
      'https://evil.example/a.wav', 'https://bucket.oss-cn-beijing.aliyuncs.com.evil.example/a.wav',
      'https://bucket.oss-cn-beijing-internal.aliyuncs.com/a.wav',
      'https://user:pass@bucket.oss-cn-beijing.aliyuncs.com/a.wav',
      'https://bucket.oss-cn-beijing.aliyuncs.com/a.wav#secret',
      'https://bucket.oss-cn-beijing.aliyuncs.com:8080/a.wav',
      'https://bucket.oss-cn-beijing.aliyuncs.com\\@evil.example/a.wav',
    ]) {
      let calls = 0;
      const service = client(() => { calls++; return calls === 1 ? json({ status: 'OK' }) : json({ audio: { url } }); });
      await assert.rejects(service.synthesize('hello', id, file), safeError);
      assert.equal(calls, 2);
      await assert.rejects(fs.stat(file));
    }
  });
});

test('Qwen resolves only public targets and rejects mixed or private DNS results', async () => {
  for (const addresses of [[], ['127.0.0.1'], ['10.1.2.3'], ['172.16.1.1'], ['192.168.1.1'], ['100.64.1.1'],
    ['169.254.1.1'], ['0.0.0.0'], ['224.0.0.1'], ['::1'], ['fc00::1'], ['fe80::1'], ['::ffff:127.0.0.1'],
    ['2001:db8::1'], ['2002:7f00:1::'], ['8.8.8.8', '192.168.1.1'], ['not-an-ip']]) {
    await assert.rejects(client(() => { assert.fail('Private DNS must not reach fetch'); }, { resolveHost: async () => addresses }).queryVoice(id), safeError);
  }
  await client(() => json({ status: 'OK' }), { resolveHost: async () => ['2606:4700:4700::1111'] }).queryVoice(id);
  await temporary(async file => {
    let calls = 0;
    const service = client(() => { calls++; return calls === 1 ? json({ status: 'OK' }) : json({ audio: { url: signedUrl } }); }, {
      resolveHost: async host => host.includes('.oss-') ? ['192.168.1.1'] : ['8.8.8.8'],
    });
    await assert.rejects(service.synthesize('hello', id, file)); assert.equal(calls, 2);
  });
});

test('Qwen limits JSON bytes including streamed bodies and sanitizes HTTP, API, parse and transport errors', async () => {
  for (const response of [
    () => new Response(key, { status: 401 }),
    () => new Response(null, { status: 302, headers: { location: 'http://localhost/' } }),
    () => Response.json({ code: key, message: key }),
    () => new Response(key),
    () => json({ status: key }),
    () => json({ status: 'OK', extra: 'x'.repeat(65536) }),
    () => new Response('x', { headers: { 'content-length': '65537' } }),
    () => new Response('x', { headers: { 'content-length': 'NaN' } }),
    () => new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(65536)); c.enqueue(new Uint8Array(1)); c.close(); } })),
    () => new Response(null),
  ]) await assert.rejects(client(() => response()).queryVoice(id), safeError);
  await assert.rejects(client(() => { throw new Error(key); }).queryVoice(id), safeError);
  const redirected = json({ status: 'OK' }); Object.defineProperty(redirected, 'redirected', { value: true });
  await assert.rejects(client(() => redirected).queryVoice(id), safeError);
});

test('Qwen rejects invalid output WAV and actual or declared oversized audio, preserving destination', async () => {
  await temporary(async (file, directory) => {
    await fs.writeFile(file, 'original');
    for (const audio of [
      () => new Response('ID3not-wav'),
      () => new Response(new Uint8Array(pcm(1, 16000))),
      () => new Response(Buffer.alloc(0)),
      () => new Response(new Uint8Array(pcm(1, 24000).subarray(0, 45))),
      () => new Response('small', { headers: { 'content-length': String(32 * 1024 * 1024 + 1) } }),
      () => new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(32 * 1024 * 1024)); c.enqueue(new Uint8Array(1)); c.close(); } })),
    ]) {
      let calls = 0;
      const service = client(() => { calls++; return calls === 1 ? json({ status: 'OK' }) : calls === 2 ? json({ audio: { url: signedUrl } }) : audio(); });
      await assert.rejects(service.synthesize('hello', id, file), safeError);
      assert.equal(await fs.readFile(file, 'utf8'), 'original');
      assert.deepEqual(await fs.readdir(directory), ['out.wav']);
    }
  });
});

test('Qwen rejects empty, oversized and control-character text before network and unready voices before synthesis', async () => {
  for (const text of ['', '  ', 'x'.repeat(4097), '\0']) {
    await assert.rejects(client(() => { assert.fail('Invalid input must not reach fetch'); }).synthesize(text, id, 'unused.wav'), safeError);
  }
  for (const status of ['DEPLOYING', 'UNDEPLOYED']) {
    let calls = 0;
    await assert.rejects(client(() => { calls++; return json({ status }); }).synthesize('hello', id, 'unused.wav'));
    assert.equal(calls, 1);
  }
});

test('Qwen pre-abort performs no DNS or fetch and cancellation releases an uncooperative fetch', async () => {
  const controller = new AbortController(); controller.abort();
  const service = client(() => { assert.fail('Aborted operation must not fetch'); }, { resolveHost: async () => { assert.fail('Aborted operation must not resolve'); } });
  await assert.rejects(service.queryVoice(id, controller.signal), /cancelled/);
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  let finish!: (response: Response) => void;
  const blocked = new Promise<Response>(resolve => { finish = resolve; });
  const active = new AbortController();
  const pending = client(() => { entered(); return blocked; }).queryVoice(id, active.signal);
  await started;
  const rejected = assert.rejects(pending, /cancelled/);
  active.abort(); await rejected;
  let cancelled = false;
  finish(new Response(new ReadableStream({ cancel() { cancelled = true; } })));
  await Promise.resolve(); await Promise.resolve();
  assert.equal(cancelled, true);
});

test('Qwen abort cancels response stream and timeout bounds uncooperative fetch/DNS and polling', async t => {
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  let cancelled = false;
  const controller = new AbortController();
  const pending = client(() => new Response(new ReadableStream({ pull() { entered(); }, cancel() { cancelled = true; } }))).queryVoice(id, controller.signal);
  await started;
  const rejected = assert.rejects(pending, /cancelled/); controller.abort(); await rejected;
  assert.equal(cancelled, true);

  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const service of [
    client(() => new Promise<Response>(() => {}), { timeoutMs: 10 }),
    client(() => { assert.fail('Blocked DNS must not fetch'); }, { timeoutMs: 10, resolveHost: () => new Promise(() => {}) }),
    client((_url, init) => json(input(init).action === 'create_voice' ? { voice_id: id } : { status: 'DEPLOYING' }), { timeoutMs: 10 }),
  ]) {
    const operation = service.createVoice(pcm());
    const failure = assert.rejects(operation, /timed out/);
    for (let i = 0; i < 30; i++) await Promise.resolve();
    t.mock.timers.tick(10); await failure;
  }
});

test('Qwen abort during audio download leaves no file and no temporary output', async () => {
  await temporary(async (file, directory) => {
    const controller = new AbortController();
    let reached!: () => void;
    const reading = new Promise<void>(resolve => { reached = resolve; });
    let calls = 0;
    const service = client(() => {
      calls++;
      if (calls === 1) return json({ status: 'OK' });
      if (calls === 2) return json({ audio: { url: signedUrl } });
      return new Response(new ReadableStream({ pull() { reached(); } }));
    });
    const operation = service.synthesize('hello', id, file, controller.signal);
    await reading;
    const rejected = assert.rejects(operation, /cancelled/); controller.abort(); await rejected;
    assert.deepEqual(await fs.readdir(directory), []);
  });
});
