import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { ProviderRegistry, ProviderService, createDefaultProviderRegistry } from '../src/main/providers';
import { TtsService } from '../src/main/tts';
import { defaultTtsSettings, type TtsConfigUpdate, type TtsRequest } from '../src/shared/tts';

const vault = { encrypt: (value: string) => `encrypted:${value}`, decrypt: (value: string) => value.slice(10) };
const audio = () => new Response(new Uint8Array([73, 68, 51, 1]), { headers: { 'content-type': 'audio/mpeg' } });
async function fixture(action: (service: TtsService, providers: ProviderService, file: string, id: string) => Promise<void>, registry = createDefaultProviderRegistry()): Promise<void> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lingvoice-tts-'));
  try {
    const providers = new ProviderService(path.join(directory, 'providers.json'), vault, registry);
    const provider = await providers.save({ name: 'Saved', adapter: registry.list()[0].id, baseUrl: 'https://example.com/proxy', apiKey: 'private-secret' });
    const file = path.join(directory, 'tts.json');
    await action(new TtsService(file, providers, vault), providers, file, provider.id);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

test('speech settings defaults, strict validation, persistence and copies contain no credentials', async () => {
  await fixture(async (service, providers, file, id) => {
    assert.deepEqual(await service.getConfig(), { settings: defaultTtsSettings, hasApiKey: false });
    const config = { settings: { ...defaultTtsSettings, providerId: id, model: ' custom-model ', voice: 'custom-voice', speed: 0.25, fullUrl: true } };
    const saved = await service.saveConfig(config);
    assert.equal(saved.settings.model, 'custom-model');
    saved.settings.voice = 'mutated';
    assert.equal((await service.getConfig()).settings.voice, 'custom-voice');
    assert.deepEqual(await new TtsService(file, providers, vault).getConfig(), { settings: { ...config.settings, model: 'custom-model' }, hasApiKey: false });
    assert.equal((await fs.readFile(file, 'utf8')).includes('private-secret'), false);
    for (const patch of [{ speed: 0.24 }, { speed: 4.01 }, { speed: NaN }, { speed: Infinity }, { speed: '1' }, { fullUrl: 1 }, { model: '' }, { model: 'x'.repeat(201) }, { voice: '\n' }, { providerId: 'bad id' }, { baseUrl: 'https://override' }]) {
      await assert.rejects(service.saveConfig({ settings: { ...config.settings, ...patch } } as TtsConfigUpdate));
    }
    const withCustomKey = await service.saveConfig({ ...config, apiKey: 'custom-key' });
    assert.equal(withCustomKey.hasApiKey, true);
    assert.equal((await service.getConfig()).hasApiKey, true);
    const clearedKey = await service.saveConfig({ ...config, apiKey: '' });
    assert.equal(clearedKey.hasApiKey, false);
    const incompatible = await providers.save({ name: 'Machine', adapter: 'libretranslate', baseUrl: 'http://localhost:5000' });
    await assert.rejects(service.saveConfig({ settings: { ...defaultTtsSettings, providerId: incompatible.id } }), /does not support/);
    await assert.rejects(service.saveConfig({ settings: { ...defaultTtsSettings, providerId: 'missing' } }), /does not exist/);
    await service.saveConfig({ settings: { ...defaultTtsSettings, speed: 4 } });
  });
});

test('speech atomic writes serialize and failed persistence preserves committed state', async () => {
  await fixture(async (service, _providers, file, id) => {
    await Promise.all([1, 2, 3].map(speed => service.saveConfig({ settings: { ...defaultTtsSettings, providerId: id, speed } })));
    assert.equal((await service.getConfig()).settings.speed, 3);
    await fs.rm(file); await fs.mkdir(file);
    await assert.rejects(service.saveConfig({ settings: defaultTtsSettings }), /Unable to save/);
    assert.equal((await service.getConfig()).settings.speed, 3);
    assert.deepEqual((await fs.readdir(path.dirname(file))).filter(name => name.endsWith('.tmp')), []);
    await fs.rm(file, { recursive: true });
    await service.saveConfig({ settings: defaultTtsSettings });
    assert.deepEqual(await service.getConfig(), { settings: defaultTtsSettings, hasApiKey: false });
  });
});

test('corrupt speech files and filesystem errors have sanitized errors', async () => {
  await fixture(async (_service, providers, file) => {
    for (const value of ['private-secret', '{"settings":{"private-secret":true}}']) {
      await fs.writeFile(file, value);
      await assert.rejects(new TtsService(file, providers).getConfig(), /Invalid saved speech configuration/);
    }
    await fs.rm(file); await fs.mkdir(file);
    await assert.rejects(new TtsService(file, providers).getConfig(), /Unable to read speech configuration/);
  });
});

test('speech uses saved URL, key and settings, sends mp3 body, and returns binary audio', async t => {
  await fixture(async (service, _providers, _file, id) => {
    await service.saveConfig({ settings: { ...defaultTtsSettings, providerId: id, speed: 1.5 } });
    const fetchMock = t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
      assert.equal(url, 'https://example.com/proxy/v1/audio/speech');
      assert.equal(init.method, 'POST'); assert.equal(init.redirect, 'error');
      assert.deepEqual(init.headers, { 'Content-Type': 'application/json', Authorization: 'Bearer private-secret' });
      assert.deepEqual(JSON.parse(init.body as string), { model: 'tts-1', input: 'Hello\n世界', voice: 'alloy', speed: 1.5, response_format: 'mp3' });
      return audio();
    });
    assert.deepEqual(await service.generate({ text: 'Hello\n世界' }), { mimeType: 'audio/mpeg', fileName: 'speech.mp3', audioBase64: Buffer.from([73, 68, 51, 1]).toString('base64') });
    assert.equal(fetchMock.mock.callCount(), 1); assert.equal(service.busy, false);
    await service.saveConfig({ settings: { ...defaultTtsSettings, providerId: id, speed: 1.5 }, apiKey: 'override-secret' });
    let overrideUsed = false;
    t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
      assert.equal((init.headers as Record<string, string>).Authorization, 'Bearer override-secret');
      overrideUsed = true;
      return audio();
    });
    await service.generate({ text: 'Overridden key' });
    assert.equal(overrideUsed, true);
  });
});

