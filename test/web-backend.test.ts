import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { ViteDevServer } from 'vite';
import ffmpeg from 'ffmpeg-static';
import { browserBackend } from '../scripts/browser-backend';
import { Downloader } from '../src/main/downloader';
import { DubbingService } from '../src/main/dubbing';
import { pcmWav } from '../src/main/asr';
import { defaultTranslationSettings } from '../src/shared/translation';
import { defaultTtsSettings } from '../src/shared/tts';
import { defaultAsrSettings } from '../src/shared/asr';

interface Envelope { ok: boolean; data?: any; error?: string }
interface Reply { status: number; body: Envelope; headers: http.IncomingHttpHeaders }
type Handler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;

async function listen(server: http.Server, port = 0): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function close(server: http.Server): Promise<void> {
  if (!server.listening) return;
  const closed = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  // In particular, SSE observers and deliberately stalled mock requests must not hold teardown open.
  server.closeAllConnections();
  await closed;
}

async function bytes(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function fixture(t: TestContext, upstreamHandler?: Handler) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lingvoice-web-backend-test-'));
  const servers: http.Server[] = [];
  t.after(async () => {
    try { for (const server of servers.reverse()) await close(server); }
    finally { await fs.rm(dataDir, { recursive: true, force: true }); }
  });
  let upstream = '';
  if (upstreamHandler) {
    const server = http.createServer((req, res) => {
      void Promise.resolve(upstreamHandler(req, res)).catch(error => res.destroy(error));
    });
    servers.push(server);
    upstream = await listen(server);
  }
  async function start(responseHeartbeatMs?: number, port = 0) {
    let middleware: Handler | undefined;
    const server = http.createServer((req, res) => {
      const prefix = '/api/lingvoice';
      if (!req.url?.startsWith(prefix)) { res.writeHead(404).end(); return; }
      req.url = req.url.slice(prefix.length);
      void Promise.resolve(middleware!(req, res)).catch(error => res.destroy(error));
    });
    servers.push(server);
    const origin = await listen(server, port);
    const plugin = browserBackend({ dataDir, folder: path.join(dataDir, 'downloads'), origin, ffmpegPath: ffmpeg!, responseHeartbeatMs });
    const configure = plugin.configureServer!;
    assert.equal(typeof configure, 'function');
    await (configure as (server: ViteDevServer) => unknown)({
      httpServer: server,
      middlewares: { use(prefix: string, handler: Handler) { assert.equal(prefix, '/api/lingvoice'); middleware = handler; } },
    } as unknown as ViteDevServer);
    async function request(route: string, body: string | Uint8Array, headers: http.OutgoingHttpHeaders = {}): Promise<Reply> {
      return new Promise((resolve, reject) => {
        const req = http.request(`${origin}/api/lingvoice${route}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json', Connection: 'close', ...headers },
        }, res => {
          void bytes(res).then(raw => resolve({ status: res.statusCode!, body: JSON.parse(raw.toString()), headers: res.headers }), reject);
        });
        req.on('error', reject);
        req.setTimeout(10000, () => req.destroy(new Error('Test HTTP request timed out')));
        req.end(body);
      });
    }
    const post = (route: string, body: unknown = {}) => request(route, JSON.stringify(body));
    const upload = (body: Uint8Array = pcmWav(Buffer.alloc(6400))) => request('/asr-upload', body, { 'Content-Type': 'application/octet-stream' });
    const provider = async (adapter = 'openai-compatible', apiKey = 'local-test-secret') => {
      const reply = await post('/provider-save', { name: 'Local mock', adapter, baseUrl: upstream || origin, apiKey });
      assert.equal(reply.body.ok, true, reply.body.error);
      return reply.body.data;
    };
    return { server, origin, request, post, upload, provider };
  }
  return { dataDir, upstream, start };
}

function success(reply: Reply): any {
  assert.equal(reply.status, 200);
  assert.equal(reply.body.ok, true, reply.body.error);
  return reply.body.data;
}
function failure(reply: Reply, pattern: RegExp, status = 200): void {
  assert.equal(reply.status, status);
  assert.equal(reply.body.ok, false);
  assert.match(reply.body.error!, pattern);
}
async function noUploads(dataDir: string): Promise<void> {
  assert.deepEqual(await fs.readdir(path.join(dataDir, 'uploads')), []);
}
function json(res: ServerResponse, body: unknown, status = 200): void {
  res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
}

test('Web history uploads persist across origin changes, retain 20k cues, and reuse media for ASR', { timeout: 30000 }, async t => {
  const f = await fixture(t, async (req, res) => {
    await bytes(req); json(res, { segments: [{ start: 0, end: 0.1, text: 'Persistent source' }] });
  });
  const first = await f.start();
  const provider = await first.provider();
  success(await first.post('/asr-save', { settings: { ...defaultAsrSettings, providerId: provider.id } }));
  const id = '29f47cbe-62b4-45bb-8eef-a941190b579a';
  failure(await first.request('/history-media/not-a-uuid', Buffer.from('x'), { 'Content-Type': 'application/octet-stream' }), /Invalid history task ID/, 400);
  failure(await first.request(`/history-media/${id}`, Buffer.alloc(0), { 'Content-Type': 'application/octet-stream' }), /upload failed/);
  failure(await first.request(`/history-media/${id}`, Buffer.from('x'), { 'Content-Type': 'application/octet-stream', 'Content-Length': 512 * 1024 * 1024 + 1 }), /512 MB/, 413);
  const wav = pcmWav(Buffer.alloc(6400));
  const file = success(await first.request(`/history-media/${id}`, wav, { 'Content-Type': 'application/octet-stream' })).file;
  const task = { id, title: 'Local video', createdAt: 1, updatedAt: 2, file, embed: '', subtitles: {
    cues: Array.from({ length: 20000 }, (_, i) => ({ id: i + 1, start: i, end: i + 1, text: 'Subtitle text', translated: 'Translation' })),
    offset: 0, fontSize: 24, mode: 'bilingual', name: 'Saved', result: {
      jobId: 'job', video: file, audio: file, subtitles: file, cues: [{ id: 1, start: 0, end: 1, text: 'Original', speechText: 'Speech' }],
      preview: false, targetLanguage: 'zh', voiceId: 'voice',
    }, translationFingerprint: '',
  } };
  success(await first.post('/history-save', task));
  success(await first.post('/history-save', { ...task, title: 'Edited' }));
  success(await first.post('/history-select', { id }));
  failure(await first.post('/history-select', { id: 'missing' }), /task history/);
  for (const bad of ['/etc/passwd', 'file:///etc/passwd', `${first.origin}/api/lingvoice/media/00000000-0000-4000-8000-000000000000`, 'https://example.com/video.mp4']) {
    failure(await first.post('/history-save', { ...task, file: bad }), /task history/);
    failure(await first.post('/history-save', { ...task, subtitles: { ...task.subtitles, result: {
      jobId: 'job', video: file, audio: bad, subtitles: file, cues: [], preview: false, targetLanguage: 'zh', voiceId: 'voice',
    } } }), /task history/);
  }
  assert.deepEqual(success(await first.post('/asr-run', { file })), [{ id: 1, start: 0, end: 0.1, text: 'Persistent source' }]);
  await close(first.server);
  const restarted = await f.start();
  assert.notEqual(restarted.origin, first.origin);
  const state = success(await restarted.post('/history'));
  assert.equal(state.activeId, id);
  assert.equal(state.tasks.length, 1);
  assert.equal(state.tasks[0].title, 'Edited');
  assert.equal(state.tasks[0].subtitles.cues.length, 20000);
  const restored = state.tasks[0].file;
  assert.ok(restored.startsWith(restarted.origin));
  for (const key of ['video', 'audio', 'subtitles']) assert.equal(state.tasks[0].subtitles.result[key], restored);
  assert.equal(state.tasks[0].subtitles.result.cues[0].speechText, 'Speech');
  const response = await fetch(restored);
  assert.equal(response.status, 200);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), Buffer.from(wav));
  assert.deepEqual(success(await restarted.post('/asr-run', { file: restored })), [{ id: 1, start: 0, end: 0.1, text: 'Persistent source' }]);
  success(await restarted.post('/history-save', state.tasks[0]));
  success(await restarted.post('/history-delete', { id }));
  assert.deepEqual(success(await restarted.post('/history')), { tasks: [], activeId: '' });
  assert.equal((await fetch(restored)).status, 200, 'deletion retains shared media and exported files');
  assert.equal((await fs.readdir(path.join(f.dataDir, 'task-media'))).length, 1);
  const stored = await fs.readFile(path.join(f.dataDir, 'history.sqlite'));
  assert.ok(!stored.includes(Buffer.from(first.origin)), 'SQLite stores origin-independent capabilities');
});

test('Web long translation responses keep idle connections active and preserve JSON success and errors without replay', { timeout: 20000 }, async t => {
  let calls = 0;
  const f = await fixture(t, async (req, res) => {
    await bytes(req);
    calls++;
    await new Promise(resolve => setTimeout(resolve, 180));
    json(res, { choices: [{ message: { content: '["Bonjour"]' } }] });
  });
  const app = await f.start(20);
  const provider = await app.provider();
  success(await app.post('/translation-save', { settings: { ...defaultTranslationSettings, providerId: provider.id, model: 'slow-model' } }));
  // Simulate an aggressive idle socket policy without waiting minutes in a test.
  app.server.setTimeout(60);
  const chunks: string[] = [];
  const reply = await new Promise<Reply>((resolve, reject) => {
    const req = http.request(`${app.origin}/api/lingvoice/translation-run`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Connection: 'close' },
    }, res => {
      res.on('data', chunk => chunks.push(chunk.toString()));
      res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: JSON.parse(chunks.join('')) }));
    });
    req.on('error', reject);
    req.end(JSON.stringify({ texts: ['Hello'] }));
  });
  assert.deepEqual(success(reply), ['Bonjour']);
  assert.equal(reply.headers['x-accel-buffering'], 'no');
  assert.match(reply.headers['cache-control']!, /no-transform/);
  assert.ok(chunks.filter(chunk => /^\s+$/.test(chunk)).length >= 2, 'send multiple heartbeats before completion');
  assert.equal(calls, 1, 'transport never replays the provider request');
  failure(await app.post('/translation-run', { texts: [] }), /between 1 and 40/);
  assert.equal(calls, 1, 'validation errors remain readable after headers have been flushed');
});

test('Web translation review reaches the configured provider and returns corrections', { timeout: 20000 }, async t => {
  let calls = 0;
  const f = await fixture(t, async (req, res) => {
    calls++;
    assert.equal(req.url, '/v1/chat/completions');
    assert.equal(req.headers.authorization, 'Bearer local-test-secret');
    const body = JSON.parse((await bytes(req)).toString());
    assert.equal(body.model, 'review-model');
    assert.match(body.messages[0].content, /reviewer/);
    json(res, { choices: [{ message: { content: JSON.stringify([{ id: 1, translated: '你好' }]) } }] });
  });
  const app = await f.start();
  const provider = await app.provider();
  success(await app.post('/translation-save', { settings: { ...defaultTranslationSettings, providerId: provider.id, model: 'review-model' } }));
  assert.deepEqual(success(await app.post('/translation-review', {
    cues: [{ id: 1, text: 'Hello', translated: '错误译文', duration: 2 }],
  })), [{ id: 1, translated: '你好' }]);
  assert.equal(calls, 1);
  failure(await app.post('/translation-review', { cues: [] }), /between 1 and 200/);
  assert.equal(calls, 1);
});

test('Web memory summary, terminology-aware translation and review share the same saved provider', { timeout: 20000 }, async t => {
  let calls = 0;
  const f = await fixture(t, async (req, res) => {
    calls++;
    assert.equal(req.url, '/v1/chat/completions');
    assert.equal(req.headers.authorization, 'Bearer local-test-secret');
    const body = JSON.parse((await bytes(req)).toString());
    assert.equal(body.model, 'memory-model');
    const payload = JSON.parse(body.messages[1].content);
    let content: string;
    if (calls === 1) {
      assert.equal(payload.pairs[0].source, 'Alice works at Acme.');
      content = JSON.stringify({ summary: 'Alice works at Acme.', terms: [{ source: 'Alice', translated: '爱丽丝' }, { source: 'Acme', translated: '艾克米' }] });
    } else if (calls === 2) {
      assert.equal(payload.memory.summary, 'Alice works at Acme.');
      assert.equal(payload.memory.terms[0].translated, '爱丽丝');
      assert.match(body.messages[0].content, /Never invent alternate translations/);
      assert.deepEqual(payload.translate, ['Alice returned to Acme.']);
      content = JSON.stringify(['爱丽丝回到了艾克米。']);
    } else {
      assert.equal(payload.memory.terms[1].translated, '艾克米');
      assert.match(body.messages[0].content, /Preserve every established/);
      content = '[]';
    }
    json(res, { choices: [{ message: { content } }] });
  });
  const app = await f.start();
  const provider = await app.provider();
  success(await app.post('/translation-save', { settings: { ...defaultTranslationSettings, providerId: provider.id, model: 'memory-model' } }));
  const memory = success(await app.post('/translation-memory', {
    memory: { summary: '', terms: [] }, pairs: [{ source: 'Alice works at Acme.', translated: '爱丽丝在艾克米工作。' }],
  }));
  assert.deepEqual(success(await app.post('/translation-run', { texts: ['Alice returned to Acme.'], memory })), ['爱丽丝回到了艾克米。']);
  assert.deepEqual(success(await app.post('/translation-review', { memory, cues: [{ id: 1, text: 'Alice returned to Acme.', translated: '爱丽丝回到了艾克米。' }] })), []);
  assert.equal(calls, 3);
  failure(await app.post('/translation-memory', { memory: { summary: '', terms: [] }, pairs: Array(41).fill({ source: 'x', translated: 'y' }) }), /at most 40/);
  assert.equal(calls, 3);
});

const options = { timeout: 20000 };

test('Web model discovery is independent of task settings and TTS persists, synthesizes and protects its provider', options, async t => {
  const audio = Buffer.from('ID3-local-fixture');
  const requests: string[] = [];
  const f = await fixture(t, async (req, res) => {
    assert.equal(req.headers.authorization, 'Bearer local-test-secret');
    requests.push(req.url!);
    if (req.url === '/v1/models') { json(res, { data: [{ id: 'tts-1' }, { id: 'qwen-audio-3.0-asr-flash' }] }); return; }
    assert.equal(req.url, '/v1/audio/speech');
    assert.deepEqual(JSON.parse((await bytes(req)).toString()), { model: 'tts-1', input: 'Hello from Web', voice: 'alloy', speed: 1, response_format: 'mp3' });
    res.writeHead(200, { 'Content-Type': 'audio/mpeg' }).end(audio);
  });
  const app = await f.start();
  const provider = await app.provider();
  const translation = success(await app.post('/translation-config'));
  const speech = success(await app.post('/asr-config'));
  assert.deepEqual(success(await app.post('/provider-models', { id: provider.id })), ['qwen-audio-3.0-asr-flash', 'tts-1']);
  assert.deepEqual(success(await app.post('/translation-config')), translation);
  assert.deepEqual(success(await app.post('/asr-config')), speech);
  const settings = { ...defaultTtsSettings, providerId: provider.id, model: 'tts-1' };
  assert.deepEqual(success(await app.post('/tts-save', { settings })).settings, settings);
  failure(await app.post('/provider-remove', { id: provider.id }), /in use/);
  failure(await app.post('/provider-save', { ...provider, adapter: 'libretranslate' }), /TTS/);
  const generated = success(await app.post('/tts-generate', { text: 'Hello from Web' }));
  assert.equal(generated.mimeType, 'audio/mpeg');
  assert.equal(generated.fileName, 'speech.mp3');
  assert.deepEqual(Buffer.from(generated.audioBase64, 'base64'), audio);
  failure(await app.post('/tts-generate', { text: 'Hello', settings }), /overrides/);
  assert.deepEqual(requests, ['/v1/models', '/v1/audio/speech']);
  await close(app.server);
  const restarted = await f.start();
  assert.deepEqual(success(await restarted.post('/tts-config')).settings, settings);
  success(await restarted.post('/tts-save', { settings: defaultTtsSettings }));
  success(await restarted.post('/provider-remove', { id: provider.id }));
});

test('Web TTS cancellation releases an outstanding request and returns safe errors', options, async t => {
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const f = await fixture(t, async (req, _res) => { await bytes(req); started(); });
  const app = await f.start();
  const provider = await app.provider();
  success(await app.post('/tts-save', { settings: { ...defaultTtsSettings, providerId: provider.id, model: 'tts-1' } }));
  const generation = app.post('/tts-generate', { text: 'Cancel this request' });
  await ready;
  success(await app.post('/tts-cancel'));
  failure(await generation, /cancelled/);
  failure(await app.post('/tts-generate', { text: '' }), /4096/);
});

test('Web provider catalog redacts secrets and persists providers, task settings and encrypted credentials across instances', options, async t => {
  const received: string[] = [];
  const f = await fixture(t, (req, res) => {
    received.push(req.headers.authorization!);
    assert.equal(req.url, '/v1/models');
    json(res, { data: [{ id: 'z-model' }, { id: 'a-model' }, { id: 'z-model' }] });
  });
  const first = await f.start();
  assert.deepEqual(success(await first.post('/providers')).providers, []);
  const provider = await first.provider();
  assert.equal(provider.hasApiKey, true);
  assert.equal(Object.hasOwn(provider, 'apiKey'), false);
  const edited = success(await first.post('/provider-save', { id: provider.id, name: 'Renamed', adapter: provider.adapter, baseUrl: f.upstream }));
  assert.equal(edited.hasApiKey, true, 'omitting the credential preserves it');
  const translation = { ...defaultTranslationSettings, providerId: provider.id, model: 'local-translator', targetLanguage: 'fr' };
  const asr = { ...defaultAsrSettings, providerId: provider.id, model: 'local-speech', language: 'en', prompt: 'Local fixture' };
  success(await first.post('/translation-save', { settings: translation }));
  success(await first.post('/asr-save', { settings: asr }));
  const catalog = await first.post('/providers');
  assert.equal(JSON.stringify(catalog.body).includes('local-test-secret'), false);
  assert.equal(JSON.stringify(catalog.body).includes('lv1:'), false);
  assert.equal(catalog.headers['cache-control'], 'no-store');
  const disk = await fs.readFile(path.join(f.dataDir, 'providers.json'), 'utf8');
  assert.equal(disk.includes('local-test-secret'), false);
  assert.match(JSON.parse(disk).providers[0].apiKey, /^lv1:/);
  await close(first.server);
  const second = await f.start();
  assert.deepEqual(success(await second.post('/providers')).providers, [edited]);
  assert.deepEqual(success(await second.post('/translation-config')).settings, translation);
  assert.deepEqual(success(await second.post('/asr-config')).settings, asr);
  assert.deepEqual(success(await second.post('/translation-models')), ['a-model', 'z-model']);
  assert.deepEqual(received, ['Bearer local-test-secret']);
  const cleared = success(await second.post('/provider-save', { ...edited, apiKey: '' }));
  assert.equal(cleared.hasApiKey, false);
  await close(second.server);
  const third = await f.start();
  assert.equal(success(await third.post('/providers')).providers[0].hasApiKey, false);
});

test('Web task bindings guard provider deletion, incompatible adapters and task-level credentials', options, async t => {
  const f = await fixture(t);
  const app = await f.start();
  const provider = await app.provider();
  const libre = await app.provider('libretranslate', '');
  const translation = { ...defaultTranslationSettings, providerId: provider.id };
  const asr = { ...defaultAsrSettings, providerId: provider.id };
  success(await app.post('/translation-save', { settings: translation }));
  failure(await app.post('/provider-remove', { id: provider.id }), /in use/i);
  failure(await app.post('/provider-save', { ...provider, adapter: 'unknown-adapter' }), /bound to translation/i);
  success(await app.post('/asr-save', { settings: asr }));
  failure(await app.post('/provider-save', { ...provider, adapter: 'libretranslate' }), /bound to speech recognition/i);
  failure(await app.post('/asr-save', { settings: { ...asr, providerId: libre.id } }), /capability/i);
  success(await app.post('/translation-save', { settings: translation, apiKey: 'custom-key' }));
  assert.equal(success(await app.post('/translation-config')).hasApiKey, true);
  success(await app.post('/asr-save', { settings: asr, apiKey: 'custom-key' }));
  assert.equal(success(await app.post('/asr-config')).hasApiKey, true);
  assert.equal(success(await app.post('/providers')).providers[0].adapter, 'openai-compatible');
  success(await app.post('/translation-save', { settings: { ...translation, providerId: '' } }));
  failure(await app.post('/provider-remove', { id: provider.id }), /in use/i);
  success(await app.post('/asr-save', { settings: { ...asr, providerId: '' } }));
  success(await app.post('/provider-remove', { id: provider.id }));
  assert.deepEqual(success(await app.post('/providers')).providers.map((item: any) => item.id), [libre.id]);
});

test('Web translation calls only the saved local upstream using chat, responses and LibreTranslate adapters', options, async t => {
  const requests: { url: string; body: any; authorization?: string }[] = [];
  const f = await fixture(t, async (req, res) => {
    requests.push({ url: req.url!, body: JSON.parse((await bytes(req)).toString()), authorization: req.headers.authorization });
    if (req.url === '/v1/chat/completions') json(res, { choices: [{ message: { content: '["Bonjour","Monde"]' } }] });
    else if (req.url === '/v1/responses') json(res, { output_text: '["Bonjour","Monde"]' });
    else if (req.url === '/translate') json(res, { translatedText: ['Bonjour', 'Monde'] });
    else json(res, { error: 'Unexpected route' }, 404);
  });
  const app = await f.start();
  const provider = await app.provider();
  for (const protocol of ['chat', 'responses']) {
    success(await app.post('/translation-save', { settings: { ...defaultTranslationSettings, providerId: provider.id, protocol, model: 'test-model', targetLanguage: 'fr' } }));
    assert.deepEqual(success(await app.post('/translation-run', { texts: ['Hello', 'World'] })), ['Bonjour', 'Monde']);
  }
  assert.equal(requests[0].authorization, 'Bearer local-test-secret');
  assert.equal(requests[0].body.model, 'test-model');
  assert.deepEqual(JSON.parse(requests[0].body.messages[1].content), ['Hello', 'World']);
  assert.deepEqual(JSON.parse(requests[1].body.input), ['Hello', 'World']);
  const libre = await app.provider('libretranslate');
  success(await app.post('/translation-save', { settings: { ...defaultTranslationSettings, providerId: libre.id, targetLanguage: 'fr' } }));
  assert.deepEqual(success(await app.post('/translation-run', { texts: ['Hello', 'World'] })), ['Bonjour', 'Monde']);
  assert.deepEqual(requests[2].body, { q: ['Hello', 'World'], source: 'auto', target: 'fr', format: 'text', api_key: 'local-test-secret' });
  failure(await app.post('/translation-models'), /capability/);
  failure(await app.post('/translation-run', { texts: ['Hello'], settings: {} }), /without settings overrides/);
  assert.deepEqual(requests.map(item => item.url), ['/v1/chat/completions', '/v1/responses', '/translate']);
});

test('Web ASR extracts real WAV audio with FFmpeg, emits named progress and consumes uploaded media', options, async t => {
  assert.ok(ffmpeg, 'ffmpeg-static must provide the actual executable');
  let uploadBody: Buffer = Buffer.alloc(0);
  const f = await fixture(t, async (req, res) => {
    assert.equal(req.url, '/compatible-mode/v1/chat/completions');
    assert.equal(req.headers.authorization, 'Bearer local-test-secret');
    assert.equal(req.headers['content-type'], 'application/json');
    uploadBody = await bytes(req);
    json(res, { segments: [{ start: 0, end: 0.1, text: ' Hello fixture ' }] });
  });
  const app = await f.start();
  const provider = await app.provider();
  success(await app.post('/asr-save', { settings: { ...defaultAsrSettings, providerId: provider.id } }));
  let eventText = '';
  let eventResponse: IncomingMessage | undefined;
  const observer = http.get(`${app.origin}/api/lingvoice/events`);
  t.after(() => { eventResponse?.destroy(); observer.destroy(); });
  const progress = new Promise<void>((resolve, reject) => {
    observer.on('error', reject);
    observer.on('response', res => {
      eventResponse = res;
      assert.equal(res.headers['content-type'], 'text/event-stream');
      res.on('data', chunk => {
        eventText += chunk.toString();
        if (eventText.includes('"stage":"transcribing","completed":1')) resolve();
      });
      res.on('error', reject);
    });
  });
  // Wait until the SSE subscription is registered, not merely until its socket exists.
  await new Promise<void>(resolve => {
    observer.on('response', res => res.once('data', () => resolve()));
  });
  const token = success(await app.upload()).file;
  assert.match(token, /^upload:/);
  assert.equal((await fs.readdir(path.join(f.dataDir, 'uploads'))).length, 1);
  assert.deepEqual(success(await app.post('/asr-run', { file: token })), [{ id: 1, start: 0, end: 0.1, text: 'Hello fixture' }]);
  await progress;
  eventResponse!.destroy(); observer.destroy();
  const events = eventText.split('\n\n').filter(frame => frame.startsWith('event: asr-progress\ndata: ')).map(frame => JSON.parse(frame.split('\ndata: ')[1]));
  assert.deepEqual(events, [
    { stage: 'extracting', completed: 0, total: 1 }, { stage: 'extracting', completed: 1, total: 1 },
    { stage: 'transcribing', completed: 0, total: 1 }, { stage: 'transcribing', completed: 1, total: 1 },
  ]);
  const body = JSON.parse(uploadBody.toString());
  assert.equal(body.model, 'qwen-audio-3.1-asr-flash');
  assert.equal(body.stream, false);
  assert.deepEqual(body.asr_options, { enable_itn: false });
  assert.equal(body.messages.length, 1);
  assert.equal(body.messages[0].role, 'user');
  const audio = body.messages[0].content[0];
  assert.equal(audio.type, 'input_audio');
  assert.match(audio.input_audio.data, /^data:audio\/wav;base64,/);
  const wav = Buffer.from(audio.input_audio.data.split(',')[1], 'base64');
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
  assert.equal(wav.readUInt32LE(40), wav.length - 44);
  await noUploads(f.dataDir);
  failure(await app.post('/asr-run', { file: token }), /Select a local media file/);
});

test('Web ASR removes uploads after FFmpeg errors and malformed provider responses, and permits explicit removal', options, async t => {
  let upstreamCalls = 0;
  const f = await fixture(t, async (req, res) => { await bytes(req); upstreamCalls++; json(res, { text: 'Missing timestamps' }); });
  const app = await f.start();
  const provider = await app.provider();
  success(await app.post('/asr-save', { settings: { ...defaultAsrSettings, providerId: provider.id } }));
  const corrupt = success(await app.upload(Buffer.from('not a media file'))).file;
  failure(await app.post('/asr-run', { file: corrupt }), /FFmpeg audio extraction failed/);
  await noUploads(f.dataDir);
  const valid = success(await app.upload()).file;
  failure(await app.post('/asr-run', { file: valid }), /timestamped segments/);
  await noUploads(f.dataDir);
  assert.equal(upstreamCalls, 1);
  const unused = success(await app.upload()).file;
  success(await app.post('/asr-upload-remove', { file: unused }));
  success(await app.post('/asr-upload-remove', { file: unused }));
  await noUploads(f.dataDir);
});

test('Web ASR cancellation aborts a pending local upstream request and cleans the consumed upload', options, async t => {
  let markStarted!: () => void;
  const started = new Promise<void>(resolve => { markStarted = resolve; });
  const f = await fixture(t, async req => { await bytes(req); markStarted(); /* Deliberately await cancellation without responding. */ });
  const app = await f.start();
  const provider = await app.provider();
  success(await app.post('/asr-save', { settings: { ...defaultAsrSettings, providerId: provider.id } }));
  const token = success(await app.upload()).file;
  const running = app.post('/asr-run', { file: token });
  await started;
  failure(await app.post('/asr-run', { file: token }), /Select a local media file/);
  const pendingToken = success(await app.upload()).file;
  failure(await app.post('/asr-run', { file: pendingToken }), /already busy/);
  success(await app.post('/asr-cancel'));
  failure(await running, /ASR cancelled/);
  // Rejecting concurrent recognition must leave that second upload available for removal.
  assert.equal((await fs.readdir(path.join(f.dataDir, 'uploads'))).length, 1);
  success(await app.post('/asr-upload-remove', { file: pendingToken }));
  await noUploads(f.dataDir);
});

test('Web backend rejects untrusted media references, invalid origins and oversized or empty uploads', options, async t => {
  const f = await fixture(t);
  const app = await f.start();
  const existing = path.join(f.dataDir, 'private.wav');
  await fs.writeFile(existing, pcmWav(Buffer.alloc(6400)));
  for (const file of [existing, 'https://example.invalid/private.wav', `${app.origin}/api/lingvoice/media/unknown`, 'upload:unknown']) {
    failure(await app.post('/asr-run', { file }), /Select a local media file/);
  }
  failure(await app.post('/asr-run', { file: existing, settings: {} }), /Invalid media reference/);
  for (const headers of [{ Origin: 'https://attacker.invalid' }, { Host: 'attacker.invalid' }, { 'Sec-Fetch-Site': 'cross-site' }]) {
    failure(await app.request('/providers', '{}', headers), /Invalid request origin/, 403);
  }
  success(await app.request('/providers', '{}', { Origin: app.origin, 'Sec-Fetch-Site': 'same-origin' }));
  failure(await app.request('/asr-upload', '', { 'Content-Type': 'application/octet-stream', 'Content-Length': String(512 * 1024 * 1024 + 1) }), /exceeds 512 MB/, 413);
  failure(await app.upload(new Uint8Array()), /empty or incomplete/);
  failure(await app.request('/asr-upload', '{}'), /Binary media upload required/, 415);
  await noUploads(f.dataDir);
});

test('Web issued download and dubbing media URLs survive restart and reject stale or unissued paths', options, async t => {
  const f = await fixture(t, async (req, res) => {
    await bytes(req);
    json(res, { segments: [{ start: 0, end: 0.1, text: 'Restarted source' }] });
  });
  const source = path.join(f.dataDir, 'download.wav');
  const output = {
    video: path.join(f.dataDir, 'dubbed.mp4'),
    audio: path.join(f.dataDir, 'dubbed.wav'),
    subtitles: path.join(f.dataDir, 'dubbed.srt'),
  };
  const contents = {
    video: Buffer.from('fixture-video'), audio: pcmWav(Buffer.alloc(6400)),
    subtitles: Buffer.from('1\n00:00:00,000 --> 00:00:00,100\nHello\n'),
  };
  await fs.writeFile(source, pcmWav(Buffer.alloc(6400)));
  for (const key of ['video', 'audio', 'subtitles'] as const) await fs.writeFile(output[key], contents[key]);
  t.mock.method(Downloader.prototype, 'download', async () => ({ file: source }));
  t.mock.method(DubbingService.prototype, 'run', async (request: { file: string; jobId: string }) => {
    assert.equal(request.file, await fs.realpath(source));
    return { ...output, jobId: request.jobId, cues: [], preview: false, targetLanguage: 'en', voiceId: 'fixture' };
  });
  const first = await f.start();
  const provider = await first.provider();
  success(await first.post('/asr-save', { settings: { ...defaultAsrSettings, providerId: provider.id } }));
  const downloaded = success(await first.post('/download', { url: 'https://example.com/video', height: '720' })).file;
  const payload = { jobId: 'persistent-dubbing', file: downloaded, cues: [], offset: 0, backgroundVolume: 1, preview: false, consent: true };
  const dubbed = success(await first.post('/dubbing-run', payload));
  const handleDir = path.join(f.dataDir, 'media-handles');
  const records = await fs.readdir(handleDir);
  assert.equal(records.length, 4);
  if (process.platform !== 'win32') {
    assert.equal((await fs.stat(handleDir)).mode & 0o777, 0o700);
    for (const record of records) assert.equal((await fs.stat(path.join(handleDir, record))).mode & 0o777, 0o600);
  }
  const port = Number(new URL(first.origin).port);
  await close(first.server);
  const restarted = await f.start(undefined, port);
  assert.equal(restarted.origin, first.origin, 'restart uses the same configured Web origin');
  const sourceResponse = await fetch(downloaded);
  assert.equal(sourceResponse.status, 200);
  assert.deepEqual(Buffer.from(await sourceResponse.arrayBuffer()), await fs.readFile(source));
  for (const key of ['video', 'audio', 'subtitles'] as const) {
    const response = await fetch(dubbed[key]);
    assert.equal(response.status, 200);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), Buffer.from(contents[key]));
  }
  const range = await fetch(dubbed.video, { headers: { Range: 'bytes=0-6' } });
  assert.equal(range.status, 206);
  assert.equal(await range.text(), 'fixture');
  const head = await fetch(dubbed.audio, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('content-length'), String(contents.audio.length));
  assert.deepEqual(success(await restarted.post('/asr-run', { file: downloaded })), [{ id: 1, start: 0, end: 0.1, text: 'Restarted source' }]);
  success(await restarted.post('/dubbing-run', payload));
  for (const file of [source, `file://${source}`, `${restarted.origin}/api/lingvoice/media/${encodeURIComponent(source)}`, `${restarted.origin}/api/lingvoice/media/00000000-0000-4000-8000-000000000000`]) {
    failure(await restarted.post('/asr-run', { file }), /Select a local media file/);
    failure(await restarted.post('/dubbing-run', { ...payload, file }), /Select a local media file/);
  }
  await fs.rm(source);
  assert.equal((await fetch(downloaded)).status, 404);
  failure(await restarted.post('/asr-run', { file: downloaded }), /Select a local media file/);
  failure(await restarted.post('/dubbing-run', payload), /Select a local media file/);
  await fs.rm(output.video);
  assert.equal((await fetch(dubbed.video)).status, 404);
  await fs.rm(output.audio);
  try {
    await fs.symlink(output.subtitles, output.audio);
    assert.equal((await fetch(dubbed.audio)).status, 404, 'a symlink replacement cannot expose another local file');
  } catch (error) {
    if (process.platform !== 'win32' || (error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
  }
  const subtitleToken = new URL(dubbed.subtitles).pathname.split('/').pop()!;
  await fs.writeFile(path.join(handleDir, subtitleToken), '{broken');
  assert.equal((await fetch(dubbed.subtitles)).status, 404, 'corrupt persisted records fail safely');
});

test('Web dubbing persists explicit settings, rejects arbitrary paths and releases claimed uploads on failure', options, async t => {
  const f = await fixture(t), app = await f.start();
  const config = success(await app.post('/dubbing-config'));
  assert.equal(config.model, 'qwen-audio-3.1-tts-plus');
  assert.equal(success(await app.post('/dubbing-check')).ready, false);
  const settings = { pythonPath: 'python', modelFile: '', baseUrl: 'https://workspace.cn-beijing.maas.aliyuncs.com/api/v1', model: 'qwen-audio-3.1-tts-plus' as const };
  assert.deepEqual(success(await app.post('/dubbing-save', settings)).settings, settings);
  failure(await app.post('/dubbing-save', { ...settings, baseUrl: 'https://untrusted.example/api/v1' }), /Untrusted/);
  const payload = { jobId: 'browser-dubbing-test', file: 'C:\\private\\arbitrary.mp4', cues: [{ id: 1, start: 0, end: 6, text: 'Hello' }], offset: 0, backgroundVolume: 1, preview: false, consent: true };
  failure(await app.post('/dubbing-run', payload), /Select a local media file/);
  failure(await app.post('/dubbing-run', { ...payload, file: 'https://example.com/video.mp4' }), /Select a local media file/);
  const uploaded = success(await app.upload());
  failure(await app.post('/dubbing-run', { ...payload, file: uploaded.file, consent: false }), /consent/);
  await noUploads(f.dataDir);
  failure(await app.post('/dubbing-delete-voice', { voiceId: 'unmanaged-voice' }), /registered/);
  success(await app.post('/dubbing-cancel', { jobId: payload.jobId }));
  success(await app.post('/dubbing-clear'));
  await close(app.server);
  const restarted = await f.start();
  assert.deepEqual(success(await restarted.post('/dubbing-config')).settings, settings);
});
