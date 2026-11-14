import * as fs from 'node:fs/promises';
import { assertDuration, atomicAudioFile, ffmpegBase, finiteSeconds, localFile, readWavInfo, runAudioProcess, type AudioOptions, type WavInfo } from './audio-process';

export interface AudioSegment { filePath: string; start: number; end: number }
export interface AlignmentPlan { start: number; end: number; duration: number; tempo: number; padding: number }
export interface AlignmentOptions extends AudioOptions { maxTempo?: number }

/** Detects leading and trailing dead-silence padding in synthesized TTS 16-bit PCM WAV files.
 * Returns undefined for synthetic silent test buffers or when no significant silence padding exists.
 */
export async function detectWavTrimBounds(
  filePath: string,
  info: WavInfo,
): Promise<{ trimStart: number; trimEnd: number; trimmedDuration: number } | undefined> {
  if (info.bitsPerSample !== 16 || info.duration <= 0.1) return undefined;
  try {
    const raw = await fs.readFile(filePath);
    if (raw.byteLength <= 44) return undefined;
    const frameBytes = info.channels * 2;
    const totalFrames = Math.floor((raw.byteLength - 44) / frameBytes);
    if (totalFrames < 100) return undefined;
    const view = new DataView(raw.buffer, raw.byteOffset + 44, totalFrames * frameBytes);
    let maxAbs = 0;
    let firstActiveFrame = -1;
    let lastActiveFrame = -1;
    const silenceThreshold = 180;
    for (let f = 0; f < totalFrames; f++) {
      let framePeak = 0;
      for (let c = 0; c < info.channels; c++) {
        const s = Math.abs(view.getInt16((f * info.channels + c) * 2, true));
        if (s > framePeak) framePeak = s;
      }
      if (framePeak > maxAbs) maxAbs = framePeak;
      if (framePeak > silenceThreshold) {
        if (firstActiveFrame < 0) firstActiveFrame = f;
        lastActiveFrame = f;
      }
    }
    // Synthetic all-zero test buffers or near-silent clips remain untrimmed.
    if (maxAbs < 200 || firstActiveFrame < 0 || lastActiveFrame <= firstActiveFrame) return undefined;
    const marginFrames = Math.round(0.025 * info.sampleRate); // Preserve 25 ms natural breath margin
    const startFrame = Math.max(0, firstActiveFrame - marginFrames);
    const endFrame = Math.min(totalFrames, lastActiveFrame + marginFrames);
    const trimStart = startFrame / info.sampleRate;
    const trimEnd = endFrame / info.sampleRate;
    const trimmedDuration = trimEnd - trimStart;
    if (trimmedDuration < 0.05 || info.duration - trimmedDuration < 0.04) return undefined;
    return { trimStart, trimEnd, trimmedDuration };
  } catch {
    return undefined;
  }
}

/** Times are absolute seconds on the original media timeline; shorter speech is never slowed. */
export function planAlignment(sourceDuration: number, start: number, end: number, maxTempo = 1.15): AlignmentPlan {
  finiteSeconds(sourceDuration, 'source duration'); finiteSeconds(start, 'segment start', true); finiteSeconds(end, 'segment end');
  if (!Number.isFinite(maxTempo) || maxTempo < 1 || maxTempo > 2) throw new Error('Invalid maxTempo.');
  const duration = end - start;
  if (duration < 1 / 48000) throw new Error('Segment must contain at least one 48 kHz sample.');
  const ratio = sourceDuration / duration;
  const pct = Math.round((maxTempo - 1) * 100);
  if (ratio > maxTempo + 1e-10) throw new Error(`Speech exceeds its time slot by more than ${pct}%; regenerate shorter speech or revise timestamps. Audio will not be truncated.`);
  return { start, end, duration, tempo: Math.max(1, ratio), padding: Math.max(0, duration - sourceDuration) };
}

