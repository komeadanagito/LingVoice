import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { ProviderRegistry, ProviderService, createDefaultProviderRegistry, type ProviderAdapter, type TranslationInput } from '../src/main/providers';
import type { ProviderUpdate } from '../src/shared/providers';

const vault = {
  encrypt: (value: string) => `encrypted:${Buffer.from(value).toString('base64')}`,
  decrypt: (value: string) => {
    if (!value.startsWith('encrypted:')) throw new Error('private vault detail');
    return Buffer.from(value.slice(10), 'base64').toString();
  },
};
const context = { baseUrl: 'https://example.com/proxy', apiKey: 'private-key' };
const input: TranslationInput = { texts: ['Hello\nworld', 'Goodbye'], model: 'test-model', protocol: 'chat', fullUrl: false, sourceLanguage: 'auto', targetLanguage: 'zh' };
const update: ProviderUpdate = { name: 'Example', adapter: 'openai-compatible', baseUrl: context.baseUrl };
const chat = (content: string) => ({ choices: [{ message: { content } }] });
async function fixture(action: (service: ProviderService, file: string) => Promise<void>): Promise<void> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lingvoice-providers-'));
  try {
    const file = path.join(directory, 'providers.json');
    await action(new ProviderService(file, vault), file);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
}

test('registry metadata is extensible, copied, and checked against handlers; duplicate ids fail', () => {
  const registry = createDefaultProviderRegistry();
  assert.deepEqual(registry.list().map(item => item.id), ['openai-compatible', 'libretranslate']);
  const adapter: ProviderAdapter = {
    info: { id: 'custom-vendor', name: 'Custom', capabilities: ['models'], defaultBaseUrl: 'http://localhost:3000' },
    models: { build: () => ({ url: 'http://localhost:3000/list', init: {} }), parse: () => [] },
  };
  registry.register(adapter);
  adapter.info.name = 'changed';
  assert.equal(registry.get('custom-vendor').info.name, 'Custom');
  const metadata = registry.list();
  metadata[0].capabilities.length = 0;
  assert.equal(registry.get('openai-compatible').info.capabilities.length, 4);
  assert.throws(() => registry.register(adapter), /already registered/);
  assert.throws(() => registry.get('missing'), /Unknown/);
  for (const bad of [
    { ...adapter, info: { ...adapter.info, capabilities: [] } },
    { ...adapter, info: { ...adapter.info, capabilities: ['models', 'models'] } },
    { ...adapter, info: { ...adapter.info, capabilities: ['video'] } },
    { ...adapter, info: { ...adapter.info, capabilities: ['translation'] } },
    { ...adapter, models: undefined },
    { ...adapter, info: { ...adapter.info, defaultBaseUrl: 'file:///private' } },
    { ...adapter, models: { build: 1, parse: () => [] } },
  ]) assert.throws(() => new ProviderRegistry().register(bad as ProviderAdapter));
});

test('OpenAI translation builds chat and Responses with strict ordered JSON parsing and no network', t => {
  t.mock.method(globalThis, 'fetch', () => { throw new Error('Unexpected network'); });
  const adapter = createDefaultProviderRegistry().get('openai-compatible').translation!;
  const request = adapter.build(context, input);
  assert.equal(request.url, 'https://example.com/proxy/v1/chat/completions');
  assert.equal(request.init.method, 'POST');
  assert.equal(request.init.redirect, 'error');
  assert.deepEqual(request.init.headers, { 'Content-Type': 'application/json', Authorization: 'Bearer private-key' });
  const body = JSON.parse(request.init.body as string);
  assert.equal(body.model, 'test-model');
  assert.match(body.messages[0].content, /exactly 2 elements/);
  assert.deepEqual(JSON.parse(body.messages[1].content), input.texts);
  assert.deepEqual(adapter.parse(chat('```json\n["你好\\n世界","再见"]\n```'), 2), ['你好\n世界', '再见']);
  const responses = adapter.build({ ...context, baseUrl: 'https://example.com/v1/' }, { ...input, protocol: 'responses' });
  assert.equal(responses.url, 'https://example.com/v1/responses');
  const responseBody = JSON.parse(responses.init.body as string);
  assert.equal(responseBody.input, JSON.stringify(input.texts));
  assert.equal(typeof responseBody.instructions, 'string');
  assert.equal(responseBody.messages, undefined);
  assert.deepEqual(adapter.parse({ output_text: '["a","b"]' }, 2), ['a', 'b']);
  assert.deepEqual(adapter.parse({ output: [{ type: 'reasoning' }, { type: 'message', content: [{ type: 'output_text', text: '["a","b"]' }] }] }, 2), ['a', 'b']);
  const exact = 'https://example.com/custom/%61?version=2026';
  assert.equal(adapter.build({ ...context, baseUrl: exact }, { ...input, fullUrl: true }).url, exact);
  for (const value of ['private-response', '["a"]', '[42,42]', '["", "b"]', '{"secret":"private-response"}']) {
    assert.throws(() => adapter.parse(chat(value), 2), error => error instanceof Error && !error.message.includes('private-response'));
  }
  assert.throws(() => adapter.parse({}, 2));
});

