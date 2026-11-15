import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { EventEmitter } from 'node:events';
import type { spawn } from 'node:child_process';
import { AsrService, localAsrResponseToCues } from '../src/main/asr';
import { TranslationService } from '../src/main/translation';
import { TtsService } from '../src/main/tts';
import { ProviderService } from '../src/main/providers';
import { LocalPluginManager } from '../src/main/local-plugins';
import { defaultAsrSettings } from '../src/shared/asr';
import { defaultTranslationSettings } from '../src/shared/translation';
import { defaultTtsSettings } from '../src/shared/tts';

const vault = {
  encrypt: (value: string) => `enc:${value}`,
  decrypt: (value: string) => value.slice(4),
};

test('localAsrResponseToCues groups word timestamps into cues, restores punctuation, resolves overlaps and splits unaligned segments', () => {
  const cues = localAsrResponseToCues([
    {
      start: 0,
      end: 5,
      text: 'Hello, world. Next line! [音乐]',
      words: [
        { text: 'Hello', start: 0.1, end: 0.4 },
        { text: 'world', start: 0.45, end: 0.9 },
        { text: 'Next', start: 0.82, end: 1.1 },
        { text: 'line', start: 1.15, end: 1.6 },
      ],
    },
    {
      start: 5,
      end: 9,
      text: '第一句。第二句！',
      words: [],
    },
  ], 10);
  assert.equal(cues.length, 4);
  assert.deepEqual(cues[0], { id: 0, start: 10.1, end: 10.82, text: 'Hello, world.' });
  assert.deepEqual(cues[1], { id: 0, start: 10.82, end: 11.6, text: 'Next line!' });
  assert.equal(cues[2].text, '第一句。');
  assert.equal(cues[3].text, '第二句！');
  assert.ok(cues[2].end <= cues[3].start);
});

test('localAsrResponseToCues heals leading aligner outliers and avoids tiny orphan comma-tails', () => {
  const cues = localAsrResponseToCues([
    {
      start: 0,
      end: 20,
      text: '你们是谁啊？我是说每个人，包括你。',
      words: [
        { text: '你', start: 12.24, end: 12.32 },
        { text: '们', start: 19.44, end: 19.6 },
        { text: '是', start: 19.6, end: 19.68 },
        { text: '谁', start: 19.68, end: 19.84 },
        { text: '啊', start: 19.84, end: 19.92 },
        { text: '我', start: 20.5, end: 20.6 },
        { text: '是', start: 20.6, end: 20.7 },
        { text: '说', start: 20.7, end: 20.8 },
        { text: '每', start: 20.8, end: 20.9 },
        { text: '个', start: 20.9, end: 21.0 },
        { text: '人', start: 21.0, end: 21.1 },
        { text: '包', start: 21.3, end: 21.4 },
        { text: '括', start: 21.4, end: 21.5 },
        { text: '你', start: 21.5, end: 21.6 },
      ],
    },
  ], 0);
  assert.equal(cues.length, 2);
  assert.equal(cues[0].text, '你们是谁啊？');
  assert.ok(cues[0].start > 19.0, `expected outlier '你' snapped near 19.44, got ${cues[0].start}`);
  assert.equal(cues[1].text, '我是说每个人，包括你。');
});

