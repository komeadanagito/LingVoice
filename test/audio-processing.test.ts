import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import ffmpegPath from 'ffmpeg-static';
import { assertDuration, atomicAudioFile, buildSmartBackground, extractAudio, extractLocalVoiceReference, extractVoiceReference, ffmpegBase, readWavInfo, runAudioProcess, separateAudioFfmpegFallback } from '../src/main/audio-process';
import { alignAudio, planAlignment } from '../src/main/audio-alignment';
import { buildAudioTimeline, mixDubbedVideo } from '../src/main/audio-mix';
import { detectSeparationEnvironment, separateAudio } from '../src/main/audio-separation';

async function temporary(work: (directory: string) => Promise<void>): Promise<void> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lingvoice-audio-test-'));
  try { await work(directory); } finally { await fs.rm(directory, { recursive: true, force: true }); }
}
function wavHeader(frames = 48000): Buffer {
  const buffer = Buffer.alloc(44 + frames * 4);
  buffer.write('RIFF'); buffer.writeUInt32LE(buffer.length - 8, 4); buffer.write('WAVEfmt ', 8);
  buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(2, 22);
  buffer.writeUInt32LE(48000, 24); buffer.writeUInt32LE(192000, 28); buffer.writeUInt16LE(4, 32); buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36); buffer.writeUInt32LE(frames * 4, 40); return buffer;
}

test('alignment permits exactly 15%, pads short speech, and rejects invalid/overlong slots', () => {
  assert.equal(planAlignment(11.5, 100, 110).tempo, 1.15);
  assert.deepEqual(planAlignment(8, 100, 110), { start: 100, end: 110, duration: 10, tempo: 1, padding: 2 });
  for (const values of [[11.5001, 0, 10], [1, -1, 2], [1, 2, 1], [0, 0, 1], [NaN, 0, 1], [1, 0, Infinity]]) assert.throws(() => planAlignment(...values as [number, number, number]));
  assert.throws(() => assertDuration(10.1, 10)); assert.throws(() => assertDuration(1, 1, NaN));
  assertDuration(10.05, 10);
});

test('absolute timeline sorts segments and includes leading, internal and trailing silence', () => {
  const pieces = buildAudioTimeline([{ filePath: 'b', start: 3, end: 4 }, { filePath: 'a', start: 1, end: 2 }], 5);
  assert.deepEqual(pieces.map(piece => [piece.startFrame, piece.frames, piece.segment?.filePath]), [[0, 48000, undefined], [48000, 48000, 'a'], [96000, 48000, undefined], [144000, 48000, 'b'], [192000, 48000, undefined]]);
  assert.equal(buildAudioTimeline([], 1)[0].frames, 48000);
  for (const segments of [[{ filePath: 'a', start: 0, end: 2 }, { filePath: 'b', start: 1, end: 3 }], [{ filePath: 'a', start: 0, end: 6 }], [{ filePath: 'a', start: NaN, end: 1 }], [{ filePath: 'a', start: 1, end: 1 }]]) assert.throws(() => buildAudioTimeline(segments, 5));
  assert.throws(() => buildAudioTimeline([], 0.000001));
  assert.equal(buildAudioTimeline(Array.from({ length: 1000 }, (_, index) => ({ filePath: `file-${index}`, start: index, end: index + 0.5 })), 1000).length, 2000);
});

test('WAV parser accepts PCM, unknown streaming data length, RF64, and rejects truncated PCM', async () => temporary(async directory => {
  const file = path.join(directory, 'fixture.wav'), pcm = wavHeader();
  await fs.writeFile(file, pcm); assert.equal((await readWavInfo(file)).duration, 1);
  pcm.writeUInt32LE(0xffffffff, 4); pcm.writeUInt32LE(0xffffffff, 40);
  await fs.writeFile(file, pcm); assert.equal((await readWavInfo(file)).frames, 48000);
  const rf = Buffer.alloc(pcm.length + 36);
  rf.write('RF64'); rf.writeUInt32LE(0xffffffff, 4); rf.write('WAVEds64', 8); rf.writeUInt32LE(28, 16);
  rf.writeBigUInt64LE(BigInt(rf.length - 8), 20); rf.writeBigUInt64LE(BigInt(192000), 28); rf.writeBigUInt64LE(48000n, 36); pcm.copy(rf, 48, 12);
  await fs.writeFile(file, rf); assert.equal((await readWavInfo(file)).duration, 1);
  await fs.writeFile(file, wavHeader().subarray(0, 100)); await assert.rejects(readWavInfo(file), /Truncated/);
  await fs.writeFile(file, Buffer.from('not a wav header')); await assert.rejects(readWavInfo(file), /WAV/);
}));

