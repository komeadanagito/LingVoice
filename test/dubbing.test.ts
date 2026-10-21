import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { DubbingService, validateDubbingRequest, validateDubbingSettings, selectVoiceReference, dubbingSrt, type DubbingDependencies } from '../src/main/dubbing';
import { DEFAULT_DUBBING_MODEL, DUBBING_MODEL, SUPPORTED_DUBBING_MODELS, type DubbingModel, type DubbingRequest, type DubbingProgress } from '../src/shared/dubbing';
import { defaultTranslationSettings } from '../src/shared/translation';
import { readWavInfo } from '../src/main/audio-process';
import { planAlignment } from '../src/main/audio-alignment';

function wav(seconds = 6, rate = 48000, channels = 2): Buffer {
  const samples = Math.round(seconds * rate), bytes = samples * channels * 2;
  const buffer = Buffer.alloc(44 + bytes);
  buffer.write('RIFF'); buffer.writeUInt32LE(36 + bytes, 4); buffer.write('WAVE', 8);
  buffer.write('fmt ', 12); buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(rate, 24); buffer.writeUInt32LE(rate * channels * 2, 28); buffer.writeUInt16LE(channels * 2, 32); buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36); buffer.writeUInt32LE(bytes, 40); return buffer;
}
function request(file = 'C:\\media\\source.mp4'): DubbingRequest {
  return { jobId: 'dubbing-test-job', file, cues: [{ id: 1, start: 0, end: 6, text: 'Original speech' }], offset: 0, backgroundVolume: 1, preview: false, consent: true };
}
async function fixture(t: TestContext) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lingvoice-dubbing-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const source = path.join(directory, 'source.mp4'), model = path.join(directory, 'model.ckpt');
  await fs.writeFile(source, 'private-media-fixture'); await fs.writeFile(model, 'private-weight-fixture');
  const events: DubbingProgress[] = [], spoken: string[] = [], translations: string[][] = [];
  let created = 0, deleted = 0, separationCount = 0, account = 'account-key', enrollmentFailure = false;
  const voiceId = `${DUBBING_MODEL}-lingvoice-test`;
  const translationSettings = { ...defaultTranslationSettings, targetLanguage: 'en', providerId: 'mock' };
  const dependencies: Partial<DubbingDependencies> = {
    detect: async () => ({ ready: true, diagnostics: ['Offline test environment.'] }),
    extract: async (_input, output) => { await fs.writeFile(output, wav()); return readWavInfo(output); },
    separate: async (input, output) => {
      separationCount++; await fs.mkdir(output);
      const dialoguePath = path.join(output, 'dialogue.wav'), backgroundPath = path.join(output, 'background.wav');
      await fs.copyFile(input, dialoguePath); await fs.copyFile(input, backgroundPath);
      return { dialoguePath, backgroundPath, duration: 6 };
    },
    reference: async (_input, output) => { await fs.writeFile(output, wav(6, 24000, 1)); return readWavInfo(output); },
    align: async (segment, output) => {
      const plan = planAlignment((await readWavInfo(segment.filePath)).duration, segment.start, segment.end);
      await fs.writeFile(output, wav(plan.duration));
      return { ...segment, filePath: output, info: await readWavInfo(output), plan };
    },
    mix: async value => { await fs.writeFile(value.outputPath, 'offline-mixed-video'); return { outputPath: value.outputPath, duration: value.duration }; },
    client: credentials => {
      assert.equal(credentials.baseUrl, 'https://workspace.cn-beijing.maas.aliyuncs.com/api/v1');
      assert.equal(credentials.apiKey, account);
      return {
        createVoice: async (_reference, _signal, onCreated) => {
          created++;
          const model: DubbingModel = (credentials as { model?: DubbingModel }).model ?? DUBBING_MODEL;
          const assignedVoiceId = `${model}-lingvoice-test`;
          await onCreated?.({ voiceId: assignedVoiceId, model, status: 'DEPLOYING' });
          if (enrollmentFailure) throw new Error('Voice deployment failed after creation.');
          return { voiceId: assignedVoiceId, model, status: 'OK' };
        },
        queryVoice: async () => ({ voiceId, model: DUBBING_MODEL, status: 'OK' }),
        synthesize: async (text, _voice, outputFile, signal) => {
          signal?.throwIfAborted(); spoken.push(text); await fs.writeFile(outputFile, wav(5.5, 24000, 1));
          return { outputFile, bytes: 264044, sampleRate: 24000, durationSeconds: 5.5 };
        },
        deleteVoice: async () => { deleted++; return { voiceId, deleted: true }; },
      };
    },
  };
  const service = new DubbingService({
    directory: path.join(directory, 'dubbing'), ffmpegPath: 'offline-ffmpeg', helperPath: 'offline-helper',
    tts: { withDubbingContext: action => action({ baseUrl: 'unused-provider-url', apiKey: account }) },
    translation: {
      getConfig: async () => ({ settings: { ...translationSettings }, hasApiKey: true, hasMachineKey: false }),
      translate: async (payload, signal, durations) => {
        signal?.throwIfAborted(); translations.push(payload.texts); assert.deepEqual(durations, [6]); return payload.texts.map(text => `Translated ${text}`);
      },
    },
    emit: event => events.push(event),
  }, dependencies);
  await service.saveConfig({ pythonPath: 'offline-python', modelFile: model, baseUrl: 'https://workspace.cn-beijing.maas.aliyuncs.com/api/v1' });
  return { service, source, directory, events, spoken, translations, translationSettings, voiceId,
    counts: () => ({ created, deleted, separationCount }), setAccount: (value: string) => { account = value; }, failEnrollment: () => { enrollmentFailure = true; } };
}