test('OpenAI ASR builds multipart verbose timestamp requests and requires segments', async () => {
  const adapter = createDefaultProviderRegistry().get('openai-compatible').asr!;
  const wav = new Uint8Array([82, 73, 70, 70]);
  const input = { wav, model: 'whisper-1', language: 'zh', prompt: 'Names', fullUrl: false };
  const request = adapter.build(context, input);
  assert.equal(request.url, 'https://example.com/proxy/v1/audio/transcriptions');
  assert.deepEqual(request.init.headers, { Authorization: 'Bearer private-key' });
  const form = request.init.body as FormData;
  assert.equal(form.get('model'), 'whisper-1');
  assert.equal(form.get('response_format'), 'verbose_json');
  assert.deepEqual(form.getAll('timestamp_granularities[]'), ['segment']);
  assert.equal(form.get('language'), 'zh'); assert.equal(form.get('prompt'), 'Names');
  const file = form.get('file') as File;
  assert.equal(file.type, 'audio/wav'); assert.equal(file.name, 'audio.wav');
  assert.deepEqual(new Uint8Array(await file.arrayBuffer()), wav);
  const empty = adapter.build({ ...context, apiKey: '' }, { ...input, language: '', prompt: '' }).init.body as FormData;
  assert.equal(empty.has('language'), false); assert.equal(empty.has('prompt'), false);
  const exact = 'https://example.com/complete?version=1';
  assert.equal(adapter.build({ ...context, baseUrl: exact }, { ...input, fullUrl: true }).url, exact);
  const value = { segments: [{ start: 0, end: 1, text: 'Hello' }], language: 'en' };
  assert.deepEqual(adapter.parse(value), value);
  assert.throws(() => adapter.parse({ text: 'Hello' }), /timestamped segments/);
  assert.throws(() => adapter.parse(null));
});

test('model discovery derives versioned and migrated sibling endpoints and validates unique models', () => {
  const models = createDefaultProviderRegistry().get('openai-compatible').models!;
  for (const [baseUrl, expected] of [
    ['https://example.com', 'https://example.com/v1/models'],
    ['https://example.com/proxy/v1/', 'https://example.com/proxy/v1/models'],
    ['https://example.com/proxy/v2/responses?api-version=1', 'https://example.com/proxy/v2/models?api-version=1'],
    ['https://example.com/v1/chat/completions', 'https://example.com/v1/models'],
    ['https://example.com/v1/audio/transcriptions', 'https://example.com/v1/models'],
  ]) {
    const request = models.build({ ...context, baseUrl });
    assert.equal(request.url, expected); assert.equal(request.init.method, 'GET');
  }
  assert.deepEqual(models.parse({ data: [{ id: 'z' }, { id: 'a' }, { id: 'a' }] }), ['a', 'z']);
  for (const value of [null, {}, { data: [1] }, { data: [{ id: '' }] }, { data: [{ id: 'bad\nmodel' }] }]) assert.throws(() => models.parse(value));
});

