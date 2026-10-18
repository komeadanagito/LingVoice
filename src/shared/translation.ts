export interface TranslationSettings {
  /** Provider identity; endpoints and credentials are owned by the provider catalog. */
  providerId?: string;
  /** @deprecated Retained for migration/standalone callers; providerId selects the live adapter. */
  engine: 'llm' | 'machine';
  protocol: string;
  baseUrl: string;
  fullUrl: boolean;
  model: string;
  displayName: string;
  machineUrl: string;
  sourceLanguage: string;
  targetLanguage: string;
}

export const defaultTranslationSettings: TranslationSettings = {
  providerId: '',
  engine: 'llm',
  protocol: 'chat',
  baseUrl: 'https://api.openai.com/v1',
  fullUrl: false,
  model: 'gpt-4o-mini',
  displayName: 'OpenAI',
  machineUrl: 'http://localhost:5000',
  sourceLanguage: 'auto',
  targetLanguage: 'zh',
};

export interface TranslationConfig {
  settings: TranslationSettings;
  hasApiKey: boolean;
  hasMachineKey: boolean;
}

/** Omitted keys retain the saved secret; an empty string clears it. */
export interface TranslationConfigUpdate {
  settings: TranslationSettings;
  apiKey?: string;
  machineKey?: string;
}

/** Translation always uses the backend's saved settings. */
export interface TranslationRequest {
  texts: string[];
  settings?: never;
}
