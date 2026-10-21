import { test, type TestContext } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { TranslationService } from '../src/main/translation';
import { defaultTranslationSettings, type TranslationSettings, type TranslationRequest } from '../src/shared/translation';

const vault = {
  encrypt: (value: string) => `encrypted:${Buffer.from(value).toString('base64')}`,
  decrypt: (value: string) => {
    if (!value.startsWith('encrypted:')) throw new Error('secret vault failure');
    return Buffer.from(value.slice(10), 'base64').toString();
  },
};
async function fixture(action: (service: TranslationService, file: string) => Promise<void>): Promise<void> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lingvoice-translation-'));
  try {
    const file = path.join(directory, 'translation.json');
    await action(new TranslationService(file, vault), file);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
}
function mockFetch(t: TestContext, callback: (url: string, init: RequestInit) => unknown): void {
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request, init?: RequestInit) => {
    const result = callback(String(url), init!);
    return Response.json(result);
  });
}
const configured = (changes: Partial<TranslationSettings> = {}): TranslationSettings => ({ ...defaultTranslationSettings, ...changes });
const chat = (content: string) => ({ choices: [{ message: { content } }] });

test('default configuration is copied and secrets are encrypted, retained, cleared and never returned', async () => {
  await fixture(async (service, file) => {
    const initial = await service.getConfig();
    assert.deepEqual(initial, { settings: defaultTranslationSettings, hasApiKey: false, hasMachineKey: false });
    initial.settings.model = 'mutated';
    assert.equal((await service.getConfig()).settings.model, defaultTranslationSettings.model);
    const saved = await service.saveConfig({ settings: configured(), apiKey: 'private-api-key', machineKey: 'private-machine-key' });
    assert.equal(saved.hasApiKey, true);
    assert.equal(saved.hasMachineKey, true);
    assert.ok(!JSON.stringify(saved).includes('private'));
    const disk = await fs.readFile(file, 'utf8');
    assert.ok(!disk.includes('private-api-key'));
    assert.ok(!disk.includes('private-machine-key'));
    const reloaded = new TranslationService(file, vault);
    assert.deepEqual(await reloaded.getConfig(), saved);
    assert.equal((await reloaded.saveConfig({ settings: configured({ displayName: 'Renamed' }) })).hasApiKey, true);
    const cleared = await reloaded.saveConfig({ settings: configured(), apiKey: '', machineKey: '' });
    assert.equal(cleared.hasApiKey, false);
    assert.equal(cleared.hasMachineKey, false);
  });
});

test('concurrent updates serialize and failed persistence retains committed configuration', async () => {
  await fixture(async (service, file) => {
    await Promise.all([
      service.saveConfig({ settings: configured({ model: 'first' }), apiKey: 'retained' }),
      service.saveConfig({ settings: configured({ model: 'last' }), machineKey: 'machine' }),
    ]);
    const committed = await service.getConfig();
    assert.equal(committed.settings.model, 'last');
    assert.equal(committed.hasApiKey, true);
    assert.equal(committed.hasMachineKey, true);
    await fs.rm(file);
    await fs.mkdir(file);
    await assert.rejects(service.saveConfig({ settings: configured({ model: 'failed' }), apiKey: '' }), /Unable to save/);
    assert.deepEqual(await service.getConfig(), committed);
    assert.deepEqual((await fs.readdir(path.dirname(file))).filter(name => name.endsWith('.tmp')), []);
    await fs.rm(file, { recursive: true });
    await service.saveConfig({ settings: configured({ model: 'recovered' }) });
    assert.equal((await service.getConfig()).settings.model, 'recovered');
  });
});

