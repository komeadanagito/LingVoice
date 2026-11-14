import * as fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DEFAULT_DUBBING_MODEL, DUBBING_MODEL, SUPPORTED_DUBBING_MODELS, defaultDubbingSettings, type DubbingConfig, type DubbingCue, type DubbingEnvironment, type DubbingModel, type DubbingProgress, type DubbingRequest, type DubbingResult, type DubbingSettings } from '../shared/dubbing';
import { advanceTranslationMemory, translationWindow, type TranslationMemoryState } from '../shared/translation';
import type { TtsService } from './tts';
import type { TranslationService } from './translation';
import { QwenDubbingClient, normalizeQwenDubbingBaseUrl } from './qwen-dubbing';
import { detectSeparationEnvironment, separateAudio, type SeparationOptions } from './audio-separation';
import { extractAudio, extractVoiceReference, ffmpegBase, localFile, readWavInfo, runAudioProcess, separateAudioFfmpegFallback } from './audio-process';
import { alignAudio, type AudioSegment } from './audio-alignment';
import { mixDubbedVideo } from './audio-mix';

function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function hash(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function validString(value: unknown, max = 4096, empty = false): value is string {
  return typeof value === 'string' && value.length <= max && (empty || !!value.trim()) && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value);
}
export function validateDubbingSettings(value: unknown): DubbingSettings {
  if (!object(value) || Object.keys(value).some(key => !['pythonPath', 'modelFile', 'baseUrl', 'model'].includes(key)) ||
      !validString(value.pythonPath, 2048) || !validString(value.modelFile, 4096, true) || !validString(value.baseUrl, 2048, true)) throw new Error('Invalid dubbing settings.');
  const model = value.model !== undefined
    ? (typeof value.model === 'string' && (SUPPORTED_DUBBING_MODELS as readonly string[]).includes(value.model) ? value.model as DubbingModel : undefined)
    : DEFAULT_DUBBING_MODEL;
  if (value.model !== undefined && model === undefined) throw new Error('Unsupported dubbing model. Choose qwen-audio-3.1-tts-plus, qwen-audio-3.0-tts-plus or doubao-seed-tts-2.0.');
  const settings: DubbingSettings = {
    pythonPath: value.pythonPath.trim(),
    modelFile: value.modelFile.trim(),
    baseUrl: value.baseUrl.trim(),
    model: model ?? DEFAULT_DUBBING_MODEL,
  };
  if (settings.modelFile && !path.isAbsolute(settings.modelFile)) throw new Error('Select an absolute path to an already downloaded separation model.');
  if (settings.baseUrl) settings.baseUrl = normalizeQwenDubbingBaseUrl(settings.baseUrl);
  return settings;
}
export function validateDubbingRequest(value: unknown): DubbingRequest {
  if (!object(value) || Object.keys(value).some(key => !['jobId', 'file', 'cues', 'offset', 'backgroundVolume', 'preview', 'consent', 'useTtsConfig'].includes(key)) ||
      typeof value.jobId !== 'string' || !/^[a-zA-Z0-9-]{8,80}$/.test(value.jobId) || !validString(value.file) ||
      !Array.isArray(value.cues) || !value.cues.length || value.cues.length > 10000 ||
      typeof value.offset !== 'number' || !Number.isFinite(value.offset) || Math.abs(value.offset) > 60 ||
      typeof value.backgroundVolume !== 'number' || !Number.isFinite(value.backgroundVolume) || value.backgroundVolume < 0 || value.backgroundVolume > 2 ||
      typeof value.preview !== 'boolean' || value.consent !== true || (value.useTtsConfig !== undefined && typeof value.useTtsConfig !== 'boolean')) throw new Error('Provide a media file, subtitle cues and explicit upload/billing consent.');
  let previousEnd = 0, characters = 0;
  const ids = new Set<number>();
  const cues = value.cues.map((item: unknown): DubbingCue => {
    if (!object(item) || Object.keys(item).some(key => !['id', 'start', 'end', 'text', 'translated', 'speechText'].includes(key)) ||
        !Number.isSafeInteger(item.id) || ids.has(item.id as number) || typeof item.start !== 'number' || !Number.isFinite(item.start) ||
        typeof item.end !== 'number' || !Number.isFinite(item.end) || item.start < 0 || item.end <= item.start || item.end > 21600 ||
        item.start + (value.offset as number) < previousEnd || !validString(item.text) ||
        (item.translated !== undefined && !validString(item.translated)) || (item.speechText !== undefined && !validString(item.speechText))) throw new Error('Single-speaker dubbing requires ordered, non-overlapping cues and nonempty text (maximum 4096 characters per field). Check subtitle delay too.');
    ids.add(item.id as number); previousEnd = item.end + (value.offset as number);
    characters += (item.text as string).length + String(item.translated ?? '').length + String(item.speechText ?? '').length;
    if (characters > 500_000) throw new Error('Dubbing transcript exceeds the character limit. Split the video.');
    return { id: item.id as number, start: item.start, end: item.end, text: item.text, ...(item.translated === undefined ? {} : { translated: item.translated as string }), ...(item.speechText === undefined ? {} : { speechText: item.speechText as string }) };
  });
  return { jobId: value.jobId, file: value.file, cues, offset: value.offset, backgroundVolume: value.backgroundVolume, preview: value.preview, consent: true, ...(value.useTtsConfig !== undefined ? { useTtsConfig: value.useTtsConfig as boolean } : {}) };
}
export function selectVoiceReference(cues: readonly DubbingCue[], offset: number, duration: number): { start: number; duration: number } {
  // Score all valid continuous speech windows so we prefer 10–20s dense dialogue over short/intro clips.
  let best: { start: number; duration: number; score: number } | undefined;
  for (let index = 0; index < cues.length; index++) {
    const start = cues[index].start + offset;
    if (start < 0 || start >= duration) continue;
    let end = cues[index].end + offset, voiced = end - start;
    for (let next = index + 1; next < cues.length && end - start < 16; next++) {
      const cue = cues[next];
      if (cue.start + offset - end > 1) break;
      voiced += cue.end - cue.start; end = cue.end + offset;
    }
    const length = Math.min(20, duration - start, end - start);
    if (length >= 5 && voiced >= 5) {
      const effectiveVoiced = Math.min(voiced, length);
      const density = effectiveVoiced / length;
      const durationScore = Math.min(effectiveVoiced, 16) / 16;
      const introPenalty = start < 2 && cues.length > 2 ? 0.1 : 0;
      const score = density * 0.6 + durationScore * 0.4 - introPenalty;
      if (!best || score > best.score + 0.05) {
        best = { start, duration: length, score };
      }
    }
  }
  if (best) return { start: best.start, duration: best.duration };
  throw new Error('No suitable voice reference: provide at least 5 seconds of clear, continuous single-speaker speech (10–20 seconds recommended).');
}

