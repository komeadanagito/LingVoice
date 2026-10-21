import type { Locale, MessageKey, MessageValues } from './i18n/catalog';
import type { TranslationConfig, TranslationConfigUpdate, TranslationRequest } from './translation';
import type { AsrConfig, AsrConfigUpdate, AsrCue, AsrProgress, AsrRequest } from './asr';
import type { TtsAudio, TtsConfig, TtsConfigUpdate, TtsRequest } from './tts';
import type { DubbingConfig, DubbingEnvironment, DubbingSettings, DubbingRequest, DubbingResult, DubbingProgress } from './dubbing';
import type { ProviderCatalog, ProviderUpdate, Provider } from './providers';

export interface VideoInfo {
  titleKey?: MessageKey;
  uploaderKey?: MessageKey;
  id?: string;
  title: string;
  uploader: string;
  duration: number;
  thumbnail: string;
  heights: number[];
  partCount: number;
}

export interface DownloadProgress {
  status?: string;
  percent: number | null;
  downloaded: number;
  total: number;
  speed: number;
  eta: number;
  filename: string;
}

export type DownloadEvent =
  | { type: 'status'; message: string; messageKey?: MessageKey; messageValues?: MessageValues }
  | ({ type: 'progress' } & DownloadProgress);

export interface DownloadRequest { url: string; height: string }
export interface DownloadResult { file: string }
export interface AppState { folder: string; version: string; locale: Locale }
export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: string; errorKey?: MessageKey; errorValues?: MessageValues };

export interface IpcContract {
  'dubbing:config': { args: []; result: DubbingConfig };
  'dubbing:save': { args: [settings: DubbingSettings]; result: DubbingConfig };
  'dubbing:check': { args: []; result: DubbingEnvironment };
  'dubbing:run': { args: [request: DubbingRequest]; result: DubbingResult };
  'dubbing:cancel': { args: [jobId: string]; result: void };
  'dubbing:clear': { args: []; result: void };
  'dubbing:deleteVoice': { args: [voiceId: string]; result: void };
  'providers:list': { args: []; result: ProviderCatalog };
  'providers:save': { args: [update: ProviderUpdate]; result: Provider };
  'providers:models': { args: [id: string]; result: string[] };
  'tts:config': { args: []; result: TtsConfig };
  'tts:save': { args: [update: TtsConfigUpdate]; result: TtsConfig };
  'tts:generate': { args: [request: TtsRequest]; result: TtsAudio };
  'tts:cancel': { args: []; result: void };
  'providers:remove': { args: [id: string]; result: void };
  'asr:config': { args: []; result: AsrConfig };
  'asr:save': { args: [update: AsrConfigUpdate]; result: AsrConfig };
  'asr:run': { args: [request: AsrRequest]; result: AsrCue[] };
  'asr:cancel': { args: []; result: void };
  'asr:test': { args: []; result: void };
  'translation:config': { args: []; result: TranslationConfig };
  'translation:save': { args: [update: TranslationConfigUpdate]; result: TranslationConfig };
  'translation:models': { args: []; result: string[] };
  'translation:run': { args: [request: TranslationRequest]; result: string[] };
  'app:state': { args: []; result: AppState };
  'app:locale': { args: [locale: Locale]; result: Locale };
  'folder:choose': { args: []; result: string };
  'folder:open': { args: []; result: void };
  'cookies:choose': { args: []; result: string };
  'cookies:clear': { args: []; result: void };
  'video:inspect': { args: [url: string]; result: VideoInfo };
  'video:download': { args: [options: DownloadRequest]; result: DownloadResult };
  'video:cancel': { args: []; result: void };
  'video:reveal': { args: []; result: void };
}

export interface LingVoiceApi {
  /** Identifies the transport; both runtimes support provider-backed tasks. */
  runtime?: 'desktop' | 'browser';
  dubbingConfig(): Promise<IpcResult<DubbingConfig>>;
  saveDubbingConfig(settings: DubbingSettings): Promise<IpcResult<DubbingConfig>>;
  checkDubbing(): Promise<IpcResult<DubbingEnvironment>>;
  runDubbing(request: DubbingRequest): Promise<IpcResult<DubbingResult>>;
  cancelDubbing(jobId: string): Promise<IpcResult<void>>;
  clearDubbingCache(): Promise<IpcResult<void>>;
  deleteDubbingVoice(voiceId: string): Promise<IpcResult<void>>;
  onDubbingProgress(callback: (progress: DubbingProgress) => void): () => void;
  providers(): Promise<IpcResult<ProviderCatalog>>;
  saveProvider(update: ProviderUpdate): Promise<IpcResult<Provider>>;
  providerModels(id: string): Promise<IpcResult<string[]>>;
  ttsConfig(): Promise<IpcResult<TtsConfig>>;
  saveTtsConfig(update: TtsConfigUpdate): Promise<IpcResult<TtsConfig>>;
  generateSpeech(request: TtsRequest): Promise<IpcResult<TtsAudio>>;
  cancelTts(): Promise<IpcResult<void>>;
  removeProvider(id: string): Promise<IpcResult<void>>;
  localFilePath(file: File): string;
  asrConfig(): Promise<IpcResult<AsrConfig>>;
  saveAsrConfig(update: AsrConfigUpdate): Promise<IpcResult<AsrConfig>>;
  transcribe(request: AsrRequest): Promise<IpcResult<AsrCue[]>>;
  cancelAsr(): Promise<IpcResult<void>>;
  testAsr(): Promise<IpcResult<void>>;
  onAsrProgress(callback: (progress: AsrProgress) => void): () => void;
  translationConfig(): Promise<IpcResult<TranslationConfig>>;
  saveTranslationConfig(update: TranslationConfigUpdate): Promise<IpcResult<TranslationConfig>>;
  translationModels(): Promise<IpcResult<string[]>>;
  translateSubtitles(request: TranslationRequest): Promise<IpcResult<string[]>>;
  state(): Promise<IpcResult<AppState>>;
  setLocale(locale: Locale): Promise<IpcResult<Locale>>;
  chooseFolder(): Promise<IpcResult<string>>;
  openFolder(): Promise<IpcResult<void>>;
  chooseCookies(): Promise<IpcResult<string>>;
  clearCookies(): Promise<IpcResult<void>>;
  inspect(url: string): Promise<IpcResult<VideoInfo>>;
  download(options: DownloadRequest): Promise<IpcResult<DownloadResult>>;
  cancel(): Promise<IpcResult<void>>;
  reveal(): Promise<IpcResult<void>>;
  onEvent(callback: (event: DownloadEvent) => void): () => void;
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error || '操作失败，请重试。');
}