test('LibreTranslate sends arrays, language options, optional body key, and ignores model', () => {
  const provider = createDefaultProviderRegistry().get('libretranslate');
  assert.equal(provider.asr, undefined); assert.equal(provider.models, undefined);
  const adapter = provider.translation!;
  const request = adapter.build({ ...context, baseUrl: 'http://localhost:5000/custom/translate/' }, { ...input, model: '', sourceLanguage: 'en' });
  assert.equal(request.url, 'http://localhost:5000/custom/translate');
  assert.deepEqual(request.init.headers, { 'Content-Type': 'application/json' });
  assert.deepEqual(JSON.parse(request.init.body as string), { q: input.texts, source: 'en', target: 'zh', format: 'text', api_key: 'private-key' });
  assert.deepEqual(adapter.parse({ translatedText: ['a', 'b'] }, 2), ['a', 'b']);
  assert.throws(() => adapter.parse({ translatedText: 'a' }, 1));
  const anonymous = adapter.build({ ...context, apiKey: '' }, input);
  assert.equal(JSON.parse(anonymous.init.body as string).api_key, undefined);
});

test('provider persistence generates ids, hides keys, retains and clears ciphertext and returns copies', async () => {
  await fixture(async (service, file) => {
    assert.deepEqual((await service.list()).providers, []);
    const provider = await service.save({ ...update, apiKey: 'private-key' });
    assert.match(provider.id, /^[\da-f-]{36}$/); assert.equal(provider.hasApiKey, true);
    assert.equal(JSON.stringify(provider).includes('private-key'), false);
    assert.equal((await fs.readFile(file, 'utf8')).includes('private-key'), false);
    provider.name = 'mutated';
    const reloaded = new ProviderService(file, vault);
    assert.equal((await reloaded.list()).providers[0].name, 'Example');
    assert.equal((await reloaded.resolve(provider.id, 'translation')).context.apiKey, 'private-key');
    const retained = await reloaded.save({ ...update, id: provider.id, name: 'Renamed' });
    assert.equal(retained.hasApiKey, true);
    const cleared = await reloaded.save({ ...update, id: provider.id, apiKey: '' });
    assert.equal(cleared.hasApiKey, false);
    assert.equal((await reloaded.resolve(provider.id, 'asr')).context.apiKey, '');
    const catalog = await reloaded.list(); catalog.providers[0].name = 'changed';
    assert.equal((await reloaded.list()).providers[0].name, 'Example');
    await reloaded.remove(provider.id);
    assert.deepEqual((await new ProviderService(file, vault).list()).providers, []);
    await assert.rejects(reloaded.resolve(provider.id, 'translation'), /does not exist/);
  });
});

test('concurrent writes serialize, failed persistence preserves state, and queue recovers', async () => {
  await fixture(async (service, file) => {
    const providers = await Promise.all(Array.from({ length: 8 }, (_, index) => service.save({ ...update, name: `Provider ${index}` })));
    assert.equal((await service.list()).providers.length, 8);
    await Promise.all([
      service.save({ ...update, id: providers[0].id, apiKey: 'retained' }),
      service.save({ ...update, id: providers[0].id, name: 'Last' }),
    ]);
    const committed = await service.list();
    assert.equal(committed.providers[0].name, 'Last'); assert.equal(committed.providers[0].hasApiKey, true);
    await fs.rm(file); await fs.mkdir(file);
    await assert.rejects(service.save({ ...update, id: providers[0].id, name: 'failed' }), /Unable to save/);
    assert.deepEqual(await service.list(), committed);
    assert.deepEqual((await fs.readdir(path.dirname(file))).filter(item => item.endsWith('.tmp')), []);
    await fs.rm(file, { recursive: true });
    await service.save({ ...update, id: providers[0].id, name: 'Recovered' });
    assert.equal((await service.list()).providers[0].name, 'Recovered');
  });
});