test('atomic publication cleans partial files and never overwrites an existing output', async () => temporary(async directory => {
  const target = path.join(directory, 'output.wav');
  await assert.rejects(atomicAudioFile(target, undefined, async file => { await fs.writeFile(file, 'partial'); throw new Error('fixture failure'); }), /fixture failure/);
  assert.deepEqual(await fs.readdir(directory), []);
  await fs.writeFile(target, 'original');
  await assert.rejects(atomicAudioFile(target, undefined, async file => { await fs.writeFile(file, 'replacement'); }), /EEXIST/);
  assert.equal(await fs.readFile(target, 'utf8'), 'original');
  assert.deepEqual(await fs.readdir(directory), ['output.wav']);
}));

test('process runner bounds logs, deadlines, cancellation and handles nonzero exits', async () => {
  await assert.rejects(runAudioProcess(process.execPath, ['-e', 'process.stdout.write("x".repeat(4096))'], { maxOutputBytes: 128 }), /output limit/);
  await assert.rejects(runAudioProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeoutMs: 100 }), /timed out/);
  const controller = new AbortController();
  const pending = runAudioProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { signal: controller.signal });
  setTimeout(() => controller.abort(), 100);
  await assert.rejects(pending, { name: 'AbortError' });
  await assert.rejects(runAudioProcess(process.execPath, ['-e', 'console.error("fixture error"); process.exit(2)']), /fixture error/);
  assert.throws(() => runAudioProcess(process.execPath, [], { timeoutMs: -1 }), /deadline/);
  const output = await runAudioProcess(process.execPath, ['-e', 'console.log(process.argv[1])', 'a & b | c']); assert.equal(output.stdout.trim(), 'a & b | c');
});

test('environment detection returns actionable local-file diagnostics without installing', async () => temporary(async directory => {
  const options = { ffmpegPath: ffmpegPath!, pythonPath: path.join(directory, 'missing-python.exe'), helperPath: path.join(directory, 'missing-helper.py'), modelPath: path.join(directory, 'missing-model.onnx') };
  const result = await detectSeparationEnvironment(options); assert.equal(result.ready, false); assert.match(result.diagnostics.join(' '), /Verify.*Python/);
  await assert.rejects(separateAudio(path.join(directory, 'missing.wav'), path.join(directory, 'output'), options));
  await assert.rejects(fs.stat(path.join(directory, 'output')), /ENOENT/);
}));

test('FFmpeg fallback silences all background samples and retains source reference for mono and stereo', { skip: !ffmpegPath }, async () => temporary(async directory => {
  const options = { ffmpegPath: ffmpegPath!, timeoutMs: 30_000 };
  // Centre speech, off-centre speech/reverb, and frequencies outside the former vocal band.
  const fixtures = [
    '0.2*sin(2*PI*440*t)',
    '0.2*sin(2*PI*440*t)|0.2*sin(2*PI*440*t)',
    '0.2*sin(2*PI*440*t)+0.1*sin(2*PI*80*t)|0.08*sin(2*PI*440*(t-0.01))+0.1*sin(2*PI*6000*t)',
  ];
  for (const [index, expression] of fixtures.entries()) {
    const source = path.join(directory, `source-${index}.wav`);
    await runAudioProcess(ffmpegPath!, [...ffmpegBase, '-f', 'lavfi', '-i', `aevalsrc=${expression}:s=48000:d=0.37`, '-c:a', 'pcm_s16le', source], options);
    const output = path.join(directory, `stems-${index}`);
    await fs.mkdir(output);
    await fs.writeFile(path.join(output, 'background.wav'), 'stale DSP background');
    const stems = await separateAudioFfmpegFallback(source, output, options);
    const sourceInfo = await readWavInfo(source);
    assert.equal(stems.duration, sourceInfo.duration);
    for (const file of [stems.dialoguePath, stems.backgroundPath]) {
      const info = await readWavInfo(file);
      assert.equal(info.frames, sourceInfo.frames);
      assert.equal(info.sampleRate, 48000);
      assert.equal(info.channels, 2);
      assert.equal(info.bitsPerSample, 16);
    }
    const decode = async (file: string, name: string) => {
      const pcm = path.join(directory, `${name}-${index}.pcm`);
      await runAudioProcess(ffmpegPath!, [...ffmpegBase, '-i', file, '-ac', '2', '-ar', '48000', '-c:a', 'pcm_s16le', '-f', 's16le', pcm], options);
      return fs.readFile(pcm);
    };
    const background = await decode(stems.backgroundPath, 'background');
    assert.equal(background.length, sourceInfo.frames * 4);
    assert.ok(background.every(byte => byte === 0), 'Background must contain exact digital silence, not filtered source speech.');
    const reference = await decode(stems.dialoguePath, 'reference');
    assert.ok(reference.some(byte => byte !== 0));
    assert.deepEqual(reference, await decode(source, 'source'), 'Reference must preserve the full source mix.');
  }
  assert.equal((await fs.readdir(directory)).some(name => name.startsWith('.silent-separation-stage-')), false);
}));

