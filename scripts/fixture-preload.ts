// Offline fixture used only by the desktop test, never included in the packaged application.
import { contextBridge } from 'electron';
import type { DownloadEvent, LingVoiceApi } from '../src/shared/contracts';
import type { Locale } from '../src/shared/i18n/catalog';
import type { TranslationSettings } from '../src/shared/translation';
import type { AsrSettings, AsrProgress } from '../src/shared/asr';
import type { Provider } from '../src/shared/providers';

// Sandboxed preloads cannot require application modules at runtime.
const defaultTranslationSettings: TranslationSettings = {
  providerId: 'fixture-provider',
  engine: 'llm', protocol: 'chat', baseUrl: 'https://api.openai.com/v1', fullUrl: false,
  model: 'test-model', displayName: 'Offline test', machineUrl: 'http://localhost:5000', sourceLanguage: 'auto', targetLanguage: 'zh',
};

const listeners = new Set<(event: DownloadEvent) => void>();
let cancelled = false;
let locale: Locale = 'zh-CN';
const providers: Provider[] = [{ id: 'fixture-provider', name: 'Offline provider', adapter: 'openai-compatible', baseUrl: 'https://api.openai.com/v1', hasApiKey: false }];
const asrListeners = new Set<(progress: AsrProgress) => void>();
let asrSettings: AsrSettings = { providerId: 'fixture-provider', baseUrl: 'https://api.openai.com/v1', fullUrl: false, model: 'whisper-1', language: '', prompt: '' };
let asrCancelled = false;
const api: LingVoiceApi = {
  providers: async () => ({ ok: true, data: { providers: providers.map(value => ({ ...value })), adapters: [
    { id: 'openai-compatible', name: 'OpenAI compatible', capabilities: ['translation', 'asr', 'models'], defaultBaseUrl: 'https://api.openai.com/v1', translationOptions: { model: true, protocols: ['chat', 'responses'] } },
    { id: 'libretranslate', name: 'LibreTranslate', capabilities: ['translation'], defaultBaseUrl: 'http://localhost:5000' },
  ] } }),
  saveProvider: async update => { const value = { id: update.id || `fixture-${providers.length}`, name: update.name, adapter: update.adapter, baseUrl: update.baseUrl, hasApiKey: Boolean(update.apiKey) }; const index = providers.findIndex(provider => provider.id === value.id); if (index < 0) providers.push(value); else providers[index] = value; return { ok: true, data: value }; },
  removeProvider: async id => { const index = providers.findIndex(provider => provider.id === id); if (index >= 0) providers.splice(index, 1); return { ok: true, data: undefined }; },
  localFilePath: () => 'C:\\Downloads\\local-test.mp4',
  asrConfig: async () => ({ ok: true, data: { settings: asrSettings, hasApiKey: false } }),
  saveAsrConfig: async update => { asrSettings = update.settings; return { ok: true, data: { settings: asrSettings, hasApiKey: false } }; },
  transcribe: async () => { asrCancelled = false; for (const listener of asrListeners) listener({ stage: 'transcribing', completed: 0, total: 1 }); await new Promise(resolve => setTimeout(resolve, 100)); return asrCancelled ? { ok: false, error: 'ASR cancelled.' } : { ok: true, data: [{ id: 1, start: 0, end: 5, text: 'Recognized speech' }] }; },
  cancelAsr: async () => { asrCancelled = true; return { ok: true, data: undefined }; },
  onAsrProgress: callback => { asrListeners.add(callback); return () => { asrListeners.delete(callback); }; },
  translationConfig: async () => ({ ok: true, data: { settings: defaultTranslationSettings, hasApiKey: false, hasMachineKey: false } }),
  saveTranslationConfig: async update => ({ ok: true, data: { settings: update.settings, hasApiKey: Boolean(update.apiKey), hasMachineKey: Boolean(update.machineKey) } }),
  translationModels: async () => ({ ok: true, data: ['test-model'] }),
  translateSubtitles: async request => ({ ok: true, data: request.texts.map(text => `译文：${text}`) }),
  state: async () => ({ ok: true, data: { folder: 'C:\\Downloads\\LingVoice', version: 'test', locale } }),
  setLocale: async value => { locale = value; return { ok: true, data: locale }; },
  chooseFolder: async () => ({ ok: true, data: 'C:\\Downloads\\Selected' }),
  openFolder: async () => ({ ok: true, data: undefined }),
  chooseCookies: async () => ({ ok: true, data: 'test-cookies.txt' }),
  clearCookies: async () => ({ ok: true, data: undefined }),
  inspect: async () => ({ ok: true, data: {
    id: 'test-video', title: '<img src=x onerror=alert(1)> React 测试视频', uploader: '测试 UP 主',
    duration: 125, thumbnail: '', heights: [1080, 720], partCount: 1,
  } }),
  download: async options => {
    if (options.height !== '720') return { ok: false, error: '测试应选择 720P' };
    cancelled = false;
    for (const listener of listeners) listener({ type: 'progress', percent: 50, downloaded: 512, total: 1024, speed: 256, eta: 2, filename: 'test.mp4' });
    await new Promise(resolve => setTimeout(resolve, 1200));
    return cancelled ? { ok: false, error: '已取消任务。', errorKey: 'errors.cancelled' } : { ok: true, data: { file: 'C:\\Downloads\\LingVoice\\test.mp4' } };
  },
  cancel: async () => { cancelled = true; return { ok: true, data: undefined }; },
  reveal: async () => ({ ok: true, data: undefined }),
  onEvent: callback => { listeners.add(callback); return () => { listeners.delete(callback); }; },
};
contextBridge.exposeInMainWorld('lingvoice', api);