test('runtime metadata, key, URL, capability and provider limit checks are enforced', async () => {
  await fixture(async service => {
    for (const patch of [
      { name: '' }, { name: 'x'.repeat(201) }, { name: 'bad\nname' }, { adapter: 'missing' }, { adapter: 42 },
      { baseUrl: 'file:///secret' }, { baseUrl: 'https://user:pass@example.com' }, { baseUrl: 'https://example.com/#' },
      { apiKey: 42 }, { apiKey: 'bad\r\nheader' }, { apiKey: 'x'.repeat(8193) }, { id: 'missing' },
    ]) await assert.rejects(service.save({ ...update, ...patch } as ProviderUpdate));
    const machine = await service.save({ ...update, adapter: 'libretranslate' });
    await assert.rejects(service.resolve(machine.id, 'asr'), /does not support/);
    await assert.rejects(service.resolve(machine.id, 'models'), /does not support/);
    await assert.rejects(service.resolve(machine.id, 'video' as 'asr'), /Invalid/);
    await service.resolve(machine.id, 'translation');
    for (let i = 1; i < 50; i++) await service.save(update);
    await assert.rejects(service.save(update), /limit/);
    await service.save({ ...update, id: machine.id });
  });
});

test('corrupt files and vault errors are sanitized, and failed encryption does not commit', async () => {
  await fixture(async (service, file) => {
    await fs.writeFile(file, '{private-secret');
    await assert.rejects(service.list(), /Invalid saved/);
    await fs.rm(file);
    const broken = new ProviderService(file, { encrypt() { throw new Error('private-secret'); }, decrypt() { throw new Error('private-secret'); } });
    await assert.rejects(broken.save({ ...update, apiKey: 'private-secret' }), error => error instanceof Error && !error.message.includes('private-secret'));
    assert.deepEqual((await broken.list()).providers, []);
    const saved = await service.save({ ...update, apiKey: 'secret' });
    await assert.rejects(new ProviderService(file, { ...vault, decrypt() { throw new Error('private-secret'); } }).resolve(saved.id, 'asr'), /Unable to decrypt/);
    const value = JSON.parse(await fs.readFile(file, 'utf8'));
    value.providers.push(value.providers[0]);
    await fs.writeFile(file, JSON.stringify(value));
    await assert.rejects(new ProviderService(file, vault).list(), /Invalid saved/);
  });
});

test('legacy migration copies both translation engines and ASR ciphertext once without decrypting or deleting', async () => {
  await fixture(async (_service, file) => {
    const translation = path.join(path.dirname(file), 'translation.json');
    const asr = path.join(path.dirname(file), 'asr.json');
    const translationContent = JSON.stringify({ settings: { engine: 'machine', fullUrl: true, baseUrl: 'https://example.com/v1/responses', machineUrl: 'http://localhost:5000/translate' }, apiKey: vault.encrypt('llm-key'), machineKey: vault.encrypt('machine-key') });
    const asrContent = JSON.stringify({ settings: { baseUrl: 'https://example.com/v1/audio/transcriptions', fullUrl: true }, apiKey: vault.encrypt('asr-key') });
    await fs.writeFile(translation, translationContent); await fs.writeFile(asr, asrContent);
    const migrationVault = { encrypt() { throw new Error('Must not re-encrypt'); }, decrypt() { throw new Error('Must not decrypt'); } };
    const service = new ProviderService(file, migrationVault);
    await service.list(); // Listing a missing catalog must not suppress migration.
    await service.importLegacy({ translation, asr });
    assert.deepEqual((await service.list()).providers.map(item => item.id), ['legacy-translation-llm', 'legacy-translation-machine', 'legacy-asr']);
    const reloaded = new ProviderService(file, vault);
    for (const [id, capability, key] of [
      ['legacy-translation-llm', 'translation', 'llm-key'], ['legacy-translation-machine', 'translation', 'machine-key'], ['legacy-asr', 'asr', 'asr-key'],
    ] as const) assert.equal((await reloaded.resolve(id, capability)).context.apiKey, key);
    assert.equal((await reloaded.resolve('legacy-translation-llm', 'translation')).context.baseUrl, 'https://example.com/v1/responses');
    assert.equal(await fs.readFile(translation, 'utf8'), translationContent); assert.equal(await fs.readFile(asr, 'utf8'), asrContent);
    await reloaded.remove('legacy-asr');
    await reloaded.importLegacy({ translation, asr });
    assert.equal((await reloaded.list()).providers.length, 2);
  });
});