test('AsrService local mode persists mode, writes temp WAV inside inputs/, calls local plugin and cleans up', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lingvoice-local-asr-'));
  try {
    const inputsDir = path.join(dir, 'asr', 'inputs');
    const media = path.join(dir, 'sample.mp4');
    await fs.writeFile(media, 'video-bytes');
    const calls: Array<{ id: string; route: string; payload: Record<string, unknown> }> = [];
    const fakePlugins = {
      inputsDir: () => inputsDir,
      requestJson: async (id: string, route: string, payload: Record<string, unknown>) => {
        calls.push({ id, route, payload });
        const wavPath = path.join(inputsDir, String(payload.audio_path));
        const stat = await fs.stat(wavPath);
        assert.ok(stat.size > 44);
        return {
          segments: [{ start: 0, end: 1, text: '本地识别文本', words: [{ text: '本地识别文本', start: 0.1, end: 0.9 }] }],
        };
      },
    } as unknown as LocalPluginManager;
    const fakeSpawn = ((_exe: string, args: string[]) => {
      const output = args.at(-1)!;
      const child = new EventEmitter() as EventEmitter & { kill: () => boolean };
      child.kill = () => true;
      void fs.writeFile(output, Buffer.alloc(32000)).then(() => child.emit('close', 0));
      return child;
    }) as unknown as typeof spawn;

    const file = path.join(dir, 'asr.json');
    const service = new AsrService(file, vault, 'ffmpeg', () => {}, { spawn: fakeSpawn, localPlugins: fakePlugins });
    const saved = await service.saveConfig({ settings: { ...defaultAsrSettings, mode: 'local', language: 'zh' } });
    assert.equal(saved.settings.mode, 'local');
    const reloaded = await new AsrService(file, vault, 'ffmpeg', () => {}, { spawn: fakeSpawn, localPlugins: fakePlugins }).getConfig();
    assert.equal(reloaded.settings.mode, 'local');

    const cues = await service.transcribe({ file: media });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].id, 'asr');
    assert.equal(calls[0].route, '/infer');
    assert.equal(calls[0].payload.language, 'zh');
    assert.equal(cues.length, 1);
    assert.equal(cues[0].text, '本地识别文本');
    assert.deepEqual(await fs.readdir(inputsDir), []);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('TranslationService local mode chunks batches of up to 5 texts, binary-splits on incomplete output, and skips remote review', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lingvoice-local-trans-'));
  try {
    const batchSizes: number[] = [];
    let failedOnce = false;
    const fakePlugins = {
      requestJson: async (id: string, route: string, payload: { texts: string[]; task: string }) => {
        assert.equal(id, 'translation');
        assert.equal(route, '/infer');
        assert.equal(payload.task, 'translate');
        batchSizes.push(payload.texts.length);
        if (payload.texts.length === 5 && !failedOnce) {
          failedOnce = true;
          throw new Error('本地服务 translation 请求失败 (400): Model returned incomplete output.');
        }
        return { texts: payload.texts.map(t => `译:${t}`) };
      },
    } as unknown as LocalPluginManager;
    const service = new TranslationService(path.join(dir, 'translation.json'), vault, undefined, fakePlugins);
    await service.saveConfig({ settings: { ...defaultTranslationSettings, mode: 'local', sourceLanguage: 'en', targetLanguage: 'zh' } });
    const inputs = Array.from({ length: 8 }, (_, i) => `Line ${i + 1}`);
    const translated = await service.translate({ texts: inputs });
    assert.deepEqual(batchSizes, [5, 3, 2, 3]);
    assert.equal(translated.length, 8);
    assert.equal(translated[0], '译:Line 1');
    assert.equal(translated[7], '译:Line 8');
    assert.deepEqual(await service.review({ cues: [{ id: 1, text: 'a', translated: 'b' }] }), []);
    assert.deepEqual(await service.summarize({ memory: { summary: 's', terms: [] }, pairs: [{ source: 'a', translated: 'b' }] }), { summary: 's', terms: [] });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('TtsService local mode exposes local dubbingContextInfo and synthesizes when reference WAV exists', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lingvoice-local-tts-'));
  try {
    const refsDir = path.join(dir, 'voice-clone', 'references');
    await fs.mkdir(refsDir, { recursive: true });
    const fakePlugins = {
      referencesDir: () => refsDir,
      ensureRunning: async () => ({ port: 9873, token: 'tok' }),
      requestAudio: async () => Buffer.from('RIFFtestwav'),
    } as unknown as LocalPluginManager;
    const providers = new ProviderService(path.join(dir, 'providers.json'), vault);
    const service = new TtsService(path.join(dir, 'tts.json'), providers, vault, fakePlugins);
    await service.saveConfig({ settings: { ...defaultTtsSettings, mode: 'local' } });
    const info = await service.dubbingContextInfo();
    assert.equal(info.mode, 'local');
    await assert.rejects(service.generate({ text: '测试' }), /放置一段 3–10 秒单声道 WAV/);

    await fs.writeFile(path.join(refsDir, 'sample.wav'), Buffer.from('wav'));
    const audio = await service.generate({ text: '测试' });
    assert.equal(audio.mimeType, 'audio/wav');
    assert.equal(audio.fileName, 'speech.wav');
    assert.equal(Buffer.from(audio.audioBase64, 'base64').toString(), 'RIFFtestwav');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('LocalPluginManager detects installed workspace plugins', async () => {
  const manager = new LocalPluginManager(path.resolve(process.cwd(), 'plugins'));
  const status = await manager.status();
  assert.equal(status.available, true);
  assert.equal(status.services.asr.installed, true);
  assert.equal(status.services.asr.weightsReady, true);
  assert.equal(status.services.translation.installed, true);
  assert.equal(status.services.translation.weightsReady, true);
  assert.equal(status.services['voice-clone'].installed, true);
  assert.equal(status.services['voice-clone'].weightsReady, true);
  assert.equal(status.download?.active, false);
  assert.equal(status.download?.source, 'modelscope');
  await assert.rejects(
    manager.downloadModels({ target: 'bad' as never, source: 'modelscope' }),
    /无效的模型下载参数/,
  );
});
