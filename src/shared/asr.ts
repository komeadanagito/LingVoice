export interface AsrSettings {
  providerId?: string;
  baseUrl: string;
  fullUrl: boolean;
  model: string;
  language: string;
  prompt: string;
}

export const defaultAsrSettings: AsrSettings = {
  providerId: '',
  baseUrl: 'https://api.openai.com/v1',
  fullUrl: false,
  model: 'whisper-1',
  language: '',
  prompt: '',
};

export interface AsrConfig { settings: AsrSettings; hasApiKey: boolean }
export interface AsrConfigUpdate { settings: AsrSettings; apiKey?: string }
export interface AsrCue { id: number; start: number; end: number; text: string }
export interface AsrProgress { stage: 'extracting' | 'transcribing'; completed: number; total: number }
export interface AsrRequest { file: string }
