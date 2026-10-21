export const SUPPORTED_DUBBING_MODELS = ['qwen-audio-3.1-tts-plus', 'qwen-audio-3.0-tts-plus'] as const;
export type DubbingModel = (typeof SUPPORTED_DUBBING_MODELS)[number];
export const DEFAULT_DUBBING_MODEL: DubbingModel = 'qwen-audio-3.1-tts-plus';
/** Default model for dubbing; users can also choose qwen-audio-3.0-tts-plus. */
export const DUBBING_MODEL = DEFAULT_DUBBING_MODEL;
export interface DubbingSettings {
  pythonPath: string;
  modelFile: string;
  /** Official regional/workspace API root, ending in /api/v1. */
  baseUrl: string;
  /** Dubbing synthesis and cloning target model. */
  model?: DubbingModel;
}
export const defaultDubbingSettings: DubbingSettings = {
  pythonPath: 'python', modelFile: '', baseUrl: '', model: DEFAULT_DUBBING_MODEL,
};
export interface DubbingEnvironment { ready: boolean; message: string }
export interface DubbingCue {
  id: number;
  start: number;
  end: number;
  text: string;
  translated?: string;
  /** Independently editable spoken translation; never overwrites the subtitle translation. */
  speechText?: string;
}
export interface DubbingRequest {
  jobId: string;
  file: string;
  cues: DubbingCue[];
  offset: number;
  backgroundVolume: number;
  /** Restricts generation to the first <= 30 seconds; full source is never sent to TTS. */
  preview: boolean;
  /** Explicit consent for reference audio upload and billable synthesis. */
  consent: boolean;
}
export type DubbingStage = 'preparing' | 'separating' | 'translating' | 'voice' | 'synthesizing' | 'aligning' | 'mixing' | 'complete';
export interface DubbingProgress { jobId: string; stage: DubbingStage; completed: number; total: number; message: string }
export interface DubbingResult {
  jobId: string;
  video: string;
  audio: string;
  subtitles: string;
  cues: DubbingCue[];
  preview: boolean;
  targetLanguage: string;
  /** Voice remains visible so the user can explicitly delete it. */
  voiceId: string;
}
export interface DubbingConfig {
  settings: DubbingSettings;
  model: DubbingModel;
  /** Application-created voices remain manageable after failed jobs or cache cleanup. No credentials. */
  voices?: { voiceId: string; baseUrl: string }[];
  ttsProviderName?: string;
  hasTtsApiKey?: boolean;
}
