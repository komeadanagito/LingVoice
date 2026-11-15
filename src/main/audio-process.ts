import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export interface ProcessOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  maxOutputBytes?: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}
export interface AudioOptions extends ProcessOptions { ffmpegPath: string }
export interface WavInfo { duration: number; sampleRate: number; channels: number; bitsPerSample: number; frames: number; dataBytes: number }

export function checkCancelled(signal?: AbortSignal): void { signal?.throwIfAborted(); }
export function finiteSeconds(value: number, name: string, allowZero = false): number {
  if (!Number.isFinite(value) || (allowZero ? value < 0 : value <= 0) || value > 7 * 86400) throw new Error(`Invalid ${name}: expected ${allowZero ? 'non-negative' : 'positive'} seconds (maximum 7 days).`);
  return value;
}
export async function localFile(file: string): Promise<string> {
  if (typeof file !== 'string' || !path.isAbsolute(file) || /[\x00-\x1f]/.test(file)) throw new Error('Expected an absolute local file path.');
  const resolved = await fs.realpath(file);
  const stat = await fs.stat(resolved);
  if (!stat.isFile() || stat.size === 0) throw new Error(`Expected a nonempty local file: ${file}`);
  return resolved;
}

/** No shell, bounded combined output, cancellation and deadline. Resolves only after pipes close. */
export function runAudioProcess(executable: string, args: readonly string[], options: ProcessOptions = {}): Promise<{ stdout: string; stderr: string }> {
  checkCancelled(options.signal);
  const timeout = options.timeoutMs ?? 30 * 60_000;
  const limit = options.maxOutputBytes ?? 1024 * 1024;
  if (!Number.isSafeInteger(timeout) || timeout <= 0 || timeout > 2_147_483_647 || !Number.isSafeInteger(limit) || limit <= 0 || limit > 16 * 1024 * 1024) throw new Error('Invalid process deadline or output limit.');
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [...args], { shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'], cwd: options.cwd, env: options.env });
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    let bytes = 0;
    let failure: Error | undefined;
    let stopping = false;
    const stop = (error: Error) => {
      failure ??= error;
      if (stopping) return;
      stopping = true;
      if (process.platform === 'win32' && child.pid) {
        const killer = spawn(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'), ['/pid', String(child.pid), '/t', '/f'], { shell: false, windowsHide: true, stdio: 'ignore' });
        const fallback = setTimeout(() => { killer.kill(); child.kill('SIGKILL'); }, 5000);
        fallback.unref();
        killer.once('error', () => { clearTimeout(fallback); child.kill('SIGKILL'); });
        killer.once('close', () => { clearTimeout(fallback); child.kill('SIGKILL'); });
      } else {
        try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); }
        catch { child.kill('SIGKILL'); }
      }
    };
    const abort = () => { const error = new Error('Audio processing cancelled.'); error.name = 'AbortError'; stop(error); };
    const timer = setTimeout(() => stop(new Error('Audio process timed out.')), timeout);
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    const consume = (target: Buffer[], chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > limit) stop(new Error('Audio process exceeded its output limit.'));
      else target.push(chunk);
    };
    child.stdout.on('data', (chunk: Buffer) => consume(stdout, chunk));
    child.stderr.on('data', (chunk: Buffer) => consume(stderr, chunk));
    child.on('error', error => { failure ??= error; });
    child.on('close', code => {
      clearTimeout(timer); options.signal?.removeEventListener('abort', abort);
      const out = Buffer.concat(stdout).toString('utf8'), err = Buffer.concat(stderr).toString('utf8');
      if (failure) reject(failure);
      else if (code !== 0) reject(new Error(`Audio process exited with code ${code}: ${err.slice(-6000) || out.slice(-6000)}`));
      else resolve({ stdout: out, stderr: err });
    });
  });
}

