import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createDefaultProviderRegistry, type ProviderService } from './providers';
const legacyAdapters = createDefaultProviderRegistry();
import {
  defaultTranslationSettings,
  type TranslationSettings, type TranslationConfig,
  type TranslationConfigUpdate, type TranslationRequest,
} from '../shared/translation';

interface Vault { encrypt(value: string): string; decrypt(value: string): string }
interface SavedConfig { settings: TranslationSettings; apiKey: string; machineKey: string }
const TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 2_000_000;

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function text(value: unknown, name: string, max: number, allowEmpty = false): string {
  if (typeof value !== 'string' || value.length > max || (!allowEmpty && !value.trim()) || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`Invalid ${name}.`);
  }
  return value;
}

function url(value: unknown, name: string): URL {
  const input = text(value, name, 2048);
  try {
    const parsed = new URL(input);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.hash || input.includes('#')) throw new Error();
    return parsed;
  } catch { throw new Error(`Invalid ${name}: use an HTTP or HTTPS URL without credentials or fragments.`); }
}

function settings(value: unknown): TranslationSettings {
  if (!record(value) || !['llm', 'machine'].includes(value.engine as string) || typeof value.fullUrl !== 'boolean') {
    throw new Error('Invalid translation settings.');
  }
  url(value.baseUrl, 'API URL');
  url(value.machineUrl, 'machine translation URL');
  return {
    providerId: value.providerId === undefined ? (value.engine === 'machine' ? 'legacy-translation-machine' : 'legacy-translation-llm') : text(value.providerId, 'provider ID', 200, true),
    engine: value.engine as TranslationSettings['engine'],
    protocol: text(value.protocol, 'translation protocol', 100),
    baseUrl: (value.baseUrl as string).trim(), fullUrl: value.fullUrl,
    model: text(value.model, 'model', 200, true).trim(),
    displayName: text(value.displayName, 'display name', 200, true).trim(),
    machineUrl: (value.machineUrl as string).trim(),
    sourceLanguage: text(value.sourceLanguage, 'source language', 100).trim(),
    targetLanguage: text(value.targetLanguage, 'target language', 100).trim(),
  };
}

/** Owns settings and encrypted secrets; callers can only observe secret presence. */
export class TranslationService {
  private state?: SavedConfig;
  private loading?: Promise<SavedConfig>;
  private pending: Promise<void> = Promise.resolve();

  constructor(private readonly file: string, private readonly vault: Vault, private readonly providers?: ProviderService) {}

  private async load(): Promise<SavedConfig> {
    if (this.state) return this.state;
    if (!this.loading) this.loading = (async () => {
      let raw: string;
      try { raw = await fs.readFile(this.file, 'utf8'); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Unable to read translation configuration.');
        return this.state = { settings: { ...defaultTranslationSettings }, apiKey: '', machineKey: '' };
      }
      try {
        const value: unknown = JSON.parse(raw);
        if (!record(value) || typeof value.apiKey !== 'string' || typeof value.machineKey !== 'string') throw new Error();
        return this.state = { settings: settings(value.settings), apiKey: value.apiKey, machineKey: value.machineKey };
      } catch { throw new Error('Invalid saved translation configuration.'); }
    })().catch(error => { this.loading = undefined; throw error; });
    return this.loading;
  }

  private publicConfig(state: SavedConfig): TranslationConfig {
    return { settings: { ...state.settings }, hasApiKey: !!state.apiKey, hasMachineKey: !!state.machineKey };
  }

  async getConfig(): Promise<TranslationConfig> {
    await this.pending;
    return this.publicConfig(await this.load());
  }