test('FFmpeg silent fallback preserves existing stems on failure and cancellation', { skip: !ffmpegPath }, async () => temporary(async directory => {
  const source = path.join(directory, 'source.wav'), output = path.join(directory, 'stems');
  await fs.writeFile(source, wavHeader());
  await fs.mkdir(output);
  const existing = path.join(output, 'background.wav');
  await fs.writeFile(existing, 'existing background');
  await assert.rejects(separateAudioFfmpegFallback(source, output, { ffmpegPath: path.join(directory, 'missing-ffmpeg.exe') }));
  const controller = new AbortController(); controller.abort();
  await assert.rejects(separateAudioFfmpegFallback(source, output, { ffmpegPath: ffmpegPath!, signal: controller.signal }), { name: 'AbortError' });
  assert.equal(await fs.readFile(existing, 'utf8'), 'existing background');
  assert.deepEqual((await fs.readdir(directory)).sort(), ['source.wav', 'stems']);
}));

test('real FFmpeg reference accepts exact 5 and 20 second boundaries and rejects outside the range', { skip: !ffmpegPath }, async () => temporary(async directory => {
  const options = { ffmpegPath: ffmpegPath!, timeoutMs: 30_000 };
  const dialogue = path.join(directory, 'dialogue.wav');
  await runAudioProcess(ffmpegPath!, [...ffmpegBase, '-f', 'lavfi', '-i', 'sine=frequency=440:duration=20', '-ar', '48000', '-ac', '2', '-c:a', 'pcm_s16le', dialogue]);
  for (const duration of [5, 9, 20]) {
    const output = path.join(directory, `reference-${duration}.wav`);
    const reference = await extractVoiceReference(dialogue, output, 20 - duration, duration, options);
    assert.equal(reference.duration, duration); assert.equal(reference.frames, duration * 24000);
    assert.equal(reference.sampleRate, 24000); assert.equal(reference.channels, 1); assert.equal(reference.bitsPerSample, 16);
    assert.equal((await readWavInfo(output)).frames, duration * 24000);
  }
  for (const duration of [4.999, 20.001, NaN]) {
    const output = path.join(directory, `invalid-${String(duration)}.wav`);
    await assert.rejects(extractVoiceReference(dialogue, output, 0, duration, options), /5–20/);
    await assert.rejects(fs.stat(output), /ENOENT/);
  }
}));

