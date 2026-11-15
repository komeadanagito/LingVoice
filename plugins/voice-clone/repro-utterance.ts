// Opt-in, real-GPU reproduction of the user's cached seventh utterance. Run only when no user synthesis is active.
// Separate phases let the diagnostic synthesis process fully exit before ASR acquires the GPU.
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import ffmpeg from 'ffmpeg-static';
import { LocalPluginManager } from '../../src/main/local-plugins';
import { extractLocalVoiceReference, readWavInfo } from '../../src/main/audio-process';
import { normalizeSpeechForLocalV5 } from '../../src/main/dubbing';
import { validateSynthesizedTranscript } from '../../src/main/speech-validation';
async function main() {
  const root = process.cwd(), manager = new LocalPluginManager(path.join(root, 'plugins'));
  const cache = 'C:/Users/19912/.lingvoice/web/dubbing/cache/310bd41ae6add8314b605a7d7e4922b3d0461d7a71d05f0591a444ab0afdde95';
  const source = path.join(cache, 'speech-cc57f9272ac4f83b63a6e496d5210f9cff4e412bb518507ef035c3e7efa8cede.wav');
  const dir = path.join(root, 'plugins/runtime/tmp/utterance7-repro');
  await fs.mkdir(dir, { recursive: true });
  const spoken = process.argv.includes('--spoken');
  const text = spoken ? normalizeSpeechForLocalV5('GTA VI first release.', 'en') : 'GTA VI first release.';
  const verifyOnly = process.argv.includes('--verify-only');
  const ref = 'diagnostic-utterance7-ref.wav';
  if (!verifyOnly) {
    const info = await readWavInfo(source);
    await extractLocalVoiceReference(source, path.join(manager.referencesDir(), ref), 0, info.duration, 0.25, { ffmpegPath: ffmpeg! });
  }
  let failures = 0;
  try {
    const selectedSeed = process.argv.find(arg => arg.startsWith('--seed='))?.slice(7);
    for (const seed of selectedSeed ? [Number(selectedSeed)] : [42, 143, 349]) {
      const out = path.join(dir, `${spoken ? 'spoken' : 'original'}-${seed}.wav`);
      if (!verifyOnly) {
        const audio = await manager.requestAudio('voice-clone', '/tts', { text, text_lang: 'en', ref_audio_path: ref, prompt_text: 'Plus games you can play GTA V on Xbox for just two thousand.', prompt_lang: 'en', consent: true, speed_factor: 1, seed });
        await fs.writeFile(out, audio);
        console.log({ generated: out, text, seed });
        continue;
      }
      const name = `diagnostic-utterance7-${seed}.wav`;
      await fs.copyFile(out, path.join(manager.inputsDir(), name));
      try {
        const result = await manager.requestJson<{ text?: string; segments?: { text?: string }[] }>('asr', '/infer', { audio_path: name, align: false, chunk_seconds: 20, max_new_tokens: 1024, device: 'cuda' });
        const transcript = Array.isArray(result.segments) ? result.segments.map(s => s.text ?? '').join(' ') : result.text ?? '';
        let error = '';
        try { validateSynthesizedTranscript(text, transcript, 'en'); } catch (e) { error = String(e); failures++; }
        const report = { text, seed, transcript, error, out };
        await fs.writeFile(out + '.json', JSON.stringify(report, null, 2));
        console.log(report);
      } finally { await fs.rm(path.join(manager.inputsDir(), name), { force: true }); }
    }
  } finally {
    if (!verifyOnly) {
      await fs.rm(path.join(manager.referencesDir(), ref), { force: true });
      await manager.stop('voice-clone');
    }
  }
  if (spoken && failures) throw new Error(`${failures} repaired samples failed real ASR verification.`);
}
main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
