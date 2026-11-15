export type InferenceMode = 'cloud' | 'local';
export type LocalPluginId = 'asr' | 'translation' | 'voice-clone';
export type ModelDownloadSource = 'modelscope' | 'huggingface';
export type LocalEngineDownloadTarget = LocalPluginId | 'separation' | 'all';

export interface LocalModelDownloadRequest {
  target: LocalEngineDownloadTarget;
  source: ModelDownloadSource;
}

export interface LocalModelDownloadProgress {
  active: boolean;
  target: LocalEngineDownloadTarget | null;
  source: ModelDownloadSource;
  stage: string;
  message: string;
  percent: number | null;
  completedFiles: number;
  totalFiles: number;
  error?: string;
}

export interface LocalPluginStatus {
  id: LocalPluginId;
  port: number;
  installed: boolean;
  weightsReady: boolean;
  running: boolean;
  healthy: boolean;
  modelLabel: string;
  detail?: string;
}

export interface LocalModelsStatus {
  available: boolean;
  pluginsDir: string;
  activeService: LocalPluginId | null;
  services: Record<LocalPluginId, LocalPluginStatus>;
  download?: LocalModelDownloadProgress;
}
