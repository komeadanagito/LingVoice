export interface TtsSettings {
  providerId: string;
  model: string;
  voice: string;
  speed: number;
  fullUrl: boolean;
}

export const defaultTtsSettings: TtsSettings = {
  providerId: '', model: 'tts-1', voice: 'alloy', speed: 1, fullUrl: false,
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
export interface TtsAudio { mimeType: 'audio/mpeg'; audioBase64: string; fileName: string }
