import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ProviderService } from './providers';
import { defaultTtsSettings, type TtsSettings, type TtsConfig, type TtsConfigUpdate, type TtsRequest, type TtsAudio } from '../shared/tts';

const MAX_AUDIO_BYTES = 10 * 1024 * 1024;
const TIMEOUT_MS = 120_000;
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function exact(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).length === keys.length && Object.keys(value).every(key => keys.includes(key));
}
function metadata(value: unknown, empty = false): value is string {
  return typeof value === 'string' && value.length <= 200 && (empty || !!value.trim()) && !/[\u0000-\u001f\u007f]/.test(value);
}
function settings(value: unknown): TtsSettings {
  if (!record(value) || !exact(value, ['providerId', 'model', 'voice', 'speed', 'fullUrl']) ||
    !metadata(value.providerId, true) || (value.providerId !== '' && !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value.providerId)) ||
    !metadata(value.model) || !metadata(value.voice) || typeof value.speed !== 'number' ||
    !Number.isFinite(value.speed) || value.speed < 0.25 || value.speed > 4 || typeof value.fullUrl !== 'boolean') {
    throw new Error('Invalid speech settings. Speed must be between 0.25 and 4.');
  }
  return { providerId: value.providerId, model: value.model.trim(), voice: value.voice.trim(), speed: value.speed, fullUrl: value.fullUrl };
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

  constructor(private readonly file: string, private readonly providers: ProviderService, private readonly vault?: Vault) {}
  get busy(): boolean { return this.active !== undefined || this.dubbingActive; }
  cancel(): void { this.active?.abort(); }

  /** Backend-only credential access. Ordinary read-aloud cannot interrupt a dubbing reservation. */
  async withDubbingContext<T>(action: (context: { baseUrl: string; apiKey: string }) => Promise<T>): Promise<T> {
    if (this.busy) throw new Error('Speech synthesis is busy. Stop the current task first.');
    this.dubbingActive = true;
    try {
      await this.pending;
      const state = await this.load();
      if (!state.settings.providerId) throw new Error('Save a TTS provider in Settings before dubbing.');
      const resolved = await this.providers.resolve(state.settings.providerId, 'tts');
      const apiKey = state.apiKey ? (this.vault ? this.vault.decrypt(state.apiKey) : state.apiKey) : resolved.context.apiKey;
      if (!apiKey) throw new Error('Save an Alibaba Cloud API key in the TTS/provider settings.');
      return await action({ baseUrl: resolved.context.baseUrl, apiKey });
    } finally { this.dubbingActive = false; }
  }

  async dubbingContextInfo(): Promise<{ providerName: string; baseUrl: string; hasApiKey: boolean; model?: string }> {
    try {
      const state = await this.load();
      if (!state.settings.providerId) return { providerName: '', baseUrl: 'https://dashscope.aliyuncs.com/api/v1', hasApiKey: false, model: state.settings.model };
      const resolved = await this.providers.resolve(state.settings.providerId, 'tts');
      const apiKey = state.apiKey ? (this.vault ? this.vault.decrypt(state.apiKey) : state.apiKey) : resolved.context.apiKey;
      let baseUrl = resolved.context.baseUrl;
      try {
        const u = new URL(baseUrl);
        if (u.hostname === 'dashscope.aliyuncs.com') baseUrl = 'https://dashscope.aliyuncs.com/api/v1';
        else if (u.hostname === 'dashscope-intl.aliyuncs.com') baseUrl = 'https://dashscope-intl.aliyuncs.com/api/v1';
        else if (/^[a-z0-9-]+\.(cn-beijing|ap-southeast-1)\.maas\.aliyuncs\.com$/.test(u.hostname)) baseUrl = `https://${u.hostname}/api/v1`;
        else if (!baseUrl.endsWith('/api/v1')) baseUrl = 'https://dashscope.aliyuncs.com/api/v1';
      } catch {
        baseUrl = 'https://dashscope.aliyuncs.com/api/v1';
      }
      return {
        providerName: resolved.provider.name,
        baseUrl,
        hasApiKey: !!apiKey,
        model: state.settings.model,
      };
    } catch {
      return { providerName: '', baseUrl: 'https://dashscope.aliyuncs.com/api/v1', hasApiKey: false };
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
        if (!config.providerId) throw new Error();
        const resolved = await this.providers.resolve(config.providerId, 'tts');
        controller.signal.throwIfAborted();
        let customKey = '';
        if (state.apiKey) {
          try { customKey = this.vault ? this.vault.decrypt(state.apiKey) : state.apiKey; }
          catch { throw new Error('Unable to decrypt speech credentials. Save the key again.'); }
        }
        const context = customKey ? { ...resolved.context, apiKey: customKey } : resolved.context;
        const http = resolved.adapter.tts!.build(context, {
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

        if (!response.ok || !['audio/mpeg', 'audio/mp3'].includes(mime ?? '') ||
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
    } catch {
      if (controller.signal.aborted) throw new Error(timedOut ? 'Speech generation timed out.' : 'Speech generation cancelled.');
      throw new Error('Speech generation failed. Check the saved settings, provider configuration and availability.');
    } finally {
      clearTimeout(timer);
      controller.signal.removeEventListener('abort', onAbort);
      void reader?.cancel().catch(() => {});
      if (this.active === controller) this.active = undefined;
    }
  }
}