test('dubbing rejects missing consent, overlapping/negative slots, nonfinite gains and settings overrides', () => {
  const original = request();
  assert.deepEqual(validateDubbingRequest(original), original);
  for (const value of [
    { ...original, consent: false }, { ...original, offset: -1 }, { ...original, backgroundVolume: NaN },
    { ...original, settings: {} }, { ...original, cues: [] },
    { ...original, cues: [...original.cues, { ...original.cues[0], id: 2, start: 5, end: 7 }] },
    { ...original, cues: [{ ...original.cues[0], speechText: '' }] },
  ]) assert.throws(() => validateDubbingRequest(value));
});

test('dubbing settings accept only explicit official endpoints and local absolute model paths', () => {
  const settings = { pythonPath: 'python', modelFile: path.resolve('model.ckpt'), baseUrl: 'https://dashscope.aliyuncs.com/api/v1', model: 'qwen-audio-3.1-tts-plus' as const };
  assert.deepEqual(validateDubbingSettings(settings), settings);
  assert.equal(validateDubbingSettings({ ...settings, model: 'qwen-audio-3.0-tts-plus' }).model, 'qwen-audio-3.0-tts-plus');
  assert.throws(() => validateDubbingSettings({ ...settings, model: 'unsupported-model' as any }), /Unsupported/);
  assert.throws(() => validateDubbingSettings({ ...settings, modelFile: 'relative.ckpt' }), /absolute/);
  for (const baseUrl of ['http://dashscope.aliyuncs.com/api/v1', 'https://evil.example/api/v1', 'https://dashscope.aliyuncs.com/compatible-mode/v1']) assert.throws(() => validateDubbingSettings({ ...settings, baseUrl }));
  assert.throws(() => validateDubbingSettings({ ...settings, apiKey: 'never-accept-secret-here' }));
});

test('voice reference selection rejects insufficient speech and respects offsets and duration', () => {
  assert.deepEqual(selectVoiceReference(request().cues, 1, 7), { start: 1, duration: 6 });
  assert.throws(() => selectVoiceReference([{ id: 1, start: 0, end: 2, text: 'Hi' }], 0, 6), /reference/);
  assert.throws(() => selectVoiceReference(request().cues, 0, 4), /reference/);
  const srt = dubbingSrt([{ ...request().cues[0], translated: 'Subtitle', speechText: 'Spoken' }], 0.5);
  assert.match(srt, /00:00:00,500 --> 00:00:06,500/); assert.match(srt, /Subtitle\nOriginal speech/);
});

