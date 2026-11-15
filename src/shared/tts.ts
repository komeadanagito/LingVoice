import { DEFAULT_DUBBING_MODEL } from './dubbing';
import type { InferenceMode } from './local-models';

export const DEFAULT_TTS_BASE_URL = 'https://dashscope.aliyuncs.com/api/v1';

export interface TtsSettings {
  mode?: InferenceMode;
  providerId: string;
  baseUrl: string;
  model: string;
  voice: string;
  speed: number;
  fullUrl: boolean;
}

export const defaultTtsSettings: TtsSettings = {
  providerId: '', baseUrl: '', model: DEFAULT_DUBBING_MODEL, voice: 'alloy', speed: 1, fullUrl: false,
};

export interface TtsConfig {
  settings: TtsSettings;
  hasApiKey: boolean;
}
export interface TtsConfigUpdate {
  settings: TtsSettings;
  apiKey?: string;
}
export interface TtsRequest { text: string }
export interface TtsAudio { mimeType: 'audio/mpeg' | 'audio/wav'; audioBase64: string; fileName: string }
