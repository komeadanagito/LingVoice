import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import ffmpeg from 'ffmpeg-static';
import { DubbingService } from '../src/main/dubbing';
import { DUBBING_MODEL, type DubbingProgress } from '../src/shared/dubbing';
import { defaultTranslationSettings } from '../src/shared/translation';
import { ffmpegBase, readWavInfo, runAudioProcess } from '../src/main/audio-process';

test('real FFmpeg dubbing pipeline exports synchronized media with unchanged video packets (cloud and separation mocked)', { skip: !ffmpeg, timeout: 30000 }, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lingvoice-dubbing-real-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const source = path.join(directory, 'source.mp4'), model = path.join(directory, 'mock.ckpt');
  await fs.writeFile(model, 'No real separation model is loaded in this test.');
  await runAudioProcess(ffmpeg!, [...ffmpegBase,
    '-f', 'lavfi', '-i', 'color=c=blue:s=64x64:r=10:d=12',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=12',
    '-c:v', 'mpeg4', '-c:a', 'aac', '-shortest', source]);
  const events: DubbingProgress[] = [];
  const voiceId = `${DUBBING_MODEL}-lingvoice-offline`;
  const service = new DubbingService({
    directory: path.join(directory, 'tasks'), ffmpegPath: ffmpeg!, helperPath: 'not-used-by-mocked-separator',
    tts: { withDubbingContext: action => action({ baseUrl: 'unused', apiKey: 'offline-test-only' }) },
    translation: {
      getConfig: async () => ({ settings: { ...defaultTranslationSettings, targetLanguage: 'en' }, hasApiKey: false, hasMachineKey: false }),
      translate: async () => { throw new Error('Existing translations must be reused.'); },
    }, emit: event => events.push(event),
  }, {
    detect: async () => ({ ready: true, diagnostics: ['Mock separation only.'] }),
    separate: async (input, output) => {
      await fs.mkdir(output);
      const dialoguePath = path.join(output, 'dialogue.wav'), backgroundPath = path.join(output, 'background.wav');
      await fs.copyFile(input, dialoguePath); await fs.copyFile(input, backgroundPath);
      return { dialoguePath, backgroundPath, duration: (await readWavInfo(input)).duration };
    },
    client: () => ({
      createVoice: async (reference, signal, onCreated) => {
        assert.equal(typeof reference, 'string');
        const info = await readWavInfo(reference as string);
        assert.ok(info.duration >= 10 && info.duration <= 20); assert.equal(info.sampleRate, 24000); assert.equal(info.channels, 1);
        signal?.throwIfAborted(); await onCreated?.({ voiceId, model: DUBBING_MODEL, status: 'DEPLOYING' });
        return { voiceId, model: DUBBING_MODEL, status: 'OK' };
      },
      queryVoice: async () => ({ voiceId, model: DUBBING_MODEL, status: 'OK' }),
      deleteVoice: async () => ({ voiceId, deleted: true }),
      synthesize: async (_text, _id, outputFile, signal) => {
        await runAudioProcess(ffmpeg!, [...ffmpegBase, '-f', 'lavfi', '-i', 'sine=frequency=660:sample_rate=24000:duration=5', '-ac', '1', '-c:a', 'pcm_s16le', outputFile], { signal });
        return { outputFile, bytes: (await fs.stat(outputFile)).size, sampleRate: 24000, durationSeconds: 5 };
      },
    }),
  });
  await service.saveConfig({ pythonPath: 'unused', modelFile: model, baseUrl: 'https://workspace.cn-beijing.maas.aliyuncs.com/api/v1' });
  const result = await service.run({
    jobId: 'real-offline-pipeline', file: source, consent: true, preview: false, offset: 0, backgroundVolume: 0.3,
    cues: [{ id: 1, start: 0, end: 6, text: '原文一', translated: 'First translated cue' }, { id: 2, start: 6, end: 12, text: '原文二', translated: 'Second translated cue' }],
  });
  const audio = await readWavInfo(result.audio);
  assert.equal(audio.sampleRate, 48000); assert.equal(audio.channels, 2); assert.ok(Math.abs(audio.duration - 12) < 0.06);
  const hashVideo = async (file: string) => (await runAudioProcess(ffmpeg!, [...ffmpegBase, '-i', file, '-map', '0:v:0', '-c:v', 'copy', '-f', 'hash', '-hash', 'sha256', '-'])).stdout.trim();
  assert.equal(await hashVideo(result.video), await hashVideo(source));
  assert.match(await fs.readFile(result.subtitles, 'utf8'), /First translated cue\n原文一/);
  assert.equal(events.at(-1)?.stage, 'complete'); assert.equal(service.busy, false);
  const parent = path.dirname(path.dirname(result.video));
  assert.equal((await fs.readdir(parent)).some(file => file.startsWith('.job-')), false);
});