test('runtime settings, keys, URLs and request limits are validated before network access', async t => {
  mockFetch(t, () => { assert.fail('unexpected network access'); });
  await fixture(async service => {
    for (const bad of ['file:///tmp/test', 'ftp://example.com', 'https://user:pass@example.com', 'https://example.com/#fragment', 'https://example.com/#', 'not-url']) {
      await assert.rejects(service.saveConfig({ settings: configured({ baseUrl: bad }) }), /Invalid/);
      await assert.rejects(service.saveConfig({ settings: configured({ machineUrl: bad }) }), /Invalid/);
    }
    for (const patch of [{ engine: 'unknown' }, { protocol: 'unknown' }, { fullUrl: 'true' }, { targetLanguage: '' }, { displayName: 'x'.repeat(201) }, { model: 42 }]) {
      await assert.rejects(service.saveConfig({ settings: configured(patch as Partial<TranslationSettings>) }), /Invalid/);
    }
    await assert.rejects(service.saveConfig({ settings: configured(), apiKey: 12 as unknown as string }), /Invalid/);
    for (const request of [null, {}, { texts: [] }, { texts: [''] }, { texts: ['  '] }, { texts: [1] }, { texts: Array(41).fill('x') }, { texts: ['x'.repeat(20001)] }, { texts: ['x'.repeat(10001), 'x'.repeat(10000)] }, { texts: ['x'], settings: {} }]) {
      await assert.rejects(service.translate(request as TranslationRequest));
    }
    await service.saveConfig({ settings: configured({ baseUrl: 'http://localhost:1234' }) });
  });
});

test('chat batches ordered input and parses fenced arrays using saved settings and encrypted key', async t => {
  mockFetch(t, (url, init) => {
    assert.equal(url, 'https://example.com/proxy/v1/chat/completions');
    assert.equal(init.redirect, 'error');
    assert.equal((init.headers as Record<string, string>).Authorization, 'Bearer private-key');
    assert.ok(init.signal);
    const body = JSON.parse(init.body as string);
    assert.equal(body.model, 'my-model');
    assert.deepEqual(JSON.parse(body.messages[1].content), ['Hello\nworld', 'Goodbye']);
    return chat('```json\n["你好\\n世界","再见"]\n```');
  });
  await fixture(async service => {
    await service.saveConfig({ settings: configured({ baseUrl: 'https://example.com/proxy/', model: 'my-model' }), apiKey: 'private-key' });
    assert.deepEqual(await service.translate({ texts: ['Hello\nworld', 'Goodbye'] }), ['你好\n世界', '再见']);
  });
});

test('base URLs normalize v1, full endpoints are preserved, and model lists derive sibling endpoints', async t => {
  let expected = '';
  let list = false;
  mockFetch(t, (url, init) => {
    assert.equal(url, expected);
    assert.equal(init.method, list ? 'GET' : 'POST');
    return list ? { data: [{ id: 'z' }, { id: 'a' }, { id: 'a' }] } : chat('["translated"]');
  });
  await fixture(async service => {
    for (const [baseUrl, fullUrl, completion, modelUrl] of [
      ['https://example.com', false, 'https://example.com/v1/chat/completions', 'https://example.com/v1/models'],
      ['https://example.com/v1/', false, 'https://example.com/v1/chat/completions', 'https://example.com/v1/models'],
      ['https://example.com/proxy/v1/chat/completions?api-version=1', true, 'https://example.com/proxy/v1/chat/completions?api-version=1', 'https://example.com/proxy/v1/models?api-version=1'],
      ['https://example.com/v1/responses', true, 'https://example.com/v1/responses', 'https://example.com/v1/models'],
    ] as const) {
      await service.saveConfig({ settings: configured({ baseUrl, fullUrl }) });
      expected = completion; list = false;
      await service.translate({ texts: ['original'] });
      expected = modelUrl; list = true;
      assert.deepEqual(await service.models(), ['a', 'z']);
    }
  });
});

test('responses protocol supports output content and output_text', async t => {
  let direct = false;
  mockFetch(t, (url, init) => {
    assert.equal(url, 'http://localhost:1234/v1/responses');
    const body = JSON.parse(init.body as string);
    assert.equal(body.input, '["Hello"]');
    assert.equal(typeof body.instructions, 'string');
    assert.equal(body.messages, undefined);
    return direct ? { output_text: '["你好"]' } : { output: [{ type: 'reasoning' }, { type: 'message', content: [{ type: 'output_text', text: '["你好"]' }] }] };
  });
  await fixture(async service => {
    await service.saveConfig({ settings: configured({ baseUrl: 'http://localhost:1234/v1', protocol: 'responses' }) });
    assert.deepEqual(await service.translate({ texts: ['Hello'] }), ['你好']);
    direct = true;
    assert.deepEqual(await service.translate({ texts: ['Hello'] }), ['你好']);
  });
});