/** Stage on the same filesystem, then publish using an atomic, no-overwrite hard link. */
export async function atomicAudioFile<T>(outputPath: string, signal: AbortSignal | undefined, work: (temporaryPath: string) => Promise<T>): Promise<T> {
  if (!path.isAbsolute(outputPath) || /[\x00-\x1f]/.test(outputPath)) throw new Error('Output must be an absolute local path.');
  checkCancelled(signal);
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  const directory = await fs.mkdtemp(path.join(path.dirname(outputPath), '.audio-stage-'));
  try {
    const staged = path.join(directory, `result${path.extname(outputPath)}`);
    const result = await work(staged);
    await localFile(staged);
    checkCancelled(signal);
    await fs.link(staged, outputPath);
    return result;
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
}

/** Reads RIFF/RF64 chunks without loading PCM into memory. Accepts FFmpeg LIST/JUNK and extensible PCM. */
export async function readWavInfo(file: string): Promise<WavInfo> {
  const handle = await fs.open(await localFile(file), 'r');
  try {
    const size = (await handle.stat()).size;
    const read = async (offset: number, length: number) => {
      const buffer = Buffer.alloc(length);
      if ((await handle.read(buffer, 0, length, offset)).bytesRead !== length) throw new Error('Truncated WAV file.');
      return buffer;
    };
    const header = await read(0, 12);
    const kind = header.toString('ascii', 0, 4);
    if (!['RIFF', 'RF64'].includes(kind) || header.toString('ascii', 8, 12) !== 'WAVE') throw new Error('Expected RIFF/RF64 WAV audio.');
    let sampleRate = 0, channels = 0, bits = 0, block = 0, dataBytes = -1, rf64Data: number | undefined;
    let position = 12, chunks = 0;
    while (position + 8 <= size) {
      if (++chunks > 10000) throw new Error('WAV has too many chunks.');
      const chunk = await read(position, 8), id = chunk.toString('ascii', 0, 4);
      let length = chunk.readUInt32LE(4);
      const begin = position + 8;
      if (id === 'ds64') {
        if (length < 28) throw new Error('Invalid RF64 size chunk.');
        const ds = await read(begin, 28), value = ds.readBigUInt64LE(8);
        if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('WAV size is too large.');
        rf64Data = Number(value);
      }
      if (id === 'data' && length === 0xffffffff) length = kind === 'RF64' ? (rf64Data ?? -1) : size - begin;
      if (length < 0 || begin + length > size) throw new Error('Truncated WAV chunk.');
      if (id === 'fmt ') {
        if (length < 16 || length > 65536) throw new Error('Invalid WAV format chunk.');
        const fmt = await read(begin, length);
        let format = fmt.readUInt16LE(0);
        channels = fmt.readUInt16LE(2); sampleRate = fmt.readUInt32LE(4); block = fmt.readUInt16LE(12); bits = fmt.readUInt16LE(14);
        if (format === 0xfffe) {
          if (length < 40 || fmt.readUInt16LE(16) < 22 || fmt.subarray(26, 40).toString('hex') !== '000000001000800000aa00389b71') throw new Error('Unsupported extensible WAV format.');
          format = fmt.readUInt16LE(24);
        }
        if (![1, 3].includes(format) || !channels || channels > 32 || !sampleRate || sampleRate > 768000 || ![8, 16, 24, 32, 64].includes(bits) || (format === 3 && ![32, 64].includes(bits)) || block !== channels * bits / 8 || fmt.readUInt32LE(8) !== sampleRate * block) throw new Error('Unsupported or invalid PCM WAV format.');
      } else if (id === 'data') {
        if (dataBytes !== -1) throw new Error('Multiple WAV data chunks are unsupported.');
        dataBytes = length;
      }
      position = begin + length + (length % 2);
    }
    if (!sampleRate || dataBytes <= 0 || dataBytes % block) throw new Error('WAV contains no complete PCM frames.');
    const frames = dataBytes / block;
    return { duration: frames / sampleRate, frames, sampleRate, channels, bitsPerSample: bits, dataBytes };
  } finally { await handle.close(); }
}

export function assertDuration(actual: number, expected: number, tolerance = 0.05): void {
  finiteSeconds(actual, 'actual duration'); finiteSeconds(expected, 'expected duration');
  if (!Number.isFinite(tolerance) || tolerance < 0 || Math.abs(actual - expected) > tolerance + 1e-9) throw new Error(`Audio duration mismatch: expected ${expected}s, received ${actual}s.`);
}
export const ffmpegBase = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y'];
export async function extractAudio(inputPath: string, outputPath: string, options: AudioOptions): Promise<WavInfo> {
  const input = await localFile(inputPath);
  return atomicAudioFile(outputPath, options.signal, async temporary => {
    await runAudioProcess(options.ffmpegPath, [...ffmpegBase, '-i', input, '-map', '0:a:0', '-vn', '-ac', '2', '-ar', '48000', '-c:a', 'pcm_s16le', '-rf64', 'auto', '-f', 'wav', temporary], options);
    return readWavInfo(temporary);
  });
}
export async function extractVoiceReference(dialoguePath: string, outputPath: string, start: number, duration: number, options: AudioOptions): Promise<WavInfo> {
  finiteSeconds(start, 'reference start', true);
  if (!Number.isFinite(duration) || duration < 5 || duration > 20) throw new Error('Voice reference must be 5–20 seconds; 10–20 seconds is recommended.');
  const input = await localFile(dialoguePath), source = await readWavInfo(input);
  if (start + duration > source.duration + 1 / source.sampleRate) throw new Error('Voice reference extends beyond dialogue audio.');
  return atomicAudioFile(outputPath, options.signal, async temporary => {
    await runAudioProcess(options.ffmpegPath, [...ffmpegBase, '-i', input, '-ss', String(start), '-t', String(duration), '-vn', '-ac', '1', '-ar', '24000', '-c:a', 'pcm_s16le', '-rf64', 'auto', '-f', 'wav', temporary], options);
    const info = await readWavInfo(temporary); assertDuration(info.duration, duration, 1 / 24000); return info;
  });
}

/** Extracts a 3–10s mono 24 kHz WAV reference tailored for local GPT-SoVITS V5 with optional trailing silence padding
 * so the final syllable is never clipped and prompt_semantic ends cleanly at a pause.
 */
export async function extractLocalVoiceReference(
  dialoguePath: string,
  outputPath: string,
  start: number,
  duration: number,
  trailingSilenceSec: number,
  options: AudioOptions & { denoise?: boolean },
): Promise<WavInfo> {
  finiteSeconds(start, 'reference start', true);
  if (!Number.isFinite(duration) || duration < 2.5 || duration > 9.5) throw new Error('Local voice reference must be 2.5–9.5 seconds.');
  const padSec = Math.max(0, Math.min(1.0, Number.isFinite(trailingSilenceSec) ? trailingSilenceSec : 0));
  const input = await localFile(dialoguePath), source = await readWavInfo(input);
  if (start + duration > source.duration + 1 / source.sampleRate) throw new Error('Voice reference extends beyond dialogue audio.');
  const expected = Math.min(9.9, Math.max(3.1, duration + padSec));
  const exactPad = Math.max(0, expected - duration);
  const denoiseFilter = options.denoise ? ',highpass=f=85,afftdn=nr=16:nf=-28:tn=1' : '';
  return atomicAudioFile(outputPath, options.signal, async temporary => {
    const args = [
      ...ffmpegBase, '-i', input, '-vn',
      '-af', `atrim=start=${start}:duration=${duration},asetpts=PTS-STARTPTS${denoiseFilter},apad=pad_dur=${exactPad.toFixed(4)}`,
      '-t', String(expected),
      '-ac', '1', '-ar', '24000', '-c:a', 'pcm_s16le', '-rf64', 'auto', '-f', 'wav', temporary,
    ];
    await runAudioProcess(options.ffmpegPath, args, options);
    const info = await readWavInfo(temporary);
    assertDuration(info.duration, expected, 0.02);
    return info;
  });
}

/** Safe fallback without a real separation model: retain source audio for reference and mute the background.
 * Stereo cancellation and frequency filters cannot reliably remove speech; music is intentionally not preserved.
 */
export async function separateAudioFfmpegFallback(inputPath: string, outputDirectory: string, options: AudioOptions): Promise<{ dialoguePath: string; backgroundPath: string; duration: number }> {
  if (!path.isAbsolute(outputDirectory) || /[\x00-\x1f]/.test(outputDirectory)) throw new Error('Separation output must be an absolute local directory path.');
  const input = await localFile(inputPath), source = await readWavInfo(input);
  checkCancelled(options.signal);
  await fs.mkdir(path.dirname(outputDirectory), { recursive: true });
  const stage = await fs.mkdtemp(path.join(path.dirname(outputDirectory), '.silent-separation-stage-'));
  try {
    const dialogueOut = path.join(stage, 'dialogue.wav');
    const backgroundOut = path.join(stage, 'background.wav');
    // Decode once, retaining the complete source as the reference (not isolated vocals).
    // Exact silence prevents off-centre, reverberant and high-frequency speech leaking into the dub.
    const dualStemFilter = '[0:a]asplit=2[v_out][in_b];[in_b]volume=0[bg_out]';
    await runAudioProcess(
      options.ffmpegPath,
      [
        ...ffmpegBase, '-i', input, '-vn', '-filter_complex', dualStemFilter,
        '-map', '[v_out]', '-ac', '2', '-ar', '48000', '-c:a', 'pcm_s16le', '-rf64', 'auto', '-f', 'wav', dialogueOut,
        '-map', '[bg_out]', '-ac', '2', '-ar', '48000', '-c:a', 'pcm_s16le', '-rf64', 'auto', '-f', 'wav', backgroundOut,
      ],
      options,
    );
    const dialogueInfo = await readWavInfo(dialogueOut);
    const backgroundInfo = await readWavInfo(backgroundOut);
    assertDuration(dialogueInfo.duration, source.duration);
    assertDuration(backgroundInfo.duration, source.duration);
    checkCancelled(options.signal);
    await fs.rm(outputDirectory, { recursive: true, force: true });
    await fs.rename(stage, outputDirectory);
    return { dialoguePath: path.join(outputDirectory, 'dialogue.wav'), backgroundPath: path.join(outputDirectory, 'background.wav'), duration: source.duration };
  } finally {
    await fs.rm(stage, { recursive: true, force: true }).catch(() => {});
  }
}

/** Restores the original audio mix (including solo singing BGM) during non-dialogue gaps
 * while keeping the separated instrumental/backing stem everywhere the narrator speaks.
 */
export async function buildSmartBackground(
  sourceWavPath: string,
  separatedBgPath: string,
  outputPath: string,
  cues: readonly { start: number; end: number }[],
  offset: number,
  duration: number,
): Promise<string> {
  try {
    const [srcInfo, bgInfo] = await Promise.all([readWavInfo(sourceWavPath), readWavInfo(separatedBgPath)]);
    if (
      srcInfo.bitsPerSample !== 16 || bgInfo.bitsPerSample !== 16 ||
      srcInfo.sampleRate !== bgInfo.sampleRate || srcInfo.channels !== bgInfo.channels ||
      srcInfo.frames !== bgInfo.frames
    ) {
      return separatedBgPath;
    }
    const [srcBuf, bgBuf] = await Promise.all([fs.readFile(sourceWavPath), fs.readFile(separatedBgPath)]);
    if (
      srcBuf.byteLength < 44 || bgBuf.byteLength < 44 ||
      srcBuf.toString('ascii', 36, 40) !== 'data' || bgBuf.toString('ascii', 36, 40) !== 'data'
    ) {
      return separatedBgPath;
    }
    const sr = bgInfo.sampleRate;
    const ch = bgInfo.channels;
    const totalFrames = bgInfo.frames;
    const speechPad = 0.25;
    const rawWindows = cues
      .map(c => ({ start: Math.max(0, c.start + offset - speechPad), end: Math.min(duration, c.end + offset + speechPad) }))
      .filter(w => w.end > w.start)
      .sort((a, b) => a.start - b.start);
    const merged: { start: number; end: number }[] = [];
    for (const w of rawWindows) {
      const prev = merged.at(-1);
      if (prev && w.start - prev.end < 0.75) {
        prev.end = Math.max(prev.end, w.end);
      } else {
        merged.push({ ...w });
      }
    }
    // Identify non-dialogue gaps >= 0.5s where original audio (including singing BGM) is safe to restore.
    const gaps: { startFrame: number; endFrame: number }[] = [];
    let cursor = 0;
    for (const w of merged) {
      if (w.start - cursor >= 0.5) {
        gaps.push({
          startFrame: Math.max(0, Math.round(cursor * sr)),
          endFrame: Math.min(totalFrames, Math.round(w.start * sr)),
        });
      }
      cursor = Math.max(cursor, w.end);
    }
    if (duration - cursor >= 0.5) {
      gaps.push({
        startFrame: Math.max(0, Math.round(cursor * sr)),
        endFrame: totalFrames,
      });
    }
    if (!gaps.length) return separatedBgPath;

    const outBuf = Buffer.from(bgBuf);
    const srcView = new DataView(srcBuf.buffer, srcBuf.byteOffset + 44, totalFrames * ch * 2);
    const outView = new DataView(outBuf.buffer, outBuf.byteOffset + 44, totalFrames * ch * 2);
    const fadeFrames = Math.min(Math.round(0.15 * sr), Math.round(0.25 * sr));

    for (const gap of gaps) {
      const len = gap.endFrame - gap.startFrame;
      if (len <= 0) continue;
      const localFade = Math.min(fadeFrames, Math.floor(len / 3));
      for (let f = gap.startFrame; f < gap.endFrame; f++) {
        let mixOrig = 1.0;
        const fromStart = f - gap.startFrame;
        const toEnd = gap.endFrame - 1 - f;
        if (localFade > 0) {
          if (fromStart < localFade) mixOrig = 0.5 * (1 - Math.cos((Math.PI * fromStart) / localFade));
          else if (toEnd < localFade) mixOrig = 0.5 * (1 - Math.cos((Math.PI * toEnd) / localFade));
        }
        const mixBg = 1.0 - mixOrig;
        for (let c = 0; c < ch; c++) {
          const byteIdx = (f * ch + c) * 2;
          const sOrig = srcView.getInt16(byteIdx, true);
          const sBg = outView.getInt16(byteIdx, true);
          const blended = Math.max(-32768, Math.min(32767, Math.round(sOrig * mixOrig + sBg * mixBg)));
          outView.setInt16(byteIdx, blended, true);
        }
      }
    }
    await fs.writeFile(outputPath, outBuf, { mode: 0o600 });
    return outputPath;
  } catch {
    return separatedBgPath;
  }
}