/** Evaluates candidate voice reference windows against actual separated dialogue WAV energy/SNR when available. */
export async function selectCleanestVoiceReference(
  cues: readonly DubbingCue[],
  offset: number,
  duration: number,
  dialoguePath?: string,
): Promise<{ start: number; duration: number }> {
  const fallback = selectVoiceReference(cues, offset, duration);
  if (!dialoguePath) return fallback;
  try {
    const info = await readWavInfo(dialoguePath);
    if (info.bitsPerSample !== 16 || info.duration < 5) return fallback;
    const candidates: { start: number; duration: number; cueScore: number }[] = [];
    for (let index = 0; index < cues.length; index++) {
      const start = cues[index].start + offset;
      if (start < 0 || start >= duration) continue;
      let end = cues[index].end + offset, voiced = end - start;
      for (let next = index + 1; next < cues.length && end - start < 16; next++) {
        const cue = cues[next];
        if (cue.start + offset - end > 1) break;
        voiced += cue.end - cue.start; end = cue.end + offset;
      }
      const length = Math.min(20, duration - start, end - start);
      if (length >= 5 && voiced >= 5) {
        const effectiveVoiced = Math.min(voiced, length);
        const density = effectiveVoiced / length;
        const durationScore = Math.min(effectiveVoiced, 16) / 16;
        const introPenalty = start < 2 && cues.length > 2 ? 0.1 : 0;
        candidates.push({ start, duration: length, cueScore: density * 0.6 + durationScore * 0.4 - introPenalty });
      }
    }
    if (candidates.length <= 1) return fallback;
    const handle = await fs.open(dialoguePath, 'r');
    try {
      const bytesPerSec = info.sampleRate * info.channels * 2;
      let best = fallback;
      let bestCombined = -Infinity;
      for (const cand of candidates) {
        const byteStart = 44 + Math.max(0, Math.floor(cand.start * bytesPerSec)) & ~1;
        const byteLen = Math.min(16 * bytesPerSec, Math.floor(cand.duration * bytesPerSec)) & ~1;
        if (byteLen < 3200) continue;
        const buf = Buffer.alloc(byteLen);
        const { bytesRead } = await handle.read(buf, 0, byteLen, byteStart);
        if (bytesRead < 3200) continue;
        const view = new DataView(buf.buffer, buf.byteOffset, bytesRead);
        const samples = Math.floor(bytesRead / 2);
        let sumSq = 0;
        let clips = 0;
        for (let i = 0; i < samples; i++) {
          const s = view.getInt16(i * 2, true);
          sumSq += s * s;
          if (Math.abs(s) >= 32500) clips++;
        }
        const rms = Math.sqrt(sumSq / samples);
        const snrScore = rms > 200 ? Math.min(1, Math.log10(rms / 100) / 2) : 0;
        const clipPenalty = (clips / samples) > 0.005 ? 0.3 : 0;
        const combined = cand.cueScore * 0.7 + snrScore * 0.3 - clipPenalty;
        if (combined > bestCombined + 0.02) {
          bestCombined = combined;
          best = { start: cand.start, duration: cand.duration };
        }
      }
      return best;
    } finally {
      await handle.close();
    }
  } catch {
    return fallback;
  }
}
function timestamp(value: number): string {
  const ms = Math.round(value * 1000);
  return `${String(Math.floor(ms / 3600000)).padStart(2, '0')}:${String(Math.floor(ms / 60000) % 60).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`;
}
export function dubbingSrt(cues: readonly DubbingCue[], offset: number): string {
  return cues.map((cue, index) => `${index + 1}\n${timestamp(cue.start + offset)} --> ${timestamp(cue.end + offset)}\n${cue.translated ?? cue.speechText ?? ''}\n${cue.text}\n`).join('\n');
}

