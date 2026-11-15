import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createDefaultProviderRegistry, type ProviderService } from './providers';
import { DEFAULT_TTS_BASE_URL, defaultTtsSettings, type TtsSettings, type TtsConfig, type TtsConfigUpdate, type TtsRequest, type TtsAudio } from '../shared/tts';
import type { InferenceMode } from '../shared/local-models';
import type { LocalPluginManager } from './local-plugins';

const MAX_AUDIO_BYTES = 10 * 1024 * 1024;
const TIMEOUT_MS = 120_000;
const fallbackTts = createDefaultProviderRegistry().get('openai-compatible').tts!;
const SETTINGS_KEYS = ['providerId', 'model', 'voice', 'speed', 'fullUrl', 'baseUrl', 'mode'] as const;
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function exact(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).length === keys.length && Object.keys(value).every(key => keys.includes(key));
}
function metadata(value: unknown, empty = false): value is string {
  return typeof value === 'string' && value.length <= 200 && (empty || !!value.trim()) && !/[\u0000-\u001f\u007f]/.test(value);
}
function apiUrl(value: unknown, empty = false): string {
  if (typeof value !== 'string' || value.length > 2048) throw new Error('Invalid speech API URL.');
  const input = value.trim();
  if (!input) {
    if (empty) return '';
    throw new Error('Invalid speech API URL.');
  }
  try {
    const url = new URL(input);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || input.includes('#')) throw new Error();
    return input;
  } catch { throw new Error('Invalid speech API URL: use HTTP or HTTPS without credentials or fragments.'); }
}
export function alibabaApiRoot(value: string): string {
  if (!value.trim()) return '';
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'https:' || url.username || url.password) return '';
    if (url.hostname === 'dashscope.aliyuncs.com') return 'https://dashscope.aliyuncs.com/api/v1';
    if (url.hostname === 'dashscope-intl.aliyuncs.com') return 'https://dashscope-intl.aliyuncs.com/api/v1';
    if (/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.(cn-beijing|ap-southeast-1)\.maas\.aliyuncs\.com$/.test(url.hostname)) {
      return `https://${url.hostname}/api/v1`;
    }
    return '';
  } catch { return ''; }
}
function settings(value: unknown): TtsSettings {
  if (!record(value) || typeof value.fullUrl !== 'boolean' ||
    !['providerId', 'model', 'voice', 'speed', 'fullUrl'].every(key => Object.hasOwn(value, key)) ||
    Object.keys(value).some(key => !SETTINGS_KEYS.includes(key as typeof SETTINGS_KEYS[number])) ||
    (value.mode !== undefined && value.mode !== 'cloud' && value.mode !== 'local') ||
    !metadata(value.providerId, true) || (value.providerId !== '' && !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value.providerId)) ||
    !metadata(value.model) || !metadata(value.voice) || typeof value.speed !== 'number' ||
    !Number.isFinite(value.speed) || value.speed < 0.25 || value.speed > 4) {
    throw new Error('Invalid speech settings. Speed must be between 0.25 and 4.');
  }
  return {
    ...(value.mode === 'local' ? { mode: 'local' as const } : {}),
    providerId: value.providerId, baseUrl: apiUrl(value.baseUrl ?? '', true),
    model: value.model.trim(), voice: value.voice.trim(), speed: value.speed, fullUrl: value.fullUrl,
  };
}

class LocalTtsError extends Error {}

function guessV5Lang(input: string): 'zh' | 'en' | 'ja' | 'ko' {
  if (/[\u3040-\u30ff]/.test(input)) return 'ja';
  if (/[\uac00-\ud7af]/.test(input)) return 'ko';
  if (/[\u4e00-\u9fff]/.test(input)) return 'zh';
  return 'en';
}

interface Vault { encrypt(value: string): string; decrypt(value: string): string }
interface SavedConfig {
  settings: TtsSettings;
  apiKey: string;
}

/** Speech requests use only saved settings and backend-resolved provider credentials. */
export class TtsService {
  private state?: SavedConfig;
  private pending: Promise<void> = Promise.resolve();
  private active?: AbortController;
  private dubbingActive = false;

