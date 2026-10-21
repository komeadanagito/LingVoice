import { assertDuration, atomicAudioFile, ffmpegBase, finiteSeconds, localFile, readWavInfo, runAudioProcess, type AudioOptions, type WavInfo } from './audio-process';

export interface AudioSegment { filePath: string; start: number; end: number }
export interface AlignmentPlan { start: number; end: number; duration: number; tempo: number; padding: number }

/** Times are absolute seconds on the original media timeline; shorter speech is never slowed. */
export function planAlignment(sourceDuration: number, start: number, end: number): AlignmentPlan {
  finiteSeconds(sourceDuration, 'source duration'); finiteSeconds(start, 'segment start', true); finiteSeconds(end, 'segment end');
  const duration = end - start;
  if (duration < 1 / 48000) throw new Error('Segment must contain at least one 48 kHz sample.');
  const ratio = sourceDuration / duration;
  if (ratio > 1.15 + 1e-10) throw new Error('Speech exceeds its time slot by more than 15%; regenerate shorter speech or revise timestamps. Audio will not be truncated.');
  return { start, end, duration, tempo: Math.max(1, ratio), padding: Math.max(0, duration - sourceDuration) };
}

/** Produces slot-length 48 kHz stereo PCM; place it at returned start, not at time zero. */
export async function alignAudio(segment: AudioSegment, outputPath: string, options: AudioOptions): Promise<AudioSegment & { info: WavInfo; plan: AlignmentPlan }> {
  const input = await localFile(segment.filePath);
  const source = await readWavInfo(input);
  const plan = planAlignment(source.duration, segment.start, segment.end);
  const frames = Math.round(segment.end * 48000) - Math.round(segment.start * 48000);
  if (frames < 1) throw new Error('Segment must contain at least one 48 kHz sample.');
  const filters = [`aresample=48000`, `aformat=sample_fmts=s16:channel_layouts=stereo`];
  if (plan.tempo > 1) filters.push(`atempo=${plan.tempo.toFixed(12)}`);
  // atrim only establishes the exact sample boundary after tempo conversion/padding.
  filters.push(`apad=whole_len=${frames}`, `atrim=end_sample=${frames}`, 'asetpts=PTS-STARTPTS');
  const info = await atomicAudioFile(outputPath, options.signal, async temporary => {
    await runAudioProcess(options.ffmpegPath, [...ffmpegBase, '-i', input, '-vn', '-af', filters.join(','), '-ac', '2', '-ar', '48000', '-c:a', 'pcm_s16le', '-rf64', 'auto', '-f', 'wav', temporary], options);
    const result = await readWavInfo(temporary); assertDuration(result.duration, frames / 48000, 1 / 48000); return result;
  });
  return { filePath: outputPath, start: segment.start, end: segment.end, info, plan };
}