test('LibreTranslate uses an array, source/target and optional key without bearer authentication', async t => {
  let hasKey = true;
  mockFetch(t, (url, init) => {
    assert.equal(url, 'http://localhost:5000/custom/translate');
    assert.equal((init.headers as Record<string, string>).Authorization, undefined);
    assert.deepEqual(JSON.parse(init.body as string), {
      q: ['Hello', 'Goodbye'], source: 'en', target: 'zh', format: 'text', ...(hasKey ? { api_key: 'machine-secret' } : {}),
    });
    return { translatedText: ['你好', '再见'] };
  });
  await fixture(async service => {
    const settings = configured({ engine: 'machine', machineUrl: 'http://localhost:5000/custom/translate/', sourceLanguage: 'en' });
    await service.saveConfig({ settings, machineKey: 'machine-secret' });
    assert.deepEqual(await service.translate({ texts: ['Hello', 'Goodbye'] }), ['你好', '再见']);
    hasKey = false;
    await service.saveConfig({ settings, machineKey: '' });
    await service.translate({ texts: ['Hello', 'Goodbye'] });
  });
});

test('malformed or mismatched provider output is rejected without echoing response bodies', async t => {
  let response: unknown;
  mockFetch(t, () => response);
  await fixture(async service => {
    for (const output of ['not JSON secret-body', '["one","two"]', '[""]', '[42]', '{"translation":"secret-body"}']) {
      response = chat(output);
      await assert.rejects(service.translate({ texts: ['Hello'] }), error => error instanceof Error && !error.message.includes('secret-body'));
    }
    response = { data: [{ id: 1 }] };
    await assert.rejects(service.models(), /invalid model list/);
    await service.saveConfig({ settings: configured({ engine: 'machine' }) });
    response = { translatedText: 'single instead of array' };
    await assert.rejects(service.translate({ texts: ['Hello'] }), /invalid translations/);
  });
});

test('network, HTTP and JSON failures expose neither secrets nor raw bodies', async t => {
  let kind = 'network';
  t.mock.method(globalThis, 'fetch', async () => {
    if (kind === 'network') throw new Error('private-api-key raw-secret-body');
    if (kind === 'http') return new Response('private-api-key raw-secret-body', { status: 401 });
    return new Response('private-api-key raw-secret-body');
  });
  await fixture(async service => {
    await service.saveConfig({ settings: configured(), apiKey: 'private-api-key' });
    for (kind of ['network', 'http', 'json']) {
      await assert.rejects(service.translate({ texts: ['Hello'] }), error => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /request failed/);
        assert.ok(!error.message.includes('private-api-key') && !error.message.includes('raw-secret-body'));
        assert.equal(error.cause, undefined);
        return true;
      });
    }
  });
});

test('timeout aborts a pending provider request', async t => {
  await fixture(async service => {
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    t.mock.timers.enable({ apis: ['setTimeout'] });
    t.mock.method(globalThis, 'fetch', (_url: unknown, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal!.addEventListener('abort', () => reject(new Error('private timeout detail')), { once: true });
      started();
    }));
    const operation = service.translate({ texts: ['Hello'] });
    await ready;
    t.mock.timers.tick(600000);
    await assert.rejects(operation, /timed out/);
    t.mock.timers.reset();
  });
});

test('corrupt persisted data and vault failures produce sanitized errors', async () => {
  await fixture(async (service, file) => {
    await fs.writeFile(file, '{broken secret-body');
    await assert.rejects(service.getConfig(), /Invalid saved translation configuration/);
    await fs.rm(file);
    const broken = new TranslationService(file, { encrypt() { throw new Error('secret-key'); }, decrypt: vault.decrypt });
    await assert.rejects(broken.saveConfig({ settings: configured(), apiKey: 'secret-key' }), /Unable to securely store/);
    assert.equal((await broken.getConfig()).hasApiKey, false);
    await fs.writeFile(file, JSON.stringify({ settings: configured(), apiKey: 'bad ciphertext', machineKey: '' }));
    const reload = new TranslationService(file, vault);
    await assert.rejects(reload.models(), /Unable to decrypt/);
  });
});