export interface DubbingUtteranceGroup {
  cues: DubbingCue[];
  startIndex: number;
  endIndex: number;
  start: number;
  end: number;
  speechText: string;
}

/** Merges fragmented adjacent subtitle cues into Bilibili-style continuous breath-group utterances
 * when pause <= 0.35s and the preceding cue has no terminal sentence punctuation.
 */
export function groupDubbingUtterances(cues: readonly DubbingCue[], targetLanguage = 'en'): DubbingUtteranceGroup[] {
  const isChinese = /^(?:zh|chinese)/i.test(targetLanguage);
  const terminalRe = /[.!?。！？;；…—]$/;
  const groups: DubbingUtteranceGroup[] = [];

  for (let i = 0; i < cues.length; ) {
    const first = cues[i];
    const groupCues: DubbingCue[] = [first];
    let endIdx = i;

    while (endIdx + 1 < cues.length && groupCues.length < 3) {
      const prev = cues[endIdx];
      const next = cues[endIdx + 1];
      const gap = next.start - prev.end;
      const prevHasManualOverride = Boolean(prev.speechText && prev.translated && prev.speechText !== prev.translated);
      const nextHasManualOverride = Boolean(next.speechText && next.translated && next.speechText !== next.translated);
      const prevSpeech = (prev.speechText ?? prev.translated ?? '').trim();
      const nextSpeech = (next.speechText ?? next.translated ?? '').trim();
      const prevSource = prev.text.trim();
      if (
        gap > 0.35 ||
        prevHasManualOverride ||
        nextHasManualOverride ||
        terminalRe.test(prevSpeech) ||
        terminalRe.test(prevSource) ||
        next.end - first.start > 12 ||
        prevSpeech.length + nextSpeech.length > 320
      ) {
        break;
      }
      groupCues.push(next);
      endIdx++;
    }

    const combinedText = groupCues
      .map(c => (c.speechText ?? c.translated ?? '').trim())
      .reduce((acc, part, idx) => {
        if (idx === 0) return part;
        if (isChinese) {
          return /[,，、—]$/.test(acc) ? `${acc}${part}` : `${acc}，${part}`;
        }
        return `${acc.replace(/[,，]+$/, '')} ${part}`;
      }, '');

    groups.push({
      cues: groupCues,
      startIndex: i,
      endIndex: endIdx,
      start: first.start,
      end: groupCues[groupCues.length - 1].end,
      speechText: combinedText,
    });
    i = endIdx + 1;
  }
  return groups;
}
async function digestFile(file: string, signal: AbortSignal): Promise<string> {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(file, { signal })) { signal.throwIfAborted(); digest.update(chunk); }
  return digest.digest('hex');
}
async function jsonFile(file: string): Promise<unknown> {
  try { const info = await fs.stat(file); if (info.size > 2_000_000) throw new Error('Dubbing metadata is too large.'); return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}
async function saveJson(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomUUID()}.tmp`;
  try { await fs.writeFile(temp, JSON.stringify(value), { flag: 'wx', mode: 0o600 }); await fs.rename(temp, file); }
  finally { await fs.rm(temp, { force: true }); }
}
interface ManagedVoice { voiceId: string; baseUrl: string; account: string; reference: string }
export interface DubbingDependencies {
  detect: typeof detectSeparationEnvironment;
  separate: typeof separateAudio;
  extract: typeof extractAudio;
  reference: typeof extractVoiceReference;
  align: typeof alignAudio;
  mix: typeof mixDubbedVideo;
  process: typeof runAudioProcess;
  client: (credentials: { baseUrl: string; apiKey: string }) => Pick<QwenDubbingClient, 'createVoice' | 'queryVoice' | 'synthesize' | 'deleteVoice'>;
}
interface DubbingServiceOptions {
  directory: string;
  ffmpegPath: string;
  helperPath: string;
  tts: Pick<TtsService, 'withDubbingContext'> & { dubbingContextInfo?: () => Promise<{ providerName: string; baseUrl: string; hasApiKey: boolean; model?: string }> };
  translation: Pick<TranslationService, 'getConfig' | 'translate' | 'summarize'>;
  emit: (progress: DubbingProgress) => void;
}

/** One active job owns all input files, children, cloud calls and output publication. */
export class DubbingService {
  private active?: { id: string; controller: AbortController };
  private maintenance = false;
  private settings?: DubbingSettings;
  private pending: Promise<unknown> = Promise.resolve();
  private readonly deps: DubbingDependencies;
  constructor(private readonly options: DubbingServiceOptions, dependencies: Partial<DubbingDependencies> = {}) {
    this.deps = { detect: detectSeparationEnvironment, separate: separateAudio, extract: extractAudio, reference: extractVoiceReference,
      align: alignAudio, mix: mixDubbedVideo, process: runAudioProcess, client: credentials => new QwenDubbingClient(credentials), ...dependencies };
  }
  get busy(): boolean { return !!this.active || this.maintenance; }
  cancel(jobId?: string): void { if (this.active && (jobId === undefined || this.active.id === jobId)) this.active.controller.abort(); }
  private get root(): string { return path.join(this.options.directory, 'cache'); }
  async getConfig(): Promise<DubbingConfig> {
    await this.pending;
    if (!this.settings) this.settings = validateDubbingSettings(await jsonFile(path.join(this.options.directory, 'settings.json')) ?? defaultDubbingSettings);
    let ttsInfo: { providerName?: string; baseUrl?: string; hasApiKey?: boolean; model?: string } = {};
    if (typeof this.options.tts.dubbingContextInfo === 'function') {
      try { ttsInfo = await this.options.tts.dubbingContextInfo(); } catch {}
    }
    const resolvedBaseUrl = this.settings.baseUrl || ttsInfo.baseUrl || 'https://dashscope.aliyuncs.com/api/v1';
    const resolvedModel = this.settings.model ?? (ttsInfo.model && (SUPPORTED_DUBBING_MODELS as readonly string[]).includes(ttsInfo.model) ? ttsInfo.model as DubbingModel : DEFAULT_DUBBING_MODEL);
    return {
      model: resolvedModel,
      settings: { ...this.settings, baseUrl: this.settings.baseUrl || resolvedBaseUrl, model: this.settings.model ?? resolvedModel },
      voices: (await this.voices()).map(({ voiceId, baseUrl }) => ({ voiceId, baseUrl })),
      ttsProviderName: ttsInfo.providerName,
      hasTtsApiKey: ttsInfo.hasApiKey,
    };
  }
  saveConfig(input: DubbingSettings): Promise<DubbingConfig> {
    if (this.busy) return Promise.reject(new Error('Stop dubbing before changing settings.'));
    const validated = validateDubbingSettings(input);
    const operation = this.pending.then(async () => {
      if (this.busy) throw new Error('Stop dubbing before changing settings.');
      await saveJson(path.join(this.options.directory, 'settings.json'), validated); this.settings = validated;
      return { model: validated.model ?? DEFAULT_DUBBING_MODEL, settings: { ...validated }, voices: (await this.voices()).map(({ voiceId, baseUrl }) => ({ voiceId, baseUrl })) };
    });
    this.pending = operation.then(() => {}, () => {});
    return operation;
  }
  private separation(settings: DubbingSettings, signal?: AbortSignal): SeparationOptions {
    return { ffmpegPath: this.options.ffmpegPath, helperPath: this.options.helperPath, pythonPath: settings.pythonPath, modelPath: settings.modelFile, device: 'auto', signal };
  }
  async check(): Promise<DubbingEnvironment> {
    const { settings } = await this.getConfig();
    const effectiveBaseUrl = settings.baseUrl || 'https://dashscope.aliyuncs.com/api/v1';
    if (!settings.modelFile) return { ready: false, message: 'Configure an already downloaded local separation model. No automatic installation or download is performed.' };
    const environment = await this.deps.detect(this.separation({ ...settings, baseUrl: effectiveBaseUrl }));
    return { ready: environment.ready, message: environment.diagnostics.join('\n') || 'Local separation environment is ready. Cloud permissions and voice quality still require an authorized test.' };
  }
  /** Pre-separates dialogue (vocals) and background (BGM) into the dubbing cache before ASR runs,
   * so ASR transcribes clean vocals without BGM and DubbingService.run reuses the cached stems.
   */
  async prepareVocals(filePath: string, signal?: AbortSignal): Promise<string | undefined> {
    if (this.busy) return undefined;
    try {
      const { settings } = await this.getConfig();
      const source = await localFile(filePath);
      const activeModel = settings.model ?? DEFAULT_DUBBING_MODEL;
      const abortSignal = signal ?? new AbortController().signal;
      let useUvr = false;
      if (settings.modelFile) {
        const environment = await this.deps.detect(this.separation(settings, signal));
        useUvr = environment.ready;
      }
      const modelDigest = useUvr && settings.modelFile ? await digestFile(settings.modelFile, abortSignal) : 'ffmpeg-dsp-fallback';
      const mediaKey = hash(['dubbing-v1', activeModel, await digestFile(source, abortSignal), modelDigest, false]);
      const mediaDir = path.join(this.root, mediaKey);
      await fs.mkdir(mediaDir, { recursive: true, mode: 0o700 });
      const audioOptions = { ffmpegPath: this.options.ffmpegPath, signal };
      const extracted = path.join(mediaDir, 'source.wav');
      let duration: number;
      try { duration = (await readWavInfo(extracted)).duration; }
      catch { await fs.rm(extracted, { force: true }); duration = (await this.deps.extract(source, extracted, audioOptions)).duration; }
      if (duration > 21600 || duration < 5) return undefined;
      const separationDir = path.join(mediaDir, 'stems');
      const dialogue = path.join(separationDir, 'dialogue.wav'), background = path.join(separationDir, 'background.wav');
      try {
        for (const file of [dialogue, background]) if (Math.abs((await readWavInfo(file)).duration - duration) > 0.05) throw new Error('Stale separation cache.');
        return dialogue;
      } catch {
        await fs.rm(separationDir, { recursive: true, force: true });
        const stems = useUvr
          ? await this.deps.separate(extracted, separationDir, this.separation(settings, signal))
          : await separateAudioFfmpegFallback(extracted, separationDir, audioOptions);
        return stems.dialoguePath;
      }
    } catch {
      return undefined;
    }
  }
  async clearCache(): Promise<void> {
    if (this.busy) throw new Error('Stop dubbing before clearing its cache.');
    this.maintenance = true;
    try { await fs.rm(this.root, { recursive: true, force: true }); }
    finally { this.maintenance = false; }
  }
  private async voices(): Promise<ManagedVoice[]> {
    const value = await jsonFile(path.join(this.options.directory, 'voices.json'));
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.length > 1000 || value.some(item => !object(item) || !validString(item.voiceId) || !validString(item.baseUrl) || !validString(item.account) || !validString(item.reference))) throw new Error('Invalid saved dubbing voice registry.');
    return value as ManagedVoice[];
  }
  async deleteVoice(voiceId: string): Promise<void> {
    if (this.busy) throw new Error('Stop dubbing before deleting a voice.');
    if (!validString(voiceId, 256)) throw new Error('Invalid voice ID.');
    this.maintenance = true;
    try {
      const voices = await this.voices(), record = voices.find(item => item.voiceId === voiceId);
      if (!record) throw new Error('Only voices registered by this application can be deleted here.');
      await this.options.tts.withDubbingContext(async context => {
        if (hash(context.apiKey) !== record.account) throw new Error('Use the original TTS credentials to delete this voice.');
        await this.deps.client({ ...context, baseUrl: record.baseUrl }).deleteVoice(voiceId);
      });
      await saveJson(path.join(this.options.directory, 'voices.json'), voices.filter(item => item.voiceId !== voiceId));
    } finally { this.maintenance = false; }
  }
  async run(input: DubbingRequest): Promise<DubbingResult> {
    const request = validateDubbingRequest(input);
    if (this.busy) throw new Error('Dubbing is already in progress.');
    const job = { id: request.jobId, controller: new AbortController() };
    this.active = job;
    const signal = job.controller.signal;
    let timedOut = false;
    const deadline = setTimeout(() => { timedOut = true; job.controller.abort(); }, 12 * 60 * 60 * 1000);
    deadline.unref();
    const progress = (stage: DubbingProgress['stage'], completed: number, total: number, message: string) => {
      signal.throwIfAborted(); this.options.emit({ jobId: job.id, stage, completed, total, message });
    };
    let work = '';
    try {
      const { settings } = await this.getConfig();
      let activeBaseUrl = normalizeQwenDubbingBaseUrl(settings.baseUrl || 'https://dashscope.aliyuncs.com/api/v1');
      let activeModel = settings.model ?? DEFAULT_DUBBING_MODEL;
      if (request.useTtsConfig) {
        if (!this.options.tts.dubbingContextInfo) throw new Error('当前后端无法读取 TTS 配置，请更新并重启应用。 / Update the backend to use saved TTS settings.');
        const selected = await this.options.tts.dubbingContextInfo();
        if (!selected.hasApiKey) throw new Error('请先在「设置 → 视频配音服务」保存接口地址和 API Key。 / Save the TTS endpoint and API key before dubbing.');
        activeBaseUrl = normalizeQwenDubbingBaseUrl(selected.baseUrl);
        if (!selected.model || !(SUPPORTED_DUBBING_MODELS as readonly string[]).includes(selected.model)) throw new Error('请选择支持的配音模型；Token Plan 请按订阅权限选择 qwen-audio-3.0-tts-plus。 / Select a supported dubbing model in TTS settings.');
        activeModel = selected.model as DubbingModel;
      }
      new QwenDubbingClient({ baseUrl: activeBaseUrl, apiKey: 'configuration-check', model: activeModel });
      progress('preparing', 0, 1, 'Checking local separation environment.');
      let useUvr = false;
      if (settings.modelFile) {
        const environment = await this.deps.detect(this.separation(settings, signal));
        if (!environment.ready) throw new Error(environment.diagnostics.join('\n'));
        useUvr = true;
      }
      const source = await localFile(request.file);
      const config = await this.options.translation.getConfig(), fingerprint = JSON.stringify(config.settings);
      const targetLanguage = config.settings.targetLanguage;
      if (!/^(zh|en)(?:[-_].*)?$|^(chinese|english)$/i.test(targetLanguage)) throw new Error('The first dubbing version supports Chinese and English. Set the target language in translation settings.');
      const ensureTranslation = async () => {
        signal.throwIfAborted();
        if (JSON.stringify((await this.options.translation.getConfig()).settings) !== fingerprint) throw new Error('Translation settings changed. Restart dubbing to keep the output language consistent.');
      };
      const modelDigest = useUvr && settings.modelFile ? await digestFile(settings.modelFile, signal) : 'ffmpeg-dsp-fallback';
      const mediaKey = hash(['dubbing-v1', activeModel, await digestFile(source, signal), modelDigest, request.preview]);
      const mediaDir = path.join(this.root, mediaKey);
      await fs.mkdir(mediaDir, { recursive: true, mode: 0o700 });
      work = await fs.mkdtemp(path.join(mediaDir, '.job-'));
      const audioOptions = { ffmpegPath: this.options.ffmpegPath, signal };
      let video = source;
      if (request.preview) {
        video = path.join(work, 'preview.mkv');
        await this.deps.process(this.options.ffmpegPath, [...ffmpegBase, '-i', source, '-t', '30', '-map', '0:v:0', '-map', '0:a:0', '-c:v', 'copy', '-c:a', 'pcm_s16le', '-f', 'matroska', video], audioOptions);
      }
      const extracted = path.join(mediaDir, 'source.wav');
      let duration: number;
      try { duration = (await readWavInfo(extracted)).duration; }
      catch { await fs.rm(extracted, { force: true }); duration = (await this.deps.extract(video, extracted, audioOptions)).duration; }
      if (duration > 21600 || duration < 5) throw new Error('Choose a video between 5 seconds and 6 hours.');
      const disk = await fs.statfs(mediaDir, { bigint: true });
      const required = BigInt(Math.ceil(duration * 48000 * 4)) * 4n + 32n * 1024n * 1024n;
      if (disk.bavail * disk.bsize < required) throw new Error(`Insufficient working disk space. Dubbing needs approximately ${Math.ceil(Number(required) / 1024 ** 3)} GiB of free space for PCM stems and mixing. Clear old caches or use a shorter video.`);
      if (request.preview) duration = Math.min(duration, 30);
      let cues = request.cues.filter(cue => !request.preview || cue.end + request.offset <= duration).map(cue => ({ ...cue }));
      if (!cues.length || cues.some(cue => cue.end + request.offset > duration + 0.01)) throw new Error('Subtitle timing is outside the audio duration. Check subtitle delay. Preview requires at least one complete cue in the first 30 seconds.');
      const separationDir = path.join(mediaDir, 'stems');
      let dialogue = path.join(separationDir, 'dialogue.wav'), background = path.join(separationDir, 'background.wav');
      progress('separating', 0, 1, 'Separating dialogue and background locally; this can take several minutes.');
      try {
        for (const file of [dialogue, background]) if (Math.abs((await readWavInfo(file)).duration - duration) > 0.05) throw new Error('Stale separation cache.');
      } catch {
        await fs.rm(separationDir, { recursive: true, force: true });
        const stems = useUvr
          ? await this.deps.separate(extracted, separationDir, this.separation(settings, signal))
          : await separateAudioFfmpegFallback(extracted, separationDir, audioOptions);
        dialogue = stems.dialoguePath; background = stems.backgroundPath;
      }
      const reference = await selectCleanestVoiceReference(cues, request.offset, duration, dialogue);
      progress('translating', 0, cues.length, 'Preparing spoken translations from the current subtitle snapshot.');
      let translationMemory: TranslationMemoryState = { memory: { summary: '', terms: [] }, through: 0 };
      for (let index = 0; index < cues.length; ) {
        if (cues[index].translated || cues[index].speechText) { index++; continue; }
        const start = index;
        let characters = 0;
        while (index < cues.length && !cues[index].translated && !cues[index].speechText && index - start < 30 && characters + cues[index].text.length <= 8000) {
          characters += cues[index].text.length;
          index++;
        }
        const batch = cues.slice(start, index);
        await ensureTranslation();
        translationMemory = await advanceTranslationMemory(cues, start, translationMemory, async request => {
          signal.throwIfAborted();
          progress('translating', start, cues.length, 'Summarizing earlier dialogue and updating terminology.');
          return this.options.translation.summarize(request, signal);
        });
        const { context, lookahead } = translationWindow(cues, start, index);
        const translations = await this.options.translation.translate({
          memory: translationMemory.memory,
          texts: batch.map(cue => cue.text),
          ...(context.length ? { context } : {}),
          ...(lookahead.length ? { lookahead } : {}),
        }, signal, batch.map(cue => cue.end - cue.start));
        if (translations.length !== batch.length || translations.some(text => !text?.trim())) throw new Error('Translation returned incomplete dubbing text.');
        batch.forEach((cue, n) => { cue.translated = translations[n]; });
      }
      cues = cues.map(cue => ({ ...cue, speechText: cue.speechText ?? cue.translated }));
      if (cues.some(cue => !validString(cue.speechText))) throw new Error('Every cue must have a nonempty spoken translation (maximum 4096 characters).');
      await ensureTranslation();
      const referenceFile = path.join(work, 'reference.wav');
      await this.deps.reference(dialogue, referenceFile, reference.start, reference.duration, audioOptions);
      return await this.options.tts.withDubbingContext(async context => {
        signal.throwIfAborted();
        if (request.useTtsConfig) {
          const current = await this.options.tts.dubbingContextInfo!();
          if (normalizeQwenDubbingBaseUrl(context.baseUrl) !== activeBaseUrl || current.model !== activeModel) throw new Error('TTS 接口或模型已变更，请重新开始配音。 / TTS endpoint or model changed; restart dubbing.');
        }
        const credentials = { ...context, baseUrl: activeBaseUrl, model: activeModel }, client = this.deps.client(credentials);
        const referenceKey = hash([await digestFile(referenceFile, signal), activeModel, activeBaseUrl]);
        const account = hash(context.apiKey), voices = await this.voices();
        let voice = voices.find(item => item.reference === referenceKey && item.account === account);
        progress('voice', 0, 1, 'Registering or verifying the model-bound voice. Reference audio is sent to Alibaba Cloud.');
        if (voice) {
          if ((await client.queryVoice(voice.voiceId, signal)).status !== 'OK') throw new Error('Saved voice is not ready. Delete or repair it before retrying.');
        } else {
          if (voices.length >= 1000) throw new Error('Delete unused application-managed voices before creating another one.');
          const persist = async (created: { voiceId: string }) => {
            voice = { voiceId: created.voiceId, baseUrl: activeBaseUrl, account, reference: referenceKey };
            if (!voices.some(item => item.voiceId === created.voiceId)) {
              voices.push(voice); await saveJson(path.join(this.options.directory, 'voices.json'), voices);
            }
          };
          const result = await client.createVoice(referenceFile, signal, persist);
          // Test/custom clients may not implement the optional early-registration callback.
          if (!voice) await persist(result);
        }
        if (!voice) throw new Error('Voice registration did not return a manageable voice.');
        const segments: AudioSegment[] = [];
        const groups = groupDubbingUtterances(cues, targetLanguage);
        for (let gIndex = 0; gIndex < groups.length; gIndex++) {
          await ensureTranslation();
          const group = groups[gIndex];
          const primaryCue = group.cues[0];
          const label = group.cues.length > 1 ? `cues ${primaryCue.id}–${group.cues[group.cues.length - 1].id}` : `cue ${primaryCue.id}`;
          progress('synthesizing', group.startIndex, cues.length, `Generating ${label}; completed clips are cached for retries.`);
          const key = hash([activeModel, account, voice.voiceId, group.speechText, 'wav', 24000]);
          const generated = path.join(mediaDir, `speech-${key}.wav`);
          let cached = false;
          try { await readWavInfo(generated); cached = true; } catch { /* Generate only absent or invalid audio. */ }
          if (!cached) await client.synthesize(group.speechText, voice.voiceId, generated, signal);
          progress('aligning', group.startIndex, cues.length, `Aligning ${label} to its original time slot.`);
          try {
            const slotStart = group.start + request.offset;
            let slotEnd = group.end + request.offset;
            const nextStart = gIndex + 1 < groups.length ? groups[gIndex + 1].start + request.offset : duration;
            let activeGenerated = generated;
            try {
              const synthInfo = await readWavInfo(activeGenerated);
              if (nextStart > slotEnd && synthInfo.duration > slotEnd - slotStart) {
                slotEnd = Math.min(nextStart, Math.max(slotEnd, slotStart + synthInfo.duration));
              }
              // Closed-loop Aliyun LLM + TTS API duration control: if synthesized speech still overflows 1.45x of the slot,
              // request a tighter spoken translation via Aliyun LLM API and re-synthesize via Aliyun TTS API with rate control.
              const hasManualOverride = group.cues.some(c => Boolean(c.speechText && c.translated && c.speechText !== c.translated));
              if (!hasManualOverride && synthInfo.duration > (slotEnd - slotStart) * 1.45) {
                await ensureTranslation();
                const slotLen = Math.max(0.5, slotEnd - slotStart);
                const tightBudget = Math.max(0.5, slotLen * 0.72);
                const tightened = await this.options.translation.translate(
                  { texts: [group.cues.map(c => c.text).join(' ')] },
                  signal,
                  [tightBudget],
                );
                const compactSpeech = tightened[0]?.trim() || group.speechText;
                const cloudRate = Math.min(1.35, Math.max(1.1, Number((synthInfo.duration / (slotLen * 1.2)).toFixed(2))));
                group.speechText = compactSpeech;
                if (group.cues.length === 1) group.cues[0].speechText = compactSpeech;
                const compactKey = hash([activeModel, account, voice.voiceId, compactSpeech, cloudRate, 'wav', 24000]);
                const compactPath = path.join(mediaDir, `speech-${compactKey}.wav`);
                let compactCached = false;
                try { await readWavInfo(compactPath); compactCached = true; } catch {}
                if (!compactCached) await client.synthesize(compactSpeech, voice.voiceId, compactPath, signal, { rate: cloudRate });
                activeGenerated = compactPath;
              }
            } catch { /* Fall back to original slot boundaries if WAV header or compression retry fails. */ }
            const aligned = await this.deps.align({ filePath: activeGenerated, start: slotStart, end: slotEnd }, path.join(work, `aligned-${gIndex}.wav`), { ...audioOptions, maxTempo: 1.5 });
            segments.push(aligned);
          } catch (error) { throw new Error(`Cue ${primaryCue.id}: ${error instanceof Error ? error.message : String(error)} Edit the spoken translation and retry; previously generated clips are retained.`); }
        }
        await ensureTranslation();
        progress('mixing', 0, 1, 'Mixing translated speech with the separated background and copying the original video stream.');
        const resultDir = path.join(work, 'result'); await fs.mkdir(resultDir);
        const output = path.join(resultDir, 'translated.mkv'), audio = path.join(resultDir, 'translated.wav'), subtitles = path.join(resultDir, 'bilingual.srt');
        await this.deps.mix({ videoPath: video, backgroundPath: background, segments, duration, outputPath: output, backgroundGain: request.backgroundVolume }, audioOptions);
        await this.deps.extract(output, audio, audioOptions);
        await fs.writeFile(subtitles, dubbingSrt(cues, request.offset), { mode: 0o600 });
        signal.throwIfAborted();
        const finalDir = path.join(mediaDir, `result-${randomUUID()}`);
        await fs.rename(resultDir, finalDir);
        progress('complete', cues.length, cues.length, 'Dubbing complete. Listen for voice similarity, residual speech and background artifacts.');
        return { jobId: job.id, video: path.join(finalDir, 'translated.mkv'), audio: path.join(finalDir, 'translated.wav'), subtitles: path.join(finalDir, 'bilingual.srt'), cues, preview: request.preview, targetLanguage, voiceId: voice.voiceId };
      });
    } catch (error) {
      if (signal.aborted) throw new Error(`${timedOut ? 'Dubbing exceeded its 12-hour deadline.' : 'Dubbing cancelled.'} Already submitted cloud requests may still be billed; completed clips are kept.`);
      throw error;
    } finally {
      clearTimeout(deadline);
      if (work) await fs.rm(work, { recursive: true, force: true }).catch(() => {});
      if (this.active === job) this.active = undefined;
    }
  }
}