test('real FFmpeg local reference trims continuing source before adding genuinely silent padding', { skip: !ffmpegPath }, async () => temporary(async directory => {
  const options = { ffmpegPath: ffmpegPath!, timeoutMs: 30_000 };
  const source = path.join(directory, 'continuing-tone.wav');
  // Use the output sample rate so every padded sample must be zero, without resampling transients.
  await runAudioProcess(ffmpegPath!, [...ffmpegBase, '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=24000:duration=12', '-ac', '1', '-c:a', 'pcm_s16le', source], options);
  const decode = async (file: string, name: string) => {
    const pcm = path.join(directory, `${name}.pcm`);
    await runAudioProcess(ffmpegPath!, [...ffmpegBase, '-i', file, '-c:a', 'pcm_s16le', '-f', 's16le', pcm], options);
    return fs.readFile(pcm);
  };
  const sourcePcm = await decode(source, 'source');
  const sampleRate = 24000, bytesPerFrame = 2, start = 1.25;
  // Exercise explicit padding plus the minimum and maximum total-duration limits.
  for (const [duration, padding, expected] of [[4, 0.5, 4.5], [2.5, 0.4, 3.1], [9.5, 1, 9.9]]) {
    const output = path.join(directory, `local-reference-${duration}.wav`);
    const reference = await extractLocalVoiceReference(source, output, start, duration, padding, options);
    assert.equal(reference.sampleRate, sampleRate);
    assert.equal(reference.channels, 1);
    assert.equal(reference.bitsPerSample, 16);
    assert.equal(reference.frames, Math.round(expected * sampleRate));
    assert.equal(reference.duration, expected);
    const pcm = await decode(output, `local-reference-${duration}`);
    const startByte = Math.round(start * sampleRate) * bytesPerFrame;
    const voicedBytes = Math.round(duration * sampleRate) * bytesPerFrame;
    assert.equal(pcm.length, reference.frames * bytesPerFrame);
    assert.deepEqual(pcm.subarray(0, voicedBytes), sourcePcm.subarray(startByte, startByte + voicedBytes), 'Selected source interval must be preserved exactly.');
    const tail = pcm.subarray(voicedBytes);
    assert.equal(tail.length, Math.round((expected - duration) * sampleRate) * bytesPerFrame);
    assert.ok(tail.length > 0);
    assert.ok(sourcePcm.subarray(startByte + voicedBytes, startByte + pcm.length).some(byte => byte !== 0), 'Source must continue sounding throughout the interval that should be padding.');
    assert.ok(tail.every(byte => byte === 0), 'Entire padded tail must be digital silence, not additional source audio from a duplicate output -t.');
  }
  assert.equal((await fs.readdir(directory)).some(name => name.startsWith('.audio-stage-')), false);
}));

test('real FFmpeg extraction, reference, padding, tempo and video-copy MKV mixing', { skip: !ffmpegPath }, async () => temporary(async directory => {
  const options = { ffmpegPath: ffmpegPath!, timeoutMs: 30_000 };
  const source = path.join(directory, "语音 & fixture's.wav");
  await runAudioProcess(ffmpegPath!, [...ffmpegBase, '-f', 'lavfi', '-i', 'sine=frequency=440:duration=12', '-c:a', 'pcm_s16le', source]);
  const extracted = path.join(directory, 'extracted.wav'), info = await extractAudio(source, extracted, options);
  assert.equal(info.sampleRate, 48000); assert.equal(info.channels, 2); assert.equal(info.bitsPerSample, 16); assertDuration(info.duration, 12, 1 / 48000);
  const reference = await extractVoiceReference(extracted, path.join(directory, 'reference.wav'), 1, 10, options);
  assert.equal(reference.sampleRate, 24000); assert.equal(reference.channels, 1); assert.equal(reference.bitsPerSample, 16); assert.equal(reference.duration, 10);
  const extensible = path.join(directory, 'extensible.wav');
  await runAudioProcess(ffmpegPath!, [...ffmpegBase, '-f', 'lavfi', '-i', 'sine=frequency=330:duration=0.1', '-ac', '2', '-c:a', 'pcm_s24le', extensible]);
  const extensibleInfo = await readWavInfo(extensible); assert.equal(extensibleInfo.bitsPerSample, 24); assert.equal(extensibleInfo.channels, 2);
  await assert.rejects(extractVoiceReference(extracted, path.join(directory, 'invalid.wav'), 0, 21, options), /5–20/);
  await assert.rejects(extractVoiceReference(extracted, path.join(directory, 'invalid.wav'), -1, 10, options), /reference start/);
  await assert.rejects(extractVoiceReference(extracted, path.join(directory, 'invalid.wav'), 0, 4.999, options), /5–20/);
  await assert.rejects(extractVoiceReference(extracted, path.join(directory, 'invalid.wav'), 3, 10, options), /beyond/);
  const speech = path.join(directory, 'speech.wav');
  await runAudioProcess(ffmpegPath!, [...ffmpegBase, '-f', 'lavfi', '-i', 'sine=frequency=660:duration=0.4', '-c:a', 'pcm_s16le', speech]);
  const aligned = await alignAudio({ filePath: speech, start: 0.3, end: 0.8 }, path.join(directory, 'aligned.wav'), options);
  assert.equal(aligned.info.frames, 24000); assert.equal(aligned.plan.tempo, 1);
  const fractional = await alignAudio({ filePath: speech, start: 0.30001, end: 0.80002 }, path.join(directory, 'fractional.wav'), options);
  assert.equal(fractional.info.frames, buildAudioTimeline([fractional], 2).find(piece => piece.segment)?.frames);
  const accelerated = await alignAudio({ filePath: speech, start: 1, end: 1.35 }, path.join(directory, 'accelerated.wav'), options);
  assert.equal(accelerated.info.frames, 16800); assert.ok(accelerated.plan.tempo > 1);
  const chainedTempo = await alignAudio({ filePath: speech, start: 1.5, end: 1.65 }, path.join(directory, 'chained-tempo.wav'), { ...options, maxTempo: 3.5 });
  assert.equal(chainedTempo.info.frames, 7200); assert.ok(chainedTempo.plan.tempo > 2);
  await assert.rejects(alignAudio({ filePath: speech, start: 0, end: 0.3 }, path.join(directory, 'overlong.wav'), options), /15%/);
  const background = path.join(directory, 'background.wav'), video = path.join(directory, 'original.mkv');
  await runAudioProcess(ffmpegPath!, [...ffmpegBase, '-f', 'lavfi', '-i', 'sine=frequency=220:duration=2', '-ar', '48000', '-ac', '2', '-c:a', 'pcm_s16le', background]);
  await runAudioProcess(ffmpegPath!, [...ffmpegBase, '-f', 'lavfi', '-i', 'color=c=black:s=32x32:r=10:d=2', '-c:v', 'mpeg4', video]);
  const result = await mixDubbedVideo({ videoPath: video, backgroundPath: background, segments: [aligned, accelerated], duration: 2, outputPath: path.join(directory, 'dubbed.mkv') }, options);
  assert.ok((await fs.stat(result.outputPath)).size > 0);
  const mixed = await extractAudio(result.outputPath, path.join(directory, 'final-audio.wav'), options); assertDuration(mixed.duration, 2, 0.05);
  const silentResult = await mixDubbedVideo({ videoPath: video, backgroundPath: background, segments: [], duration: 2, outputPath: path.join(directory, 'background-only.mkv') }, options);
  assert.equal(silentResult.duration, 2);
  await assert.rejects(mixDubbedVideo({ videoPath: video, backgroundPath: background, segments: [{ filePath: speech, start: 0, end: 0.5 }], duration: 2, outputPath: path.join(directory, 'invalid-mix.mkv') }, options), /Call alignAudio first/);
  await assert.rejects(fs.stat(path.join(directory, 'invalid-mix.mkv')), /ENOENT/);
  const badSource = path.join(directory, 'not-audio.bin'); await fs.writeFile(badSource, 'not audio');
  await assert.rejects(extractAudio(badSource, path.join(directory, 'invalid-extraction.wav'), options));
  await assert.rejects(fs.stat(path.join(directory, 'invalid-extraction.wav')), /ENOENT/);
  assert.equal((await fs.readdir(directory)).some(name => name.startsWith('.audio-stage-')), false);
}));