test('offline dubbing pipeline preserves original text, caches separation and speech, and atomically exposes results', async t => {
  const f = await fixture(t);
  const result = await f.service.run(request(f.source));
  assert.equal(result.targetLanguage, 'en'); assert.equal(result.voiceId, f.voiceId);
  assert.equal(result.cues[0].text, 'Original speech'); assert.equal(result.cues[0].speechText, 'Translated Original speech');
  for (const file of [result.video, result.audio, result.subtitles]) assert.equal((await fs.stat(file)).isFile(), true);
  assert.equal(f.service.busy, false); assert.equal(f.events.at(-1)?.stage, 'complete');
  assert.equal(JSON.stringify(result).includes('account-key'), false);
  await f.service.run({ ...request(f.source), jobId: 'second-test-job' });
  assert.deepEqual(f.counts(), { created: 1, deleted: 0, separationCount: 1 });
  assert.equal(f.spoken.length, 1);
  // Switching model creates a new model-bound voice and avoids mixing cache.
  await f.service.saveConfig({ pythonPath: 'offline-python', modelFile: path.join(f.directory, 'model.ckpt'), baseUrl: 'https://workspace.cn-beijing.maas.aliyuncs.com/api/v1', model: 'qwen-audio-3.0-tts-plus' });
  await f.service.run({ ...request(f.source), jobId: 'third-test-job-30' });
  assert.equal(f.counts().created, 2);
  await f.service.clearCache();
  await assert.rejects(fs.stat(result.video));
  assert.equal((await fs.stat(path.join(f.directory, 'dubbing', 'voices.json'))).isFile(), true);
});

test('spoken overrides remain distinct from subtitle translations and are never retranslated', async t => {
  const f = await fixture(t), payload = request(f.source);
  payload.cues[0] = { ...payload.cues[0], translated: 'Display translation', speechText: 'Short spoken translation' };
  const result = await f.service.run(payload);
  assert.deepEqual(f.spoken, ['Short spoken translation']); assert.equal(f.translations.length, 0);
  assert.equal(result.cues[0].translated, 'Display translation');
});

test('voice deletion only permits registered voices under their original credentials and survives cache clearing', async t => {
  const f = await fixture(t);
  await assert.rejects(f.service.deleteVoice('arbitrary-voice'), /registered/);
  await f.service.run(request(f.source)); await f.service.clearCache();
  f.setAccount('other-account'); await assert.rejects(f.service.deleteVoice(f.voiceId), /original TTS credentials/);
  f.setAccount('account-key'); await f.service.deleteVoice(f.voiceId);
  assert.equal(f.counts().deleted, 1);
  await assert.rejects(f.service.deleteVoice(f.voiceId), /registered/);
});

test('failed voice deployments remain manageable without exposing account fingerprints or secrets', async t => {
  const f = await fixture(t); f.failEnrollment();
  await assert.rejects(f.service.run(request(f.source)), /deployment failed/);
  const config = await f.service.getConfig();
  assert.deepEqual(config.voices, [{ voiceId: f.voiceId, baseUrl: 'https://workspace.cn-beijing.maas.aliyuncs.com/api/v1' }]);
  assert.equal(JSON.stringify(config).includes('account-key'), false);
  await f.service.clearCache(); await f.service.deleteVoice(f.voiceId);
  assert.deepEqual((await f.service.getConfig()).voices, []);
});

test('cancellation is job-scoped and releases task ownership without starting later cloud work', async t => {
  const f = await fixture(t);
  const pending = f.service.run(request(f.source));
  f.service.cancel('other-job'); assert.equal(f.service.busy, true);
  f.service.cancel('dubbing-test-job');
  await assert.rejects(pending, /cancelled/);
  assert.equal(f.service.busy, false); assert.equal(f.spoken.length, 0);
});

test('incompatible subtitles and target languages fail before cloud synthesis', async t => {
  const f = await fixture(t);
  await assert.rejects(f.service.run({ ...request(f.source), offset: 1 }), /outside the audio duration/);
  f.translationSettings.targetLanguage = 'ja';
  await assert.rejects(f.service.run(request(f.source)), /Chinese and English/);
  assert.equal(f.counts().created, 0);
});