  constructor(
    private readonly file: string,
    private readonly providers: ProviderService,
    private readonly vault?: Vault,
    private readonly localPlugins?: LocalPluginManager,
  ) {}
  get busy(): boolean { return this.active !== undefined || this.dubbingActive; }
  cancel(): void { this.active?.abort(); }

  private async resolveAccess(state: SavedConfig): Promise<{ baseUrl: string; apiKey: string; providerName: string; tts: NonNullable<typeof fallbackTts> }> {
    const resolved = state.settings.providerId ? await this.providers.resolve(state.settings.providerId, 'tts') : undefined;
    let apiKey = '';
    if (state.apiKey) {
      try { apiKey = this.vault ? this.vault.decrypt(state.apiKey) : state.apiKey; }
      catch { throw new Error('Unable to decrypt speech credentials. Save the key again.'); }
    } else {
      apiKey = resolved?.context.apiKey ?? '';
    }
    const baseUrl = state.settings.baseUrl || resolved?.context.baseUrl || DEFAULT_TTS_BASE_URL;
    return {
      baseUrl,
      apiKey,
      providerName: resolved?.provider.name ?? '',
      tts: resolved?.adapter.tts ?? fallbackTts,
    };
  }

  /** Backend-only credential access. Ordinary read-aloud cannot interrupt a dubbing reservation. */
  async withDubbingContext<T>(action: (context: { baseUrl: string; apiKey: string }) => Promise<T>): Promise<T> {
    if (this.busy) throw new Error('Speech synthesis is busy. Stop the current task first.');
    this.dubbingActive = true;
    try {
      await this.pending;
      const state = await this.load();
      let access: { baseUrl: string; apiKey: string };
      try { access = await this.resolveAccess(state); }
      catch { throw new Error('Save a TTS Base URL and Alibaba Cloud API key in Settings before dubbing.'); }
      const root = alibabaApiRoot(access.baseUrl);
      if (!root) throw new Error('Use an official Alibaba Cloud /api/v1 endpoint (DashScope or workspace).');
      if (!access.apiKey) throw new Error('Save an Alibaba Cloud API key in the TTS settings.');
      return await action({ baseUrl: root, apiKey: access.apiKey });
    } finally { this.dubbingActive = false; }
  }

  async dubbingContextInfo(): Promise<{ providerName: string; baseUrl: string; hasApiKey: boolean; model?: string; mode?: InferenceMode }> {
    try {
      const state = await this.load();
      if (state.settings.mode === 'local') {
        return {
          providerName: 'Local GPT-SoVITS V5',
          baseUrl: 'http://127.0.0.1:9873',
          hasApiKey: true,
          model: state.settings.model,
          mode: 'local',
        };
      }
      const access = await this.resolveAccess(state);
      return {
        providerName: access.providerName,
        baseUrl: alibabaApiRoot(access.baseUrl) || alibabaApiRoot(DEFAULT_TTS_BASE_URL) || DEFAULT_TTS_BASE_URL,
        hasApiKey: !!access.apiKey,
        model: state.settings.model,
        mode: 'cloud',
      };
    } catch {
      return { providerName: '', baseUrl: DEFAULT_TTS_BASE_URL, hasApiKey: false, mode: 'cloud' };
    }
  }