test('buildSmartBackground restores original BGM during non-dialogue gaps while keeping separated BGM during speech', async () => temporary(async directory => {
  const rate = 48000, ch = 2, duration = 4, frames = rate * duration;
  const makeWav = (sampleValue: number) => {
    const buf = Buffer.alloc(44 + frames * ch * 2);
    buf.write('RIFF', 0); buf.writeUInt32LE(36 + frames * ch * 2, 4); buf.write('WAVE', 8);
    buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(ch, 22);
    buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * ch * 2, 28); buf.writeUInt16LE(ch * 2, 32); buf.writeUInt16LE(16, 34);
    buf.write('data', 36); buf.writeUInt32LE(frames * ch * 2, 40);
    for (let i = 0; i < frames * ch; i++) buf.writeInt16LE(sampleValue, 44 + i * 2);
    return buf;
  };
  const srcPath = path.join(directory, 'source.wav');
  const bgPath = path.join(directory, 'background.wav');
  const outPath = path.join(directory, 'smart-background.wav');
  await fs.writeFile(srcPath, makeWav(8000));
  await fs.writeFile(bgPath, makeWav(1000));
  const result = await buildSmartBackground(srcPath, bgPath, outPath, [{ start: 2.0, end: 3.5 }], 0, duration);
  assert.equal(result, outPath);
  const outBuf = await fs.readFile(outPath);
  // At 0.5s (well inside non-dialogue gap 0..1.75s): should restore source audio (8000)
  assert.equal(outBuf.readInt16LE(44 + Math.round(0.5 * rate) * ch * 2), 8000);
  // At 2.75s (well inside dialogue window 1.75..3.75s): should keep separated background (1000)
  assert.equal(outBuf.readInt16LE(44 + Math.round(2.75 * rate) * ch * 2), 1000);
}));