/** Fast in-memory 24kHz/48kHz -> 48kHz stereo 16-bit PCM slot alignment when tempo === 1 (avoids spawning FFmpeg per cue). */
async function alignPcmInMemory(
  inputPath: string,
  source: WavInfo,
  targetFrames: number,
  outputPath: string,
  trim?: { trimStart: number; trimEnd: number },
): Promise<WavInfo | undefined> {
  if (source.bitsPerSample !== 16 || (source.sampleRate !== 24000 && source.sampleRate !== 48000) || (source.channels !== 1 && source.channels !== 2)) {
    return undefined;
  }
  const raw = await fs.readFile(inputPath);
  // Only handle standard 44-byte RIFF PCM headers in memory; delegate RF64/extensible headers to FFmpeg.
  if (raw.byteLength < 44 || raw.toString('ascii', 0, 4) !== 'RIFF' || raw.toString('ascii', 36, 40) !== 'data') {
    return undefined;
  }
  const frameBytes = source.channels * 2;
  const totalInFrames = Math.floor((raw.byteLength - 44) / frameBytes);
  const startFrame = trim ? Math.max(0, Math.min(totalInFrames, Math.floor(trim.trimStart * source.sampleRate))) : 0;
  const endFrame = trim ? Math.max(startFrame, Math.min(totalInFrames, Math.ceil(trim.trimEnd * source.sampleRate))) : totalInFrames;
  const activeInFrames = endFrame - startFrame;
  const inView = new DataView(raw.buffer, raw.byteOffset + 44, totalInFrames * frameBytes);

  const outDataBytes = targetFrames * 4; // 48 kHz stereo 16-bit
  const outBuf = Buffer.alloc(44 + outDataBytes);
  outBuf.write('RIFF', 0);
  outBuf.writeUInt32LE(36 + outDataBytes, 4);
  outBuf.write('WAVE', 8);
  outBuf.write('fmt ', 12);
  outBuf.writeUInt32LE(16, 16);
  outBuf.writeUInt16LE(1, 20);
  outBuf.writeUInt16LE(2, 22);
  outBuf.writeUInt32LE(48000, 24);
  outBuf.writeUInt32LE(48000 * 4, 28);
  outBuf.writeUInt16LE(4, 32);
  outBuf.writeUInt16LE(16, 34);
  outBuf.write('data', 36);
  outBuf.writeUInt32LE(outDataBytes, 40);

  const outView = new DataView(outBuf.buffer, outBuf.byteOffset + 44, outDataBytes);
  const readChannel = (f: number, ch: number): number => {
    const idx = Math.min(endFrame - 1, startFrame + f);
    const c = source.channels === 1 ? 0 : ch;
    return inView.getInt16((idx * source.channels + c) * 2, true);
  };

  if (source.sampleRate === 48000) {
    const copyFrames = Math.min(targetFrames, activeInFrames);
    for (let f = 0; f < copyFrames; f++) {
      const l = readChannel(f, 0);
      const r = readChannel(f, 1);
      outView.setInt16(f * 4, l, true);
      outView.setInt16(f * 4 + 2, r, true);
    }
  } else {
    // 24 kHz -> 48 kHz 2x linear interpolation
    const maxOutFrames = Math.min(targetFrames, activeInFrames * 2);
    for (let outF = 0; outF < maxOutFrames; outF++) {
      const inF = outF >> 1;
      const odd = (outF & 1) === 1;
      const l0 = readChannel(inF, 0);
      const r0 = readChannel(inF, 1);
      const l = odd && inF + 1 < activeInFrames ? (l0 + readChannel(inF + 1, 0)) >> 1 : l0;
      const r = odd && inF + 1 < activeInFrames ? (r0 + readChannel(inF + 1, 1)) >> 1 : r0;
      outView.setInt16(outF * 4, l, true);
      outView.setInt16(outF * 4 + 2, r, true);
    }
  }

  await fs.writeFile(outputPath, outBuf, { mode: 0o600 });
  return readWavInfo(outputPath);
}

/** Produces slot-length 48 kHz stereo PCM; place it at returned start, not at time zero. */
export async function alignAudio(segment: AudioSegment, outputPath: string, options: AlignmentOptions): Promise<AudioSegment & { info: WavInfo; plan: AlignmentPlan }> {
  const input = await localFile(segment.filePath);
  const source = await readWavInfo(input);
  const slotDuration = segment.end - segment.start;
  const trim = source.duration > slotDuration ? await detectWavTrimBounds(input, source) : undefined;
  const effectiveDuration = trim ? trim.trimmedDuration : source.duration;
  const plan = planAlignment(effectiveDuration, segment.start, segment.end, options.maxTempo);
  const frames = Math.round(segment.end * 48000) - Math.round(segment.start * 48000);
  if (frames < 1) throw new Error('Segment must contain at least one 48 kHz sample.');
  const filters: string[] = [];
  if (trim) {
    filters.push(`atrim=start=${trim.trimStart.toFixed(6)}:end=${trim.trimEnd.toFixed(6)}`, 'asetpts=PTS-STARTPTS');
  }
  filters.push(`aresample=48000`, `aformat=sample_fmts=s16:channel_layouts=stereo`);
  if (plan.tempo > 1) filters.push(`atempo=${plan.tempo.toFixed(12)}`);
  // atrim only establishes the exact sample boundary after tempo conversion/padding.
  filters.push(`apad=whole_len=${frames}`, `atrim=end_sample=${frames}`, 'asetpts=PTS-STARTPTS');
  const info = await atomicAudioFile(outputPath, options.signal, async temporary => {
    if (plan.tempo === 1) {
      const fastResult = await alignPcmInMemory(input, source, frames, temporary, trim);
      if (fastResult) {
        assertDuration(fastResult.duration, frames / 48000, 1 / 48000);
        return fastResult;
      }
    }
    await runAudioProcess(options.ffmpegPath, [...ffmpegBase, '-i', input, '-vn', '-af', filters.join(','), '-ac', '2', '-ar', '48000', '-c:a', 'pcm_s16le', '-rf64', 'auto', '-f', 'wav', temporary], options);
    const result = await readWavInfo(temporary); assertDuration(result.duration, frames / 48000, 1 / 48000); return result;
  });
  return { filePath: outputPath, start: segment.start, end: segment.end, info, plan };
}
