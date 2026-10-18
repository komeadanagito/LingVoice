import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import type { spawn } from 'node:child_process';
import { ProviderRegistry, ProviderService } from '../src/main/providers';
import { TranslationService } from '../src/main/translation';
import { AsrService } from '../src/main/asr';
import { defaultTranslationSettings } from '../src/shared/translation';
import { defaultAsrSettings } from '../src/shared/asr';

const vault = { encrypt: (value: string) => Buffer.from(value).toString('base64'), decrypt: (value: string) => Buffer.from(value, 'base64').toString() };

test('translation and ASR execute a registered custom adapter using the same provider without vendor branches', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lingvoice-provider-integration-'));
  try {
    const registry = new ProviderRegistry();
    registry.register({
      info: { id: 'test-custom', name: 'Custom adapter', capabilities: ['translation', 'asr'], defaultBaseUrl: 'https://custom.example', translationOptions: { model: false, protocols: ['custom-protocol'] } },
      translation: {
        build(context, input) {
          assert.equal(input.protocol, 'custom-protocol');
          return { url: `${context.baseUrl}/translate-custom`, init: { method: 'POST', headers: { 'X-Custom-Key': context.apiKey }, body: JSON.stringify(input.texts) } };
        },
        parse(value) { return (value as { translated: string[] }).translated; },
      },
      asr: {
        build(context, input) {
          assert.ok(input.wav.byteLength > 44);
          return { url: `${context.baseUrl}/speech-custom`, init: { method: 'POST', headers: { 'X-Custom-Key': context.apiKey } } };
        },
        parse(value) { return { segments: (value as { items: unknown[] }).items }; },
      },
    });
    const providers = new ProviderService(path.join(directory, 'providers.json'), vault, registry);
    const provider = await providers.save({ name: 'One shared service', adapter: 'test-custom', baseUrl: 'https://custom.example', apiKey: 'shared-secret' });
    const requests: string[] = [];
    t.mock.method(globalThis, 'fetch', async (address: string, init: RequestInit) => {
      assert.equal(new Headers(init.headers).get('X-Custom-Key'), 'shared-secret');
      requests.push(String(address));
      return Response.json(String(address).endsWith('/translate-custom') ? { translated: ['你好'] } : { items: [{ start: 0, end: 1, text: 'Hello' }] });
    });
    const translation = new TranslationService(path.join(directory, 'translation.json'), vault, providers);
    await translation.saveConfig({ settings: { ...defaultTranslationSettings, providerId: provider.id, protocol: 'custom-protocol' } });
    assert.deepEqual(await translation.translate({ texts: ['Hello'] }), ['你好']);
    const fakeSpawn = ((_executable: string, args: string[]) => {
      const child = new EventEmitter() as EventEmitter & { kill: () => boolean };
      child.kill = () => { child.emit('close', null); return true; };
      void fs.writeFile(args.at(-1)!, Buffer.alloc(32000)).then(() => child.emit('close', 0));
      return child;
    }) as unknown as typeof spawn;
    const asr = new AsrService(path.join(directory, 'asr.json'), vault, 'fake-ffmpeg', () => {}, { spawn: fakeSpawn }, providers);
    await asr.saveConfig({ settings: { ...defaultAsrSettings, providerId: provider.id } });
    const media = path.join(directory, 'local.mp4'); await fs.writeFile(media, 'fixture');
    assert.deepEqual(await asr.transcribe({ file: media }), [{ id: 1, start: 0, end: 1, text: 'Hello' }]);
    assert.deepEqual(requests, ['https://custom.example/translate-custom', 'https://custom.example/speech-custom']);
    await assert.rejects(translation.models(), /capability/);
    await assert.rejects(translation.saveConfig({ settings: { ...defaultTranslationSettings, providerId: provider.id }, apiKey: 'other' }), /Providers/);
    await assert.rejects(asr.saveConfig({ settings: { ...defaultAsrSettings, providerId: provider.id }, apiKey: 'other' }), /Providers/);
    const disk = await fs.readFile(path.join(directory, 'translation.json'), 'utf8');
    assert.ok(!disk.includes('shared-secret'));
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