test('build-only custom TTS handlers receive saved settings without requiring a JSON parser', async t => {
  const registry = new ProviderRegistry();
  registry.register({ info: { id: 'speech-custom', name: 'Speech', capabilities: ['tts'], defaultBaseUrl: 'https://example.com' },
    tts: { build(context, input) {
      assert.equal(context.apiKey, 'private-secret'); assert.equal(input.model, 'custom');
      assert.equal(input.voice, 'custom-voice'); assert.equal(input.text, 'Hello');
      return { url: `${context.baseUrl}/custom-speech`, init: { method: 'POST', body: 'custom request' } };
    } } });
  await fixture(async (service, _providers, _file, id) => {
    await service.saveConfig({ settings: { ...defaultTtsSettings, providerId: id, model: 'custom', voice: 'custom-voice' } });
    t.mock.method(globalThis, 'fetch', async (url: string) => {
      assert.equal(url, 'https://example.com/proxy/custom-speech');
      return new Response('audio', { headers: { 'content-type': 'Audio/MP3; charset=binary' } });
    });
    assert.equal((await service.generate({ text: 'Hello' })).mimeType, 'audio/mpeg');
  }, registry);
  assert.throws(() => new ProviderRegistry().register({ info: { id: 'invalid', name: 'Invalid', capabilities: ['models'], defaultBaseUrl: 'https://example.com' }, models: { build: () => ({ url: '', init: {} }) } } as never));
});

test('speech rejects empty, long or malformed text and all request overrides before any network', async t => {
  t.mock.method(globalThis, 'fetch', () => { throw new Error('Unexpected network'); });
  await fixture(async service => {
    for (const request of [null, [], {}, { text: '' }, { text: '  ' }, { text: 2 }, { text: 'x'.repeat(4097) }, { text: '\0' }, { text: 'Hello', speed: 2 }, { text: 'Hello', providerId: 'override' }, { text: 'Hello', apiKey: 'private-secret' }]) {
      await assert.rejects(service.generate(request as TtsRequest), /without settings overrides/);
      assert.equal(service.busy, false);
    }
    await assert.rejects(service.generate({ text: 'Hello' }), /Speech generation failed/);
  });
});