  private async load(): Promise<SavedConfig> {
    if (this.state) return this.state;
    let raw: string;
    try { raw = await fs.readFile(this.file, 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return this.state = { settings: { ...defaultTtsSettings }, apiKey: '' };
      throw new Error('Unable to read speech configuration.');
    }
    try {
      const value: unknown = JSON.parse(raw);
      if (!record(value) || !record(value.settings)) throw new Error();
      const apiKey = typeof value.apiKey === 'string' ? value.apiKey : '';
      return this.state = { settings: settings(value.settings), apiKey };
    } catch { throw new Error('Invalid saved speech configuration.'); }
  }
  private serial<T>(action: () => Promise<T>): Promise<T> {
    const operation = this.pending.then(action);
    this.pending = operation.then(() => {}, () => {});
    return operation;
  }
  getConfig(): Promise<TtsConfig> {
    return this.serial(async () => {
      const state = await this.load();
      return { settings: { ...state.settings }, hasApiKey: !!state.apiKey };
    });
  }
  async saveConfig(update: TtsConfigUpdate): Promise<TtsConfig> {
    if (!record(update) || !record(update.settings)) throw new Error('Invalid speech configuration.');
    const validated = settings(update.settings);
    const key = Object.hasOwn(update, 'apiKey') ? (update.apiKey ? String(update.apiKey).trim() : '') : undefined;
    return this.serial(async () => {
      if (validated.providerId) await this.providers.resolve(validated.providerId, 'tts');
      const current = await this.load();
      let encrypted = current.apiKey;
      try {
        if (key !== undefined) encrypted = key ? (this.vault ? this.vault.encrypt(key) : key) : '';
      } catch { throw new Error('Unable to securely store speech credentials.'); }
      const next: SavedConfig = { settings: validated, apiKey: encrypted };
      const temporary = `${this.file}.${randomUUID()}.tmp`;
      try {
        await fs.mkdir(path.dirname(this.file), { recursive: true });
        await fs.writeFile(temporary, JSON.stringify(next), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
        await fs.rename(temporary, this.file);
      } catch {
        await fs.rm(temporary, { force: true }).catch(() => {});
        throw new Error('Unable to save speech configuration.');
      }
      this.state = next;
      return { settings: { ...validated }, hasApiKey: !!encrypted };
    });
  }

  async generate(request: TtsRequest): Promise<TtsAudio> {
    if (!record(request) || !exact(request, ['text']) || typeof request.text !== 'string' ||
      !request.text.trim() || request.text.length > 4096 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(request.text)) {
      throw new Error('Provide between 1 and 4096 characters of speech text, without settings overrides.');
    }
    if (this.busy) throw new Error('Speech generation is already in progress.');
    const inputText = request.text;
    const controller = new AbortController();
    this.active = controller;
    let timedOut = false;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, TIMEOUT_MS);
    let onAbort: () => void = () => {};
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => {
        void reader?.cancel().catch(() => {});
        reject(new Error('Speech generation cancelled.'));
      };
      controller.signal.addEventListener('abort', onAbort, { once: true });
    });
    try {
      return await Promise.race([aborted, (async (): Promise<TtsAudio> => {
        const state = await this.load();
        const config = state.settings;
        controller.signal.throwIfAborted();
        if (config.mode === 'local') {
          if (!this.localPlugins) throw new LocalTtsError('当前后端未启用本地模型插件管理器。 / Local plugin manager is unavailable.');
          try {
            await this.localPlugins.ensureRunning('voice-clone', controller.signal);
          } catch (err) {
            throw new LocalTtsError(err instanceof Error ? err.message : String(err));
          }
          const refsDir = this.localPlugins.referencesDir();
          let refFile = '';
          try {
            const entries = await fs.readdir(refsDir);
            refFile = entries.find(name => name.toLowerCase().endsWith('.wav') && !name.startsWith('lingvoice-')) ?? '';
          } catch {}
          if (!refFile) {
            throw new LocalTtsError('本地声音克隆服务 (GPT-SoVITS V5) 启动并健康检查通过！但单独测试合成需要在 plugins/voice-clone/references/ 放置一段 3–10 秒单声道 WAV 参考音频（视频配音时会自动从视频提取）。');
          }
          let promptText = '';
          try {
            const txtPath = path.join(refsDir, refFile.replace(/\.wav$/i, '.txt'));
            promptText = (await fs.readFile(txtPath, 'utf8')).trim().slice(0, 500);
          } catch {}
          if (!promptText) promptText = '这是一段用于音色参考的测试语音。';
          const clippedText = inputText.trim().slice(0, 500);
          try {
            const wav = await this.localPlugins.requestAudio('voice-clone', '/tts', {
              text: clippedText,
              text_lang: guessV5Lang(clippedText),
              ref_audio_path: refFile,
              prompt_text: promptText,
              prompt_lang: guessV5Lang(promptText),
              consent: true,
              speed_factor: Math.min(1.25, Math.max(0.75, config.speed || 1)),
              seed: 42,
            }, controller.signal);
            return { mimeType: 'audio/wav', audioBase64: wav.toString('base64'), fileName: 'speech.wav' };
          } catch (err) {
            throw new LocalTtsError(err instanceof Error ? err.message : String(err));
          }
        }
        let access: { baseUrl: string; apiKey: string; tts: NonNullable<typeof fallbackTts> };
        try { access = await this.resolveAccess(state); }
        catch (error) {
          if (error instanceof Error && /decrypt/.test(error.message)) throw error;
          throw new Error();
        }
        controller.signal.throwIfAborted();
        const http = access.tts.build({ baseUrl: access.baseUrl, apiKey: access.apiKey }, {
          text: inputText, model: config.model, voice: config.voice, speed: config.speed, fullUrl: config.fullUrl,
        });
        const response = await fetch(http.url, { ...http.init, redirect: 'error', signal: controller.signal });
        if (controller.signal.aborted) {
          void response.body?.cancel().catch(() => {});
          controller.signal.throwIfAborted();
        }
        const mime = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
        if (response.ok && mime === 'application/json') {
          const json: unknown = await response.json();
          let audioUrl = '';
          let audioBase64 = '';
          if (record(json) && record(json.output) && record(json.output.audio)) {
            if (typeof json.output.audio.url === 'string' && json.output.audio.url) {
              audioUrl = json.output.audio.url;
            } else if (typeof json.output.audio.data === 'string' && json.output.audio.data) {
              audioBase64 = json.output.audio.data;
            }
          }
          if (audioBase64) {
            const buf = Buffer.from(audioBase64, 'base64');
            if (!buf.length || buf.length > MAX_AUDIO_BYTES) throw new Error();
            return { mimeType: 'audio/mpeg', audioBase64, fileName: 'speech.mp3' };
          }
          if (audioUrl) {
            controller.signal.throwIfAborted();
            const fileRes = await fetch(audioUrl, { signal: controller.signal, redirect: 'error' });
            if (!fileRes.ok || Number(fileRes.headers.get('content-length')) > MAX_AUDIO_BYTES) {
              void fileRes.body?.cancel().catch(() => {});
              throw new Error();
            }
            reader = fileRes.body?.getReader();
            if (!reader) throw new Error();
            const chunks: Uint8Array[] = [];
            let bytes = 0;
            while (true) {
              const chunk = await reader.read();
              controller.signal.throwIfAborted();
              if (chunk.done) break;
              bytes += chunk.value.byteLength;
              if (bytes > MAX_AUDIO_BYTES) throw new Error();
              chunks.push(chunk.value);
            }
            if (!bytes) throw new Error();
            return { mimeType: 'audio/mpeg', audioBase64: Buffer.concat(chunks, bytes).toString('base64'), fileName: 'speech.mp3' };
          }
          throw new Error();
        }

        const validAudioMimes = ['audio/mpeg', 'audio/mp3', 'application/octet-stream', 'audio/x-mpeg', 'audio/wav', 'audio/x-wav'];
        if (!response.ok || !validAudioMimes.includes(mime ?? '') ||
          Number(response.headers.get('content-length')) > MAX_AUDIO_BYTES) {
          void response.body?.cancel().catch(() => {});
          throw new Error();
        }
        reader = response.body?.getReader();
        if (!reader) throw new Error();
        const chunks: Uint8Array[] = [];
        let bytes = 0;
        while (true) {
          const chunk = await reader.read();
          controller.signal.throwIfAborted();
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > MAX_AUDIO_BYTES) throw new Error();
          chunks.push(chunk.value);
        }
        if (!bytes) throw new Error();
        return { mimeType: 'audio/mpeg', audioBase64: Buffer.concat(chunks, bytes).toString('base64'), fileName: 'speech.mp3' };
      })()]);
    } catch (err) {
      if (controller.signal.aborted) throw new Error(timedOut ? 'Speech generation timed out.' : 'Speech generation cancelled.');
      if (err instanceof LocalTtsError) throw err;
      throw new Error('Speech generation failed. Check the saved settings, provider configuration and availability.');
    } finally {
      clearTimeout(timer);
      controller.signal.removeEventListener('abort', onAbort);
      void reader?.cancel().catch(() => {});
      if (this.active === controller) this.active = undefined;
    }
  }
}
