import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { type AudioSegment } from './audio-alignment';
import { assertDuration, atomicAudioFile, checkCancelled, ffmpegBase, finiteSeconds, localFile, readWavInfo, runAudioProcess, type AudioOptions } from './audio-process';

export interface AudioMixRequest {
  videoPath: string;
  backgroundPath: string;
  segments: readonly AudioSegment[];
  duration: number;
  outputPath: string;
  backgroundGain?: number;
  dialogueGain?: number;
}
export interface TimelinePiece { startFrame: number; frames: number; segment?: AudioSegment }

/** Non-overlapping absolute slots. Gaps and trailing silence are explicit, sample-accurate. */
export function buildAudioTimeline(segments: readonly AudioSegment[], duration: number): TimelinePiece[] {
  finiteSeconds(duration, 'total duration');
  if (segments.length > 10000) throw new Error('Too many dubbing segments (maximum 10000).');
  const total = Math.round(duration * 48000), pieces: TimelinePiece[] = [];
  if (!total) throw new Error('Total duration must contain at least one sample.');
  let cursor = 0, previousEnd = 0;
  const sorted = [...segments].sort((a, b) => a.start - b.start);
  for (const segment of sorted) {
    finiteSeconds(segment.start, 'segment start', true); finiteSeconds(segment.end, 'segment end');
    if (segment.end <= segment.start || segment.start < previousEnd || segment.end > duration) throw new Error('Segments must not overlap or extend beyond the total duration.');
    const start = Math.round(segment.start * 48000), end = Math.round(segment.end * 48000);
    if (end <= start) throw new Error('Segment must contain at least one sample.');
    if (start > cursor) pieces.push({ startFrame: cursor, frames: start - cursor });
    pieces.push({ startFrame: start, frames: end - start, segment }); cursor = end; previousEnd = segment.end;
  }
  if (cursor < total) pieces.push({ startFrame: cursor, frames: total - cursor });
  return pieces;
}

/** Writes a sample-accurate 48 kHz stereo 16-bit PCM silent WAV file directly without spawning FFmpeg. */
async function writeSilentWav(filePath: string, frames: number): Promise<void> {
  const bytesPerFrame = 4; // 2 channels * 16-bit
  const dataBytes = frames * bytesPerFrame;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(Math.min(0xffffffff, 36 + dataBytes), 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(2, 22); // 2 channels (stereo)
  header.writeUInt32LE(48000, 24); // 48 kHz
  header.writeUInt32LE(48000 * bytesPerFrame, 28);
  header.writeUInt16LE(bytesPerFrame, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(Math.min(0xffffffff, dataBytes), 40);
  const handle = await fs.open(filePath, 'w', 0o600);
  try {
    await handle.write(header, 0, 44, 0);
    await handle.truncate(44 + dataBytes);
  } finally {
    await handle.close();
  }
}

/** Input segments must be the canonical WAV files returned by alignAudio. Output is a new MKV file. */
export async function mixDubbedVideo(request: AudioMixRequest, options: AudioOptions): Promise<{ outputPath: string; duration: number }> {
  if (path.extname(request.outputPath).toLowerCase() !== '.mkv') throw new Error('Dubbed video output must use .mkv for video stream-copy compatibility.');
  const pieces = buildAudioTimeline(request.segments, request.duration);
  const backgroundGain = request.backgroundGain ?? 1, dialogueGain = request.dialogueGain ?? 1;
  for (const gain of [backgroundGain, dialogueGain]) if (!Number.isFinite(gain) || gain < 0 || gain > 4) throw new Error('Mix gains must be between 0 and 4.');
  const video = await localFile(request.videoPath), background = await localFile(request.backgroundPath);
  assertDuration((await readWavInfo(background)).duration, request.duration);
  return atomicAudioFile(request.outputPath, options.signal, async temporary => {
    const directory = path.dirname(temporary), lines = ['ffconcat version 1.0'];
    for (let index = 0; index < pieces.length; index++) {
      checkCancelled(options.signal);
      const piece = pieces[index], name = `piece-${index}.wav`, target = path.join(directory, name);
      if (piece.segment) {
        const input = await localFile(piece.segment.filePath), info = await readWavInfo(input);
        if (info.sampleRate !== 48000 || info.channels !== 2 || info.bitsPerSample !== 16 || info.frames !== piece.frames) throw new Error('Mix segments must be slot-aligned 48 kHz stereo 16-bit PCM WAV files. Call alignAudio first.');
        // Copy into private staging: safe relative concat names and no source-file mutation race.
        await fs.copyFile(input, target);
      } else {
        await writeSilentWav(target, piece.frames);
      }
      lines.push(`file '${name}'`);
    }
    const list = path.join(directory, 'timeline.ffconcat');
    await fs.writeFile(list, `${lines.join('\n')}\n`, 'utf8');
    const timeline = path.join(directory, 'timeline.wav');
    await runAudioProcess(options.ffmpegPath, [...ffmpegBase, '-f', 'concat', '-safe', '1', '-i', list, '-c:a', 'pcm_s16le', '-rf64', 'auto', timeline], options);
    const totalFrames = Math.round(request.duration * 48000);
    assertDuration((await readWavInfo(timeline)).duration, totalFrames / 48000, 1 / 48000);
    const filter = path.join(directory, 'mix.filter');
    const useDucking = request.segments.length > 0 && backgroundGain > 0 && dialogueGain > 0;
    const filterScript = useDucking
      ? `[0:a]aresample=48000,aformat=sample_fmts=s16:channel_layouts=stereo,volume=${backgroundGain}[bg];\n` +
        `[1:a]highpass=f=80,aformat=sample_fmts=s16:channel_layouts=stereo,volume=${dialogueGain},asplit=2[voice][sc];\n` +
        `[bg][sc]sidechaincompress=threshold=0.03:ratio=4:attack=25:release=300:makeup=1[bg_ducked];\n` +
        `[bg_ducked][voice]amix=inputs=2:duration=longest:dropout_transition=0:normalize=0,alimiter=limit=0.95:level=0:latency=1,apad=whole_len=${totalFrames},atrim=end_sample=${totalFrames},asetpts=PTS-STARTPTS[mix]\n`
      : `[0:a]aresample=48000,aformat=channel_layouts=stereo,volume=${backgroundGain}[bg];\n` +
        `[1:a]volume=${dialogueGain}[voice];\n` +
        `[bg][voice]amix=inputs=2:duration=longest:dropout_transition=0:normalize=0,alimiter=limit=0.95:level=0:latency=1,apad=whole_len=${totalFrames},atrim=end_sample=${totalFrames},asetpts=PTS-STARTPTS[mix]\n`;
    await fs.writeFile(filter, filterScript);
    const mixed = path.join(directory, 'mixed.wav');
    await runAudioProcess(options.ffmpegPath, [...ffmpegBase, '-i', background, '-i', timeline, '-filter_complex_script', filter, '-map', '[mix]', '-ar', '48000', '-ac', '2', '-c:a', 'pcm_s16le', '-rf64', 'auto', mixed], options);
    assertDuration((await readWavInfo(mixed)).duration, totalFrames / 48000, 1 / 48000);
    await runAudioProcess(options.ffmpegPath, [...ffmpegBase, '-i', video, '-i', mixed, '-map', '0:v:0', '-map', '1:a:0', '-map_metadata', '-1', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-t', String(totalFrames / 48000), '-f', 'matroska', temporary], options);
    return { outputPath: request.outputPath, duration: totalFrames / 48000 };
  });
}