test('speech accepts exact text and audio limits, and validates actual and declared byte bounds', async t => {
  await fixture(async (service, _providers, _file, id) => {
    await service.saveConfig({ settings: { ...defaultTtsSettings, providerId: id } });
    const limit = 10 * 1024 * 1024;
    const fetchMock = t.mock.method(globalThis, 'fetch', async () => new Response(new Uint8Array(limit), { headers: { 'content-type': 'audio/mpeg' } }));
    assert.equal(Buffer.from((await service.generate({ text: 'x'.repeat(4096) })).audioBase64, 'base64').length, limit);
    for (const makeResponse of [
      () => new Response('private-secret', { status: 401, headers: { 'content-type': 'application/json' } }),
      () => new Response('{"error":"private-secret"}', { headers: { 'content-type': 'application/json' } }),
      () => new Response('private-secret'),
      () => new Response(null, { headers: { 'content-type': 'audio/mpeg' } }),
      () => new Response(new Uint8Array(), { headers: { 'content-type': 'audio/mpeg' } }),
      () => new Response('audio', { headers: { 'content-type': 'audio/mpeg', 'content-length': String(limit + 1) } }),
      () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(limit)); controller.enqueue(new Uint8Array(1)); controller.close(); } }), { headers: { 'content-type': 'audio/mpeg', 'content-length': '1' } }),
    ]) {
      fetchMock.mock.mockImplementation(async () => makeResponse());
      await assert.rejects(service.generate({ text: 'Hello' }), error => error instanceof Error && /Speech generation failed/.test(error.message) && !error.message.includes('private-secret'));
      assert.equal(service.busy, false);
    }
    fetchMock.mock.mockImplementation(async () => { throw new Error('private-secret URL request detail'); });
    await assert.rejects(service.generate({ text: 'Hello' }), error => error instanceof Error && !error.message.includes('private-secret'));
  });
});

test('speech busy and cancellation release promptly even if fetch ignores AbortSignal', async t => {
  await fixture(async (service, _providers, _file, id) => {
    await service.saveConfig({ settings: { ...defaultTtsSettings, providerId: id } });
    const entered = deferred<void>();
    const blocked = deferred<Response>();
    const fetchMock = t.mock.method(globalThis, 'fetch', () => { entered.resolve(); return blocked.promise; });
    const pending = service.generate({ text: 'Hello' });
    assert.equal(service.busy, true);
    await assert.rejects(service.generate({ text: 'Other' }), /already in progress/);
    await entered.promise;
    const rejection = assert.rejects(pending, /cancelled/);
    service.cancel(); await rejection;
    assert.equal(service.busy, false);
    fetchMock.mock.mockImplementation(async () => audio());
    assert.equal((await service.generate({ text: 'Retry' })).fileName, 'speech.mp3');
    blocked.resolve(audio());
    service.cancel();
  });
});

test('speech cancellation while reading cancels the stream and permits another request', async t => {
  await fixture(async (service, _providers, _file, id) => {
    await service.saveConfig({ settings: { ...defaultTtsSettings, providerId: id } });
    const reading = deferred<void>(); let cancelled = false;
    t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({ pull() { reading.resolve(); }, cancel() { cancelled = true; } }), { headers: { 'content-type': 'audio/mpeg' } }));
    const pending = service.generate({ text: 'Hello' });
    await reading.promise;
    const rejection = assert.rejects(pending, /cancelled/);
    service.cancel(); await rejection;
    assert.equal(cancelled, true); assert.equal(service.busy, false);
  });
});

test('speech timeout aborts at 120 seconds and resets busy deterministically', async t => {
  await fixture(async (service, _providers, _file, id) => {
    await service.saveConfig({ settings: { ...defaultTtsSettings, providerId: id } });
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const entered = deferred<void>();
    let signal: AbortSignal | undefined;
    t.mock.method(globalThis, 'fetch', (_url: string, init: RequestInit) => { signal = init.signal!; entered.resolve(); return new Promise<Response>(() => {}); });
    const pending = service.generate({ text: 'Hello' });
    await entered.promise;
    t.mock.timers.tick(119_999); assert.equal(service.busy, true); assert.equal(signal!.aborted, false);
    const rejection = assert.rejects(pending, /timed out/);
    t.mock.timers.tick(1); await rejection;
    assert.equal(signal!.aborted, true); assert.equal(service.busy, false);
  });
});
