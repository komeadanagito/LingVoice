import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { assertDuration, checkCancelled, extractAudio, localFile, readWavInfo, runAudioProcess, type AudioOptions } from './audio-process';

export interface SeparationOptions extends AudioOptions {
  pythonPath: string;
  /** Absolute path to the shipped scripts/audio-separation.py; caller resolves packaging location. */
  helperPath: string;
  modelPath: string;
  expectedSha256?: string;
  device?: 'cpu' | 'auto' | 'cuda';
  dialogueStem?: string;
  backgroundStem?: string;
}
export interface SeparationEnvironment {
  ready: boolean;
  diagnostics: string[];
  pythonVersion?: string;
  separatorVersion?: string;
  cudaAvailable?: boolean;
  onnxProviders?: string[];
  modelSha256?: string;
}
interface PythonResult { ok: boolean; diagnostics: string[]; environment?: SeparationEnvironment; dialoguePath?: string; backgroundPath?: string }

async function invokePython(operation: 'probe' | 'separate', options: SeparationOptions, directory: string, inputPath?: string): Promise<PythonResult> {
  const helper = await localFile(options.helperPath), model = await localFile(options.modelPath);
  if (options.expectedSha256 !== undefined && !/^[a-fA-F0-9]{64}$/.test(options.expectedSha256)) throw new Error('Expected model SHA-256 must contain 64 hexadecimal characters.');
  if (options.device !== undefined && !['cpu', 'auto', 'cuda'].includes(options.device)) throw new Error('Device must be cpu, auto or cuda.');
  const dialogueStem = options.dialogueStem ?? 'Vocals', backgroundStem = options.backgroundStem ?? 'Instrumental';
  for (const stem of [dialogueStem, backgroundStem]) if (!/^[A-Za-z][A-Za-z0-9 _-]{0,63}$/.test(stem)) throw new Error('Invalid separator stem label.');
  if (dialogueStem.toLowerCase() === backgroundStem.toLowerCase()) throw new Error('Dialogue and background stem labels must differ.');
  const requestPath = path.join(directory, 'request.json');
  await fs.writeFile(requestPath, JSON.stringify({ operation, modelPath: model, expectedSha256: options.expectedSha256, device: options.device ?? 'cpu', dialogueStem, backgroundStem, inputPath, outputDir: directory }));
  const ffmpeg = await localFile(options.ffmpegPath);
  const env = { ...process.env, PYTHONUTF8: '1', PYTHONUNBUFFERED: '1', HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1', HF_DATASETS_OFFLINE: '1', AUDIO_SEPARATOR_MODEL_DIR: path.dirname(model), PATH: `${path.dirname(ffmpeg)}${path.delimiter}${process.env.PATH ?? ''}` };
  const result = await runAudioProcess(options.pythonPath, ['-I', helper, '--request', requestPath], { ...options, timeoutMs: options.timeoutMs ?? (operation === 'probe' ? 90_000 : 2 * 60 * 60_000), env, cwd: directory });
  let parsed: unknown;
  try { parsed = JSON.parse(result.stdout); } catch { throw new Error('Separation helper returned invalid JSON. Verify the installed audio-separator version and helper compatibility.'); }
  if (!parsed || typeof parsed !== 'object') throw new Error('Invalid separation response.');
  const value = parsed as PythonResult;
  if (typeof value.ok !== 'boolean' || !Array.isArray(value.diagnostics) || value.diagnostics.length > 100 || value.diagnostics.some(item => typeof item !== 'string' || item.length > 4000)) throw new Error('Invalid separation diagnostics.');
  return value;
}

/** Diagnostics only: never invokes pip, installs packages, downloads metadata, or downloads weights. */
export async function detectSeparationEnvironment(options: SeparationOptions): Promise<SeparationEnvironment> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lingvoice-probe-'));
  try {
    const ffmpeg = await localFile(options.ffmpegPath);
    await runAudioProcess(ffmpeg, ['-hide_banner', '-version'], { ...options, timeoutMs: options.timeoutMs ?? 10_000 });
    const result = await invokePython('probe', options, directory);
    const environment = result.environment;
    if (environment && (typeof environment.pythonVersion !== 'string' || typeof environment.separatorVersion !== 'string' || typeof environment.cudaAvailable !== 'boolean' || !Array.isArray(environment.onnxProviders) || environment.onnxProviders.some(item => typeof item !== 'string') || typeof environment.modelSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(environment.modelSha256))) throw new Error('Invalid separation environment response.');
    return { ...environment, ready: result.ok, diagnostics: result.diagnostics };
  } catch (error) {
    checkCancelled(options.signal);
    return { ready: false, diagnostics: [`${error instanceof Error ? error.message : String(error)} Verify the configured Python executable, installed audio-separator dependencies, local model and helper paths.`] };
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
}

/** Publishes a new directory containing both validated stems, or leaves no published directory. */
export async function separateAudio(inputPath: string, outputDirectory: string, options: SeparationOptions): Promise<{ dialoguePath: string; backgroundPath: string; duration: number }> {
  if (!path.isAbsolute(outputDirectory) || /[\x00-\x1f]/.test(outputDirectory)) throw new Error('Separation output must be an absolute local directory path.');
  const input = await localFile(inputPath), source = await readWavInfo(input);
  checkCancelled(options.signal);
  try { await fs.lstat(outputDirectory); throw new Error('Separation output directory already exists.'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  await fs.mkdir(path.dirname(outputDirectory), { recursive: true });
  const stage = await fs.mkdtemp(path.join(path.dirname(outputDirectory), '.separation-stage-'));
  try {
    const raw = path.join(stage, 'raw'); await fs.mkdir(raw);
    const result = await invokePython('separate', options, raw, input);
    if (!result.ok) throw new Error(result.diagnostics.join('\n') || 'Local separation failed.');
    const validateStem = async (file: unknown) => {
      if (typeof file !== 'string') throw new Error('Missing separation stem path.');
      const resolved = await localFile(file), relative = path.relative(await fs.realpath(raw), resolved);
      if (relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) throw new Error('Separation helper returned a path outside its private output directory.');
      assertDuration((await readWavInfo(resolved)).duration, source.duration);
      return resolved;
    };
    const dialogue = await validateStem(result.dialoguePath), background = await validateStem(result.backgroundPath);
    if (dialogue === background) throw new Error('Separation returned the same file for both stems.');
    const dialogueInfo = await extractAudio(dialogue, path.join(stage, 'dialogue.wav'), options);
    const backgroundInfo = await extractAudio(background, path.join(stage, 'background.wav'), options);
    assertDuration(dialogueInfo.duration, source.duration); assertDuration(backgroundInfo.duration, source.duration);
    await fs.rm(raw, { recursive: true, force: true });
    checkCancelled(options.signal);
    await fs.rename(stage, outputDirectory);
    return { dialoguePath: path.join(outputDirectory, 'dialogue.wav'), backgroundPath: path.join(outputDirectory, 'background.wav'), duration: source.duration };
  } finally { await fs.rm(stage, { recursive: true, force: true }); }
}
