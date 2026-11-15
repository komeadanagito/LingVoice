import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { DubbingService, validateDubbingRequest, validateDubbingSettings, selectVoiceReference, selectCleanestVoiceReference, selectLocalV5Reference, groupDubbingUtterances, dubbingSrt, type DubbingDependencies } from '../src/main/dubbing';
import { DEFAULT_DUBBING_MODEL, DUBBING_MODEL, SUPPORTED_DUBBING_MODELS, type DubbingModel, type DubbingRequest, type DubbingProgress } from '../src/shared/dubbing';
import { defaultTranslationSettings } from '../src/shared/translation';
import { readWavInfo } from '../src/main/audio-process';
import { planAlignment, detectWavTrimBounds } from '../src/main/audio-alignment';

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
async function fixture(t: TestContext, selectedTts?: { baseUrl: string; model: string; hasApiKey: boolean }) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lingvoice-dubbing-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const source = path.join(directory, 'source.mp4'), model = path.join(directory, 'model.ckpt');
  await fs.writeFile(source, 'private-media-fixture'); await fs.writeFile(model, 'private-weight-fixture');
  const events: DubbingProgress[] = [], spoken: string[] = [], translations: string[][] = [];
  let created = 0, deleted = 0, separationCount = 0, account = 'account-key', enrollmentFailure = false;
  const voiceId = `${DUBBING_MODEL}-lingvoice-test`;
  const translationSettings = { ...defaultTranslationSettings, targetLanguage: 'en', providerId: 'mock' };
  const clientModels: string[] = [];
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
      assert.equal(credentials.baseUrl, selectedTts ? `${new URL(selectedTts.baseUrl).origin}/api/v1` : 'https://workspace.cn-beijing.maas.aliyuncs.com/api/v1');
      clientModels.push((credentials as { model?: string }).model ?? DUBBING_MODEL);
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
    tts: {
      withDubbingContext: action => action({ baseUrl: selectedTts?.baseUrl ?? 'unused-provider-url', apiKey: account }),
      ...(selectedTts ? { dubbingContextInfo: async () => ({ ...selectedTts, providerName: 'Selected Token Plan' }) } : {}),
    },
    translation: {
      summarize: async request => request.memory,
      getConfig: async () => ({ settings: { ...translationSettings }, hasApiKey: true, hasMachineKey: false }),
      translate: async (payload, signal, durations) => {
        signal?.throwIfAborted(); translations.push(payload.texts); assert.deepEqual(durations, [6]); return payload.texts.map(text => `Translated ${text}`);
      },
    },
    emit: event => events.push(event),
  }, dependencies);
  await service.saveConfig({ pythonPath: 'offline-python', modelFile: model, baseUrl: 'https://workspace.cn-beijing.maas.aliyuncs.com/api/v1' });
  return { service, source, directory, events, spoken, translations, translationSettings, voiceId, clientModels,
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
  assert.equal(validateDubbingSettings({ ...settings, model: 'doubao-seed-tts-2.0' }).model, 'doubao-seed-tts-2.0');
  assert.throws(() => validateDubbingSettings({ ...settings, model: 'unsupported-model' as any }), /Unsupported/);
  assert.throws(() => validateDubbingSettings({ ...settings, modelFile: 'relative.ckpt' }), /absolute/);
  assert.equal(validateDubbingSettings({ ...settings, baseUrl: 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1' }).baseUrl, 'https://token-plan.cn-beijing.maas.aliyuncs.com/api/v1');
  for (const baseUrl of ['http://dashscope.aliyuncs.com/api/v1', 'https://evil.example/api/v1']) assert.throws(() => validateDubbingSettings({ ...settings, baseUrl }));
  assert.throws(() => validateDubbingSettings({ ...settings, apiKey: 'never-accept-secret-here' }));
});

test('main workspace uses selected Token Plan TTS endpoint and exact model over legacy dubbing settings', async t => {
  const f = await fixture(t, { baseUrl: 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1', model: 'qwen-audio-3.0-tts-plus', hasApiKey: true });
  const result = await f.service.run({ ...request(f.source), useTtsConfig: true });
  assert.match(result.voiceId, /^qwen-audio-3\.0-tts-plus-/);
  assert.deepEqual(f.clientModels, ['qwen-audio-3.0-tts-plus']);
  const voices = (await f.service.getConfig()).voices!;
  assert.equal(voices[0].baseUrl, 'https://token-plan.cn-beijing.maas.aliyuncs.com/api/v1');
});

test('main workspace fails before preprocessing for missing TTS credentials or unsupported models', async t => {
  const selected = { baseUrl: 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1', model: 'qwen-audio-3.0-tts-plus', hasApiKey: false };
  const f = await fixture(t, selected);
  await assert.rejects(f.service.run({ ...request(f.source), useTtsConfig: true }), /API Key/);
  selected.hasApiKey = true; selected.model = 'unsupported';
  await assert.rejects(f.service.run({ ...request(f.source), useTtsConfig: true }), /supported dubbing model/);
  assert.equal(f.counts().separationCount, 0);
  assert.deepEqual(f.clientModels, []);
  assert.throws(() => validateDubbingRequest({ ...request(f.source), useTtsConfig: 'true' }));
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

test('prepareVocals separates stems ahead of ASR and reuses cached stems during dubbing run', async t => {
  const f = await fixture(t);
  const vocalPath = await f.service.prepareVocals(f.source);
  assert.ok(vocalPath && vocalPath.endsWith('dialogue.wav'));
  assert.equal(f.counts().separationCount, 1);
  await f.service.run(request(f.source));
  assert.equal(f.counts().separationCount, 1, 'dubbing run must reuse stems separated by prepareVocals');
});

test('selectCleanestVoiceReference prefers high-SNR unclipped vocal segments', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lingvoice-snr-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const wavFile = path.join(dir, 'dialogue.wav');
  const buf = wav(20, 16000, 1);
  // First window (0..6s): very quiet/empty; second window (8..15s): clear unclipped vocal energy
  for (let i = 8 * 16000; i < 15 * 16000; i++) {
    buf.writeInt16LE(6000, 44 + i * 2);
  }
  await fs.writeFile(wavFile, buf);
  const cues = [
    { id: 1, start: 0, end: 6, text: 'Quiet intro' },
    { id: 2, start: 8, end: 15, text: 'Clear speech window' },
  ];
  const selected = await selectCleanestVoiceReference(cues, 0, 20, wavFile);
  assert.equal(selected.start, 8);
  assert.equal(selected.duration, 7);
});

test('groupDubbingUtterances merges fragmented unpunctuated clauses into Bilibili-style breath groups while respecting terminal punctuation', () => {
  const cues = [
    { id: 1, start: 0.0, end: 2.0, text: '今天我们来拆解', translated: 'Today we are unpacking,', speechText: 'Today we are unpacking,' },
    { id: 2, start: 2.1, end: 4.5, text: 'B站最新的英文配音技术。', translated: 'Bilibili\'s latest English dubbing tech.', speechText: 'Bilibili\'s latest English dubbing tech.' },
    { id: 3, start: 5.2, end: 7.0, text: '效果非常自然！', translated: 'It sounds super natural!', speechText: 'It sounds super natural!' },
  ];
  const groups = groupDubbingUtterances(cues, 'en');
  assert.equal(groups.length, 2);
  assert.equal(groups[0].start, 0.0);
  assert.equal(groups[0].end, 4.5);
  assert.equal(groups[0].speechText, 'Today we are unpacking Bilibili\'s latest English dubbing tech.');
  assert.equal(groups[1].speechText, 'It sounds super natural!');
});

test('detectWavTrimBounds strips leading and trailing TTS dead silence while preserving voiced speech', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lingvoice-trim-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const wavFile = path.join(dir, 'tts.wav');
  // 3.4s WAV at 24 kHz mono: 0..0.3s silence, 0.3..3.0s speech (2.7s), 3.0..3.4s silence
  const buf = wav(3.4, 24000, 1);
  for (let i = Math.floor(0.3 * 24000); i < Math.floor(3.0 * 24000); i++) {
    buf.writeInt16LE(5000, 44 + i * 2);
  }
  await fs.writeFile(wavFile, buf);
  const info = await readWavInfo(wavFile);
  const trim = await detectWavTrimBounds(wavFile, info);
  assert.ok(trim, 'should detect leading/trailing TTS silence padding');
  assert.ok(trim.trimmedDuration >= 2.7 && trim.trimmedDuration <= 2.8, `expected ~2.75s trimmed duration, got ${trim.trimmedDuration}`);
  // Trimmed duration (2.75s) now fits cleanly into a 3.0s slot at 1.0x tempo!
  const plan = planAlignment(trim.trimmedDuration, 0, 3.0);
  assert.equal(plan.tempo, 1);
});

test('selectVoiceReference falls back to relaxed gaps when pauses between sentences exceed 1s', () => {
  const cues = [
    { id: 1, start: 0.5, end: 3.0, text: 'First line.' },
    { id: 2, start: 4.5, end: 7.5, text: 'Second line after 1.5s pause.' },
  ];
  const ref = selectVoiceReference(cues, 0, 10);
  assert.equal(ref.start, 0.5);
  assert.equal(ref.duration, 7);
});

test('groupDubbingUtterances merges tiny trailing fragments when source sentence has no terminal punctuation', () => {
  const cues = [
    { id: 1, start: 0.8, end: 4.32, text: '你打字的时候，有没有想过候选窗还能干点', translated: 'Have you thought the candidate window could do more?', speechText: 'Have you thought the candidate window could do more?' },
    { id: 2, start: 4.32, end: 4.56, text: '别的？', translated: 'Other than that?', speechText: 'Other than that?' },
  ];
  const groups = groupDubbingUtterances(cues, 'en');
  assert.equal(groups.length, 1);
  assert.equal(groups[0].start, 0.8);
  assert.equal(groups[0].end, 4.56);
});

test('local voice-clone path retries with faster speed_factor and borrows backward slack when slot overflows', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lingvoice-local-dub-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const source = path.join(dir, 'source.mp4');
  const model = path.join(dir, 'model.ckpt');
  await fs.writeFile(source, 'fixture');
  await fs.writeFile(model, 'fixture-model');
  const speedCalls: number[] = [];
  const referencePayloads: { prompt_lang: string; ref_audio_path: string; prompt_text: string }[] = [];
  const referenceExtractions: { input: string; output: string; verificationCalls: number }[] = [];
  const alignedSlots: { start: number; end: number }[] = [];
  let lastSpeech = '', verificationCalls = 0, secondCueAttempts = 0;
  const mockPlugins = {
    inputsDir: () => path.join(dir, 'inputs'),
    requestJson: async () => {
      verificationCalls++;
      if (verificationCalls === 1) return { text: '他画的还是很烂，但是每天都画得特别开心。' };
      if (lastSpeech === 'Second line starts immediately.' && secondCueAttempts <= 3) return { text: 'Unrelated prompt continuation.' };
      return { text: lastSpeech };
    },
    referencesDir: () => path.join(dir, 'refs'),
    ensureRunning: async () => ({ port: 9873, token: 'tok' }),
    requestAudio: async (_id: string, _route: string, payload: { speed_factor: number; text: string; prompt_lang: string; ref_audio_path: string; prompt_text: string }) => {
      referencePayloads.push(payload);
      lastSpeech = payload.text;
      if (lastSpeech === 'Second line starts immediately.') secondCueAttempts++;
      speedCalls.push(payload.speed_factor);
      const dur = payload.speed_factor > 1 ? 3.2 : 6.2;
      return wav(dur, 24000, 1);
    },
  };
  const service = new DubbingService({
    directory: path.join(dir, 'dubbing'),
    ffmpegPath: 'offline-ffmpeg',
    helperPath: 'offline-helper',
    tts: {
      withDubbingContext: async () => { throw new Error('Should not use cloud context'); },
      dubbingContextInfo: async () => ({ providerName: 'Local GPT-SoVITS V5', baseUrl: 'http://127.0.0.1:9873', hasApiKey: true, mode: 'local' }),
    },
    translation: {
      summarize: async req => req.memory,
      getConfig: async () => ({ settings: { ...defaultTranslationSettings, mode: 'local', sourceLanguage: 'zh', targetLanguage: 'en' }, hasApiKey: false, hasMachineKey: false }),
      translate: async payload => payload.texts.map(text => `En ${text}`),
    },
    emit: () => {},
    localPlugins: mockPlugins as any,
  }, {
    detect: async () => ({ ready: true, diagnostics: ['ok'] }),
    separate: async (input, output) => {
      await fs.mkdir(output);
      const dialoguePath = path.join(output, 'dialogue.wav'), backgroundPath = path.join(output, 'background.wav');
      await fs.copyFile(input, dialoguePath); await fs.copyFile(input, backgroundPath);
      return { dialoguePath, backgroundPath, duration: 10 };
    },
    extract: async (_input, output) => { await fs.writeFile(output, wav(10)); return readWavInfo(output); },
    reference: async (_input, output) => { await fs.writeFile(output, wav(6, 24000, 1)); return readWavInfo(output); },
    localReference: async (input, output, _start, duration, pad) => {
      referenceExtractions.push({ input, output, verificationCalls });
      await fs.writeFile(output, wav(duration + pad, 32000, 1));
      return readWavInfo(output);
    },
    process: async (_bin, args) => {
      const outFile = args.at(-1)!;
      await fs.mkdir(path.dirname(outFile), { recursive: true });
      await fs.writeFile(outFile, wav(10));
      return { stdout: '', stderr: '' };
    },
    align: async (segment, output, opts) => {
      alignedSlots.push({ start: segment.start, end: segment.end });
      const plan = planAlignment((await readWavInfo(segment.filePath)).duration, segment.start, segment.end, opts.maxTempo);
      await fs.writeFile(output, wav(plan.duration));
      return { ...segment, filePath: output, info: await readWavInfo(output), plan };
    },
    mix: async value => { await fs.writeFile(value.outputPath, 'mixed'); return { outputPath: value.outputPath, duration: value.duration }; },
  });
  await service.saveConfig({ pythonPath: 'offline-python', modelFile: model, baseUrl: 'https://dashscope.aliyuncs.com/api/v1' });
  const result = await service.run({
    jobId: 'local-overflow-test',
    file: source,
    offset: 0,
    backgroundVolume: 1,
    preview: false,
    consent: true,
    useTtsConfig: true,
    cues: [
      { id: 1, start: 2.0, end: 5.0, text: '第一句很长的中文台词。', translated: 'A rather long English sentence that initially overflows.' },
      { id: 2, start: 5.0, end: 8.5, text: '第二句紧接着开始。', translated: 'Second line starts immediately.' },
    ],
  });
  assert.equal(result.voiceId, 'local-gpt-sovits-v5');
  assert.equal(verificationCalls, 0, 'local dubbing must not invoke ASR verification');
  assert.equal(speedCalls[0], 1);
  assert.equal(referencePayloads[0].prompt_lang, 'zh');
  assert.ok(referencePayloads.slice(1).every(p => p.prompt_lang === 'en'), 'later synthesis must use the promoted English reference');
  assert.notEqual(referencePayloads[0].ref_audio_path, referencePayloads[1].ref_audio_path, 'use a distinct reference path to avoid stale upstream semantic caches');
  assert.ok(referencePayloads.every(p => !path.isAbsolute(p.ref_audio_path)), 'ref_audio_path must remain relative to references/');
  assert.equal(referencePayloads[1].prompt_text, 'A rather long English sentence that initially overflows.');
  assert.equal(referenceExtractions.length, 2, 'extract original and promote target-language reference');
  assert.match(referenceExtractions[1].input, /speech-.*\.wav$/);
  for (const extraction of referenceExtractions) {
    await assert.rejects(fs.access(extraction.output), 'temporary voice references must be cleaned after completion');
  }
  assert.ok(speedCalls.some(s => s > 1), `expected a speed_factor > 1 retry, got ${speedCalls.join(',')}`);
  assert.ok(alignedSlots[0].start < 2.0, `expected first cue to borrow backward silence, got start=${alignedSlots[0].start}`);
});

test('local voice-clone path retries alternate seeds on runaway synthesis and clamps final cue within audio duration', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lingvoice-local-runaway-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const source = path.join(dir, 'source.mp4');
  const model = path.join(dir, 'model.ckpt');
  await fs.writeFile(source, 'fixture');
  await fs.writeFile(model, 'fixture-model');
  const seeds: number[] = [];
  const alignedSlots: { start: number; end: number }[] = [];
  let lastSpeech = '';
  const mockPlugins = {
    inputsDir: () => path.join(dir, 'inputs'),
    requestJson: async () => ({ text: lastSpeech }),
    referencesDir: () => path.join(dir, 'refs'),
    ensureRunning: async () => ({ port: 9873, token: 'tok' }),
    requestAudio: async (_id: string, _route: string, payload: { seed: number; text: string }) => {
      lastSpeech = payload.text;
      seeds.push(payload.seed);
      return wav(payload.seed === 123 ? 2.5 : 14.0, 24000, 1);
    },
  };
  const service = new DubbingService({
    directory: path.join(dir, 'dubbing'),
    ffmpegPath: 'offline-ffmpeg',
    helperPath: 'offline-helper',
    tts: {
      withDubbingContext: async () => { throw new Error('Should not use cloud context'); },
      dubbingContextInfo: async () => ({ providerName: 'Local GPT-SoVITS V5', baseUrl: 'http://127.0.0.1:9873', hasApiKey: true, mode: 'local' }),
    },
    translation: {
      summarize: async req => req.memory,
      getConfig: async () => ({ settings: { ...defaultTranslationSettings, mode: 'local', sourceLanguage: 'zh', targetLanguage: 'en' }, hasApiKey: false, hasMachineKey: false }),
      translate: async payload => payload.texts,
    },
    emit: () => {},
    localPlugins: mockPlugins as any,
  }, {
    detect: async () => ({ ready: true, diagnostics: ['ok'] }),
    separate: async (input, output) => {
      await fs.mkdir(output);
      const dialoguePath = path.join(output, 'dialogue.wav'), backgroundPath = path.join(output, 'background.wav');
      await fs.copyFile(input, dialoguePath); await fs.copyFile(input, backgroundPath);
      return { dialoguePath, backgroundPath, duration: 10 };
    },
    extract: async (_input, output) => { await fs.writeFile(output, wav(10)); return readWavInfo(output); },
    reference: async (_input, output) => { await fs.writeFile(output, wav(6, 24000, 1)); return readWavInfo(output); },
    align: async (segment, output, opts) => {
      alignedSlots.push({ start: segment.start, end: segment.end });
      const plan = planAlignment((await readWavInfo(segment.filePath)).duration, segment.start, segment.end, opts.maxTempo);
      await fs.writeFile(output, wav(plan.duration));
      return { ...segment, filePath: output, info: await readWavInfo(output), plan };
    },
    mix: async value => {
      for (const s of value.segments) assert.ok(s.end <= value.duration, `segment end ${s.end} > duration ${value.duration}`);
      await fs.writeFile(value.outputPath, 'mixed');
      return { outputPath: value.outputPath, duration: value.duration };
    },
  });
  await service.saveConfig({ pythonPath: 'offline-python', modelFile: model, baseUrl: 'https://dashscope.aliyuncs.com/api/v1' });
  const result = await service.run({
    jobId: 'local-runaway-clamp',
    file: source,
    offset: 0,
    backgroundVolume: 1,
    preview: false,
    consent: true,
    useTtsConfig: true,
    cues: [
      { id: 1, start: 0.0, end: 6.0, text: '第一句参考音频。', translated: 'First line.' },
      { id: 2, start: 8.0, end: 10.005, text: '最后一句贴边。', translated: 'Final line right at the end.' },
    ],
  });
  assert.equal(result.voiceId, 'local-gpt-sovits-v5');
  assert.ok(seeds.includes(123), `expected alternate seed retry on runaway duration, got ${seeds.join(',')}`);
  assert.ok(alignedSlots.every(s => s.end <= 10), `expected clamped slot end <= 10, got ${JSON.stringify(alignedSlots)}`);
});

test('selectLocalV5Reference prefers a clean 3–5.5s complete-sentence window with trailing pause', async () => {
  const ref = await selectLocalV5Reference([
    { id: 1, start: 0.1, end: 1.5, text: '开场短句。' },
    { id: 2, start: 2.0, end: 5.8, text: '这是一句非常完整且长度适中的参考文本。' },
    { id: 3, start: 6.4, end: 12.5, text: '这一句太长而且包含很多从句不太适合当局部参考。' },
  ], 0, 13);
  assert.equal(ref.start, 2.0);
  assert.ok(ref.duration >= 3.0 && ref.duration <= 5.5);
  assert.deepEqual(ref.cues.map(c => c.id), [2]);
});

test('local voice-clone runs without requiring or calling the local ASR plugin', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lingvoice-local-no-asr-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const source = path.join(dir, 'source.mp4');
  const model = path.join(dir, 'model.ckpt');
  await fs.writeFile(source, 'fixture');
  await fs.writeFile(model, 'fixture-model');
  let ttsCalls = 0, asrCalls = 0;
  const mockPlugins = {
    inputsDir: () => path.join(dir, 'inputs'),
    status: async () => ({
      available: true,
      pluginsDir: dir,
      activeService: 'voice-clone',
      services: {
        asr: { id: 'asr', port: 9871, installed: false, weightsReady: false, running: false, healthy: false, modelLabel: 'ASR' },
        translation: { id: 'translation', port: 9872, installed: false, weightsReady: false, running: false, healthy: false, modelLabel: 'Trans' },
        'voice-clone': { id: 'voice-clone', port: 9873, installed: true, weightsReady: true, running: true, healthy: true, modelLabel: 'V5' },
      },
    }),
    requestJson: async () => {
      asrCalls++;
      throw new Error('ASR must not be called');
    },
    referencesDir: () => path.join(dir, 'refs'),
    ensureRunning: async () => ({ port: 9873, token: 'tok' }),
    requestAudio: async () => {
      ttsCalls++;
      return wav(2.0, 24000, 1);
    },
  };
  const service = new DubbingService({
    directory: path.join(dir, 'dubbing'),
    ffmpegPath: 'offline-ffmpeg',
    helperPath: 'offline-helper',
    tts: {
      withDubbingContext: async () => { throw new Error('Should not use cloud context'); },
      dubbingContextInfo: async () => ({ providerName: 'Local GPT-SoVITS V5', baseUrl: 'http://127.0.0.1:9873', hasApiKey: true, mode: 'local' }),
    },
    translation: {
      summarize: async req => req.memory,
      getConfig: async () => ({ settings: { ...defaultTranslationSettings, mode: 'local', sourceLanguage: 'zh', targetLanguage: 'en' }, hasApiKey: false, hasMachineKey: false }),
      translate: async payload => payload.texts,
    },
    emit: () => {},
    localPlugins: mockPlugins as any,
  }, {
    detect: async () => ({ ready: true, diagnostics: ['ok'] }),
    separate: async (input, output) => {
      await fs.mkdir(output);
      const dialoguePath = path.join(output, 'dialogue.wav'), backgroundPath = path.join(output, 'background.wav');
      await fs.copyFile(input, dialoguePath); await fs.copyFile(input, backgroundPath);
      return { dialoguePath, backgroundPath, duration: 10 };
    },
    extract: async (_input, output) => { await fs.writeFile(output, wav(10)); return readWavInfo(output); },
    reference: async (_input, output) => { await fs.writeFile(output, wav(4, 24000, 1)); return readWavInfo(output); },
    align: async (segment, output, opts) => {
      const plan = planAlignment((await readWavInfo(segment.filePath)).duration, segment.start, segment.end, opts.maxTempo);
      await fs.writeFile(output, wav(plan.duration));
      return { ...segment, filePath: output, info: await readWavInfo(output), plan };
    },
    mix: async value => { await fs.writeFile(value.outputPath, 'mixed'); return { outputPath: value.outputPath, duration: value.duration }; },
  });
  await service.saveConfig({ pythonPath: 'offline-python', modelFile: model, baseUrl: 'https://dashscope.aliyuncs.com/api/v1' });
  const result = await service.run({
    jobId: 'local-no-asr-run',
    file: source,
    offset: 0,
    backgroundVolume: 1,
    preview: false,
    consent: true,
    useTtsConfig: true,
    cues: [{ id: 1, start: 0.0, end: 4.0, text: '第一句参考音频。', translated: 'First line.' }],
  });
  assert.equal(result.voiceId, 'local-gpt-sovits-v5');
  assert.equal(ttsCalls, 1);
  assert.equal(asrCalls, 0);
});

test('local voice-clone batches synthesis before ASR verification to avoid per-utterance model swapping', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lingvoice-local-batch-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const source = path.join(dir, 'source.mp4');
  const model = path.join(dir, 'model.ckpt');
  await fs.writeFile(source, 'fixture');
  await fs.writeFile(model, 'fixture-model');
  const events: string[] = [];
  let lastSpeech = '';
  const mockPlugins = {
    inputsDir: () => path.join(dir, 'inputs'),
    requestJson: async (id: string) => {
      events.push(`${id}:${lastSpeech}`);
      return { text: lastSpeech };
    },
    referencesDir: () => path.join(dir, 'refs'),
    ensureRunning: async (id: string) => {
      events.push(`ensure:${id}`);
      return { port: 9873, token: 'tok' };
    },
    requestAudio: async (id: string, _route: string, payload: { text: string }) => {
      lastSpeech = payload.text;
      events.push(`tts:${id}:${payload.text}`);
      return wav(3.0, 24000, 1);
    },
  };
  const service = new DubbingService({
    directory: path.join(dir, 'dubbing'),
    ffmpegPath: 'offline-ffmpeg',
    helperPath: 'offline-helper',
    tts: {
      withDubbingContext: async () => { throw new Error('Should not use cloud context'); },
      dubbingContextInfo: async () => ({ providerName: 'Local GPT-SoVITS V5', baseUrl: 'http://127.0.0.1:9873', hasApiKey: true, mode: 'local' }),
    },
    translation: {
      summarize: async req => req.memory,
      getConfig: async () => ({ settings: { ...defaultTranslationSettings, mode: 'local', sourceLanguage: 'zh', targetLanguage: 'en' }, hasApiKey: false, hasMachineKey: false }),
      translate: async payload => payload.texts,
    },
    emit: () => {},
    localPlugins: mockPlugins as any,
  }, {
    detect: async () => ({ ready: true, diagnostics: ['ok'] }),
    separate: async (input, output) => {
      await fs.mkdir(output);
      const dialoguePath = path.join(output, 'dialogue.wav'), backgroundPath = path.join(output, 'background.wav');
      await fs.copyFile(input, dialoguePath); await fs.copyFile(input, backgroundPath);
      return { dialoguePath, backgroundPath, duration: 20 };
    },
    extract: async (_input, output) => { await fs.writeFile(output, wav(20)); return readWavInfo(output); },
    reference: async (_input, output) => { await fs.writeFile(output, wav(5, 24000, 1)); return readWavInfo(output); },
    localReference: async (_input, output, _start, duration, pad) => {
      await fs.writeFile(output, wav(duration + pad, 32000, 1));
      return readWavInfo(output);
    },
    align: async (segment, output, opts) => {
      const plan = planAlignment((await readWavInfo(segment.filePath)).duration, segment.start, segment.end, opts.maxTempo);
      await fs.writeFile(output, wav(plan.duration));
      return { ...segment, filePath: output, info: await readWavInfo(output), plan };
    },
    mix: async value => { await fs.writeFile(value.outputPath, 'mixed'); return { outputPath: value.outputPath, duration: value.duration }; },
  });
  await service.saveConfig({ pythonPath: 'offline-python', modelFile: model, baseUrl: 'https://dashscope.aliyuncs.com/api/v1' });
  // Fix requestJson to return the text corresponding to the copied audio file or track queue
  const pendingTexts: string[] = [];
  mockPlugins.requestAudio = async (id: string, _route: string, payload: { text: string }) => {
    pendingTexts.push(payload.text);
    events.push(`tts:${payload.text}`);
    return wav(3.0, 24000, 1);
  };
  mockPlugins.requestJson = async () => {
    const text = pendingTexts.shift() ?? '';
    events.push(`asr:${text}`);
    return { text };
  };
  await service.run({
    jobId: 'local-batch-order',
    file: source,
    offset: 0,
    backgroundVolume: 1,
    preview: false,
    consent: true,
    useTtsConfig: true,
    cues: [
      { id: 1, start: 0.0, end: 4.0, text: '第一句参考音频。', translated: 'First bootstrap line.' },
      { id: 2, start: 4.0, end: 8.0, text: '第二句。', translated: 'Second batched line.' },
      { id: 3, start: 8.0, end: 12.0, text: '第三句。', translated: 'Third batched line.' },
      { id: 4, start: 12.0, end: 16.0, text: '第四句。', translated: 'Fourth batched line.' },
    ],
  });
  const ttsAndAsr = events.filter(e => e.startsWith('tts:') || e.startsWith('asr:'));
  assert.deepEqual(ttsAndAsr, [
    'tts:First bootstrap line.',
    'tts:Second batched line.',
    'tts:Third batched line.',
    'tts:Fourth batched line.',
  ]);
});

test('local voice-clone batches overflow speed-up synthesis before ASR verification', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lingvoice-local-batch-fast-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const source = path.join(dir, 'source.mp4');
  const model = path.join(dir, 'model.ckpt');
  await fs.writeFile(source, 'fixture');
  await fs.writeFile(model, 'fixture-model');
  const events: string[] = [];
  const pendingTexts: string[] = [];
  const mockPlugins = {
    inputsDir: () => path.join(dir, 'inputs'),
    requestJson: async () => {
      const text = pendingTexts.shift() ?? '';
      events.push(`asr:${text}`);
      return { text };
    },
    referencesDir: () => path.join(dir, 'refs'),
    ensureRunning: async () => ({ port: 9873, token: 'tok' }),
    requestAudio: async (_id: string, _route: string, payload: { speed_factor: number; text: string }) => {
      pendingTexts.push(payload.text);
      events.push(`tts:${payload.speed_factor > 1 ? 'fast' : 'base'}:${payload.text}`);
      return wav(payload.speed_factor > 1 ? 2.8 : 5.5, 24000, 1);
    },
  };
  const service = new DubbingService({
    directory: path.join(dir, 'dubbing'),
    ffmpegPath: 'offline-ffmpeg',
    helperPath: 'offline-helper',
    tts: {
      withDubbingContext: async () => { throw new Error('Should not use cloud context'); },
      dubbingContextInfo: async () => ({ providerName: 'Local GPT-SoVITS V5', baseUrl: 'http://127.0.0.1:9873', hasApiKey: true, mode: 'local' }),
    },
    translation: {
      summarize: async req => req.memory,
      getConfig: async () => ({ settings: { ...defaultTranslationSettings, mode: 'local', sourceLanguage: 'zh', targetLanguage: 'en' }, hasApiKey: false, hasMachineKey: false }),
      translate: async payload => payload.texts,
    },
    emit: () => {},
    localPlugins: mockPlugins as any,
  }, {
    detect: async () => ({ ready: true, diagnostics: ['ok'] }),
    separate: async (input, output) => {
      await fs.mkdir(output);
      const dialoguePath = path.join(output, 'dialogue.wav'), backgroundPath = path.join(output, 'background.wav');
      await fs.copyFile(input, dialoguePath); await fs.copyFile(input, backgroundPath);
      return { dialoguePath, backgroundPath, duration: 16 };
    },
    extract: async (_input, output) => { await fs.writeFile(output, wav(16)); return readWavInfo(output); },
    reference: async (_input, output) => { await fs.writeFile(output, wav(5, 24000, 1)); return readWavInfo(output); },
    localReference: async (_input, output, _start, duration, pad) => {
      await fs.writeFile(output, wav(duration + pad, 32000, 1));
      return readWavInfo(output);
    },
    align: async (segment, output, opts) => {
      const plan = planAlignment((await readWavInfo(segment.filePath)).duration, segment.start, segment.end, opts.maxTempo);
      await fs.writeFile(output, wav(plan.duration));
      return { ...segment, filePath: output, info: await readWavInfo(output), plan };
    },
    mix: async value => { await fs.writeFile(value.outputPath, 'mixed'); return { outputPath: value.outputPath, duration: value.duration }; },
  });
  await service.saveConfig({ pythonPath: 'offline-python', modelFile: model, baseUrl: 'https://dashscope.aliyuncs.com/api/v1' });
  await service.run({
    jobId: 'local-batch-fast-order',
    file: source,
    offset: 0,
    backgroundVolume: 1,
    preview: false,
    consent: true,
    useTtsConfig: true,
    cues: [
      { id: 1, start: 0.0, end: 4.0, text: '第一句参考音频。', translated: 'Bootstrap reference line here.' },
      { id: 2, start: 4.0, end: 7.0, text: '第二句。', translated: 'Overflow line number one.' },
      { id: 3, start: 7.0, end: 10.0, text: '第三句。', translated: 'Overflow line number two.' },
      { id: 4, start: 10.0, end: 13.0, text: '第四句。', translated: 'Overflow line number three.' },
      { id: 5, start: 13.0, end: 16.0, text: '第五句。', translated: 'Final trailing cue line.' },
    ],
  });
  const fastIdx = events.indexOf('tts:fast:Overflow line number one.');
  assert.ok(fastIdx >= 0, `expected tts:fast:Overflow line number one. in events: ${JSON.stringify(events)}`);
  const fastTail = events.slice(fastIdx);
  assert.deepEqual(fastTail, [
    'tts:fast:Overflow line number one.',
    'tts:fast:Overflow line number two.',
    'tts:fast:Overflow line number three.',
    'tts:fast:Final trailing cue line.',
  ]);
});