  async saveConfig(update: TranslationConfigUpdate): Promise<TranslationConfig> {
    if (!record(update)) throw new Error('Invalid translation configuration.');
    const validated = settings(update.settings);
    if (this.providers) {
      if (Object.hasOwn(update, 'apiKey') || Object.hasOwn(update, 'machineKey')) throw new Error('Manage credentials in Providers.');
      if (validated.providerId) {
        const resolved = await this.providers.resolve(validated.providerId, 'translation');
        const protocols = resolved.adapter.info.translationOptions?.protocols;
        if (protocols?.length && !protocols.includes(validated.protocol)) throw new Error('Unsupported translation protocol for this provider.');
      }
    } else if (!['chat', 'responses'].includes(validated.protocol)) throw new Error('Invalid translation protocol.');
    const keys: { apiKey?: string; machineKey?: string } = {};
    for (const name of ['apiKey', 'machineKey'] as const) {
      if (Object.hasOwn(update, name)) keys[name] = text(update[name], name, 8192, true);
    }
    const operation = this.pending.then(async () => {
      const current = await this.load();
      const next: SavedConfig = { ...current, settings: validated };
      try {
        for (const name of ['apiKey', 'machineKey'] as const) {
          if (keys[name] !== undefined) next[name] = keys[name] ? this.vault.encrypt(keys[name]!) : '';
        }
      } catch { throw new Error('Unable to securely store translation credentials.'); }
      const temporary = `${this.file}.${randomUUID()}.tmp`;
      try {
        await fs.mkdir(path.dirname(this.file), { recursive: true });
        await fs.writeFile(temporary, JSON.stringify(next), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
        await fs.rename(temporary, this.file);
      } catch {
        await fs.rm(temporary, { force: true }).catch(() => {});
        throw new Error('Unable to save translation configuration.');
      }
      this.state = next;
      return this.publicConfig(next);
    });
    this.pending = operation.then(() => {}, () => {});
    return operation;
  }

  private secret(value: string): string {
    if (!value) return '';
    try { return text(this.vault.decrypt(value), 'credential', 8192); }
    catch { throw new Error('Unable to decrypt translation credentials. Save the key again.'); }
  }

  private async request(address: string, init: RequestInit): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const response = await fetch(address, { ...init, signal: controller.signal, redirect: 'error' });
      if (!response.ok) throw new Error();
      const declared = Number(response.headers.get('content-length'));
      if (declared > MAX_RESPONSE_BYTES) throw new Error();
      // Bound actual streamed bytes too, even if content-length is absent or dishonest.
      const reader = response.body?.getReader();
      if (!reader) throw new Error();
      const decoder = new TextDecoder();
      let body = '';
      let bytes = 0;
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > MAX_RESPONSE_BYTES) { await reader.cancel(); throw new Error(); }
        body += decoder.decode(chunk.value, { stream: true });
      }
      body += decoder.decode();
      return JSON.parse(body) as unknown;
    } catch {
      throw new Error(controller.signal.aborted ? 'Translation request timed out.' : 'Translation provider request failed. Check the URL, credentials and provider availability.');
    } finally { clearTimeout(timer); }
  }

  async models(): Promise<string[]> {
    await this.pending;
    const state = await this.load();
    if (this.providers) {
      const resolved = await this.providers.resolve(state.settings.providerId || '', 'models');
      const adapter = resolved.adapter.models!;
      const request = adapter.build(resolved.context);
      return adapter.parse(await this.request(request.url, request.init));
    }
    const adapter = legacyAdapters.get('openai-compatible').models!;
    const request = adapter.build({ baseUrl: state.settings.baseUrl, apiKey: this.secret(state.apiKey) });
    return adapter.parse(await this.request(request.url, request.init));
  }

  async translate(request: TranslationRequest): Promise<string[]> {
    if (!record(request) || Object.keys(request).some(key => key !== 'texts') || !Array.isArray(request.texts) || !request.texts.length || request.texts.length > 40) {
      throw new Error('Provide between 1 and 40 texts, without settings overrides.');
    }
    let length = 0;
    const texts: string[] = [];
    for (const item of request.texts) {
      if (typeof item !== 'string' || !item.trim()) throw new Error('Translation texts must be nonempty strings.');
      length += item.length;
      if (length > 20000) throw new Error('Translation text exceeds the 20000 character limit.');
      texts.push(item);
    }
    await this.pending;
    const state = await this.load();
    const config = state.settings;
    if (this.providers) {
      const resolved = await this.providers.resolve(config.providerId || '', 'translation');
      const adapter = resolved.adapter.translation!;
      const request = adapter.build(resolved.context, { ...config, texts });
      return adapter.parse(await this.request(request.url, request.init), texts.length);
    }
    // Compatibility for legacy configurations and standalone service callers.
    // Provider-managed application runs never select implementations here.
    const machine = config.engine === 'machine';
    const adapter = legacyAdapters.get(machine ? 'libretranslate' : 'openai-compatible').translation!;
    const http = adapter.build({ baseUrl: machine ? config.machineUrl : config.baseUrl, apiKey: this.secret(machine ? state.machineKey : state.apiKey) }, { ...config, texts, fullUrl: machine ? false : config.fullUrl });
    return adapter.parse(await this.request(http.url, http.init), texts.length);
  }
}