test('migration creates only existing legacy sources and records an empty first-run migration', async () => {
  await fixture(async (service, file) => {
    const files = { translation: path.join(path.dirname(file), 'translation.json'), asr: path.join(path.dirname(file), 'asr.json') };
    await service.importLegacy(files);
    assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), { providers: [] });
    await fs.writeFile(files.asr, JSON.stringify({ settings: { baseUrl: context.baseUrl, fullUrl: false }, apiKey: '' }));
    await service.importLegacy(files);
    assert.deepEqual((await service.list()).providers, []);
    await fs.rm(file);
    const next = new ProviderService(file, vault);
    await next.importLegacy(files);
    assert.deepEqual((await next.list()).providers.map(item => item.id), ['legacy-asr']);
  });
});

test('OpenAI speech builds mp3 requests and preserves exact full URL semantics', () => {
  const adapter = createDefaultProviderRegistry().get('openai-compatible').tts!;
  const input = { text: 'Hello', model: 'tts-1', voice: 'alloy', speed: 0.25, fullUrl: false };
  const request = adapter.build(context, input);
  assert.equal(request.url, 'https://example.com/proxy/v1/audio/speech');
  assert.deepEqual(JSON.parse(request.init.body as string), { model: 'tts-1', input: 'Hello', voice: 'alloy', speed: 0.25, response_format: 'mp3' });
  assert.equal(request.init.method, 'POST'); assert.equal(request.init.redirect, 'error');
  assert.deepEqual(request.init.headers, { 'Content-Type': 'application/json', Authorization: 'Bearer private-key' });
  const exact = 'https://example.com/custom/%61?api-version=2026';
  assert.equal(adapter.build({ ...context, baseUrl: exact }, { ...input, fullUrl: true }).url, exact);
  assert.equal(createDefaultProviderRegistry().get('openai-compatible').models!.build({ ...context, baseUrl: 'https://example.com/v1/audio/speech?version=1' }).url, 'https://example.com/v1/models?version=1');
});

test('generic model discovery uses the explicit saved provider and bounded JSON with sanitized failures', async t => {
  await fixture(async service => {
    const provider = await service.save({ ...update, apiKey: 'private-key' });
    const fetchMock = t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
      assert.equal(url, 'https://example.com/proxy/v1/models');
      assert.equal(init.redirect, 'error');
      assert.deepEqual(init.headers, { Authorization: 'Bearer private-key' });
      return Response.json({ data: [{ id: 'z' }, { id: 'a' }, { id: 'z' }] });
    });
    assert.deepEqual(await service.models(provider.id), ['a', 'z']);
    for (const makeResponse of [
      () => new Response('private-key', { status: 403 }),
      () => new Response('private-key'),
      () => Response.json({ data: [{ id: 'bad\nmodel' }] }),
      () => new Response('{}', { headers: { 'content-length': String(2 * 1024 * 1024 + 1) } }),
      () => new Response(new Uint8Array(2 * 1024 * 1024 + 1), { headers: { 'content-length': '1' } }),
    ]) {
      fetchMock.mock.mockImplementation(async () => makeResponse());
      await assert.rejects(service.models(provider.id), error => error instanceof Error && /Unable to load provider models/.test(error.message) && !error.message.includes('private-key'));
    }
    fetchMock.mock.mockImplementation(async () => { throw new Error('private-key provider body'); });
    await assert.rejects(service.models(provider.id), error => error instanceof Error && !error.message.includes('private-key'));
    const incompatible = await service.save({ ...update, adapter: 'libretranslate' });
    await assert.rejects(service.models(incompatible.id), /Unable to load provider models/);
    await assert.rejects(service.models('missing'), /Unable to load provider models/);
  });
});

test('generic model discovery times out at 30 seconds even when fetch ignores cancellation', async t => {
  await fixture(async service => {
    const provider = await service.save(update);
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    let signal: AbortSignal | undefined;
    t.mock.method(globalThis, 'fetch', (_url: string, init: RequestInit) => {
      signal = init.signal!; entered(); return new Promise<Response>(() => {});
    });
    const request = service.models(provider.id);
    await started;
    t.mock.timers.tick(29_999); assert.equal(signal!.aborted, false);
    const rejection = assert.rejects(request, /timed out/);
    t.mock.timers.tick(1); await rejection;
    assert.equal(signal!.aborted, true);
  });
});
