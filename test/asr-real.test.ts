import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ffmpeg from 'ffmpeg-static';
import { AsrService, pcmWav } from '../src/main/asr';
import { ProviderService } from '../src/main/providers';
import { defaultAsrSettings } from '../src/shared/asr';

test('real FFmpeg extracts local audio and uploads timestamped transcription through the selected provider', { skip: !ffmpeg }, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lingvoice-real-audio-'));
  try {
    const pcm = new Uint8Array(32000);
    const view = new DataView(pcm.buffer);
    for (let index = 0; index < 16000; index++) view.setInt16(index * 2, Math.round(Math.sin(index * 2 * Math.PI * 440 / 16000) * 10000), true);
    const media = path.join(directory, 'audio with spaces.wav');
    await fs.writeFile(media, pcmWav(pcm));
    const vault = { encrypt: (value: string) => Buffer.from(value).toString('base64'), decrypt: (value: string) => Buffer.from(value, 'base64').toString() };
    const providers = new ProviderService(path.join(directory, 'providers.json'), vault);
    const provider = await providers.save({ name: 'Audio test provider', adapter: 'openai-compatible', baseUrl: 'https://asr.example/v1', apiKey: 'test-key' });
    let calls = 0;
    t.mock.method(globalThis, 'fetch', async (address: string, init: RequestInit) => {
      calls++;
      assert.equal(String(address), 'https://asr.example/v1/chat/completions');
      assert.equal(new Headers(init.headers).get('Authorization'), 'Bearer test-key');
      assert.equal(new Headers(init.headers).get('Content-Type'), 'application/json');
      const body = JSON.parse(init.body as string);
      assert.equal(body.model, 'qwen-audio-3.1-asr-flash');
      assert.equal(body.stream, false);
      assert.deepEqual(body.asr_options, { enable_itn: false });
      assert.equal(body.messages.length, 1);
      assert.equal(body.messages[0].role, 'user');
      const audio = body.messages[0].content[0];
      assert.equal(audio.type, 'input_audio');
      assert.match(audio.input_audio.data, /^data:audio\/wav;base64,/);
      const wav = Buffer.from(audio.input_audio.data.split(',')[1], 'base64');
      assert.equal(wav.length, 32044);
      assert.equal(wav.subarray(0, 4).toString(), 'RIFF');
      return Response.json({ segments: [{ start: 0.25, end: 0.75, text: ' Audio test ' }] });
    });
    const progress: string[] = [];
    const service = new AsrService(path.join(directory, 'asr.json'), vault, ffmpeg!, value => progress.push(value.stage), {}, providers);
    await service.saveConfig({ settings: { ...defaultAsrSettings, providerId: provider.id, model: 'qwen-audio-3.1-asr-flash' } });
    assert.deepEqual(await service.transcribe({ file: media }), [{ id: 1, start: 0.25, end: 0.75, text: 'Audio test' }]);
    assert.equal(calls, 1); assert.ok(progress.includes('extracting')); assert.ok(progress.includes('transcribing'));
    assert.equal(service.busy, false);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
