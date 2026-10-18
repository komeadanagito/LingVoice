import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createDefaultProviderRegistry, type ProviderService, type ResolvedProvider } from './providers';
const fallbackAsrAdapter = createDefaultProviderRegistry().get('openai-compatible').asr!;
import { defaultAsrSettings, type AsrSettings, type AsrConfig, type AsrConfigUpdate, type AsrCue, type AsrProgress, type AsrRequest } from '../shared/asr';

interface Vault { encrypt(value: string): string; decrypt(value: string): string }
interface SavedConfig { settings: AsrSettings; apiKey: string }
interface Dependencies { spawn?: typeof spawn; fetch?: typeof fetch }
const BYTES_PER_SECOND = 32000;
const CHUNK_BYTES = 300 * BYTES_PER_SECOND;
const MAX_BYTES = 21600 * BYTES_PER_SECOND;
const MAX_CUES = 100000;
const MAX_RESPONSE_BYTES = 4_000_000;
const UPLOAD_TIMEOUT = 180000;
const EXTRACTION_TIMEOUT = 30 * 60 * 1000;

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function text(value: unknown, name: string, max: number, empty = false): string {
  if (typeof value !== 'string' || value.length > max || (!empty && !value.trim()) || /[\u0000-\u001f\u007f]/.test(value)) throw new Error(`Invalid ${name}.`);
  return value;
}
function apiUrl(value: unknown): URL {
  try {
    const input = text(value, 'ASR API URL', 2048);
    const url = new URL(input);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || input.includes('#')) throw new Error();
    return url;
  } catch { throw new Error('Invalid ASR API URL: use HTTP or HTTPS without credentials or fragments.'); }
}
function settings(value: unknown): AsrSettings {
  if (!record(value) || typeof value.fullUrl !== 'boolean') throw new Error('Invalid ASR settings.');
  apiUrl(value.baseUrl);
  return {
    providerId: value.providerId === undefined ? 'legacy-asr' : text(value.providerId, 'provider ID', 200, true),
    baseUrl: (value.baseUrl as string).trim(), fullUrl: value.fullUrl,
    model: text(value.model, 'ASR model', 200).trim(),
    language: text(value.language, 'ASR language', 100, true).trim(),
    prompt: text(value.prompt, 'ASR prompt', 10000, true),
  };
}

export function asrEndpoint(config: AsrSettings): string {
  const url = apiUrl(config.baseUrl);
  if (!config.fullUrl) {
    let prefix = url.pathname.replace(/\/+$/, '');
    if (!/\/v\d+(?:beta\d*)?$/.test(prefix)) prefix += '/v1';
    url.pathname = `${prefix}/audio/transcriptions`;
  }
  return url.toString();
}

/** PCM is always signed 16-bit little-endian, mono, 16 kHz. */
export function pcmWav(pcm: Uint8Array): Uint8Array<ArrayBuffer> {
  if (!pcm.byteLength || pcm.byteLength % 2 || pcm.byteLength > CHUNK_BYTES) throw new Error('Invalid PCM audio chunk.');
  const wav = new Uint8Array(44 + pcm.byteLength);
  const header = Buffer.from(wav.buffer, 0, 44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + pcm.byteLength, 4); header.write('WAVE', 8);
  header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22); header.writeUInt32LE(16000, 24); header.writeUInt32LE(BYTES_PER_SECOND, 28);
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(pcm.byteLength, 40);
  wav.set(pcm, 44);
  return wav;
}

export function parseAsrSegments(value: unknown, duration: number, offset = 0): AsrCue[] {
  if (!Number.isFinite(duration) || duration <= 0 || !Number.isFinite(offset) || offset < 0) throw new Error('Invalid ASR chunk timing.');
  if (!record(value) || !Array.isArray(value.segments)) throw new Error('ASR provider must return timestamped segments (verbose_json); text-only responses cannot create subtitles.');
  if (value.segments.length > MAX_CUES) throw new Error('ASR provider returned too many segments.');
  const cues: AsrCue[] = [];
  for (const segment of value.segments) {
    if (!record(segment) || typeof segment.start !== 'number' || !Number.isFinite(segment.start) || segment.start < 0 ||
      typeof segment.end !== 'number' || !Number.isFinite(segment.end) || segment.end <= segment.start ||
      segment.start >= duration || segment.end > duration + 0.25 || typeof segment.text !== 'string' || segment.text.length > 100000) {
      throw new Error('ASR provider returned invalid segment timestamps or text.');
    }
    if (!segment.text.trim()) continue;
    cues.push({ id: 0, start: offset + segment.start, end: offset + Math.min(duration, segment.end), text: segment.text.trim() });
  }
  return cues.sort((a, b) => a.start - b.start || a.end - b.end).map((cue, index) => ({ ...cue, id: index + 1 }));
}

export class AsrService {
  private state?: SavedConfig;
  private loading?: Promise<SavedConfig>;
  private pending: Promise<void> = Promise.resolve();
  private run?: AbortController;

  constructor(private readonly file: string, private readonly vault: Vault, private readonly ffmpegPath: string,
    private readonly emit: (progress: AsrProgress) => void, private readonly dependencies: Dependencies = {},
    private readonly providers?: ProviderService) {}

  get busy(): boolean { return !!this.run; }
  cancel(): void { this.run?.abort(); }

  private async load(): Promise<SavedConfig> {
    if (this.state) return this.state;
    if (!this.loading) this.loading = (async () => {
      let raw: string;
      try { raw = await fs.readFile(this.file, 'utf8'); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Unable to read ASR configuration.');
        return this.state = { settings: { ...defaultAsrSettings }, apiKey: '' };
      }
      try {
        const value: unknown = JSON.parse(raw);
        if (!record(value) || typeof value.apiKey !== 'string') throw new Error();
        return this.state = { settings: settings(value.settings), apiKey: value.apiKey };
      } catch { throw new Error('Invalid saved ASR configuration.'); }
    })().catch(error => { this.loading = undefined; throw error; });
    return this.loading;
  }
  private publicConfig(state: SavedConfig): AsrConfig { return { settings: { ...state.settings }, hasApiKey: !!state.apiKey }; }
  async getConfig(): Promise<AsrConfig> { await this.pending; return this.publicConfig(await this.load()); }
  async saveConfig(update: AsrConfigUpdate): Promise<AsrConfig> {
    if (!record(update)) throw new Error('Invalid ASR configuration.');
    const validated = settings(update.settings);
    if (this.providers) {
      if (Object.hasOwn(update, 'apiKey')) throw new Error('Manage credentials in Providers.');
      if (validated.providerId) await this.providers.resolve(validated.providerId, 'asr');
    }
    const key = Object.hasOwn(update, 'apiKey') ? text(update.apiKey, 'ASR API key', 8192, true) : undefined;
    const operation = this.pending.then(async () => {
      const current = await this.load();
      let encrypted = current.apiKey;
      try { if (key !== undefined) encrypted = key ? this.vault.encrypt(key) : ''; }
      catch { throw new Error('Unable to securely store ASR credentials.'); }
      const next = { settings: validated, apiKey: encrypted };
      const temporary = `${this.file}.${randomUUID()}.tmp`;
      try {
        await fs.mkdir(path.dirname(this.file), { recursive: true });
        await fs.writeFile(temporary, JSON.stringify(next), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
        await fs.rename(temporary, this.file);
      } catch {
        await fs.rm(temporary, { force: true }).catch(() => {});
        throw new Error('Unable to save ASR configuration.');
      }
      this.state = next;
      return this.publicConfig(next);
    });
    this.pending = operation.then(() => {}, () => {});
    return operation;
  }
  private check(signal: AbortSignal): void { if (signal.aborted) throw new Error('ASR cancelled.'); }
  private progress(value: AsrProgress): void { try { this.emit(value); } catch { /* A disconnected observer must not interrupt cleanup. */ } }

  private async extract(file: string, output: string, signal: AbortSignal): Promise<void> {
    this.check(signal);
    await new Promise<void>((resolve, reject) => {
      let child: ReturnType<typeof spawn>;
      try {
        child = (this.dependencies.spawn ?? spawn)(this.ffmpegPath, [
          '-nostdin', '-hide_banner', '-loglevel', 'error', '-protocol_whitelist', 'file,pipe', '-i', file,
          '-t', '21601', '-map', '0:a:0', '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-f', 's16le', '-y', output,
        ], { shell: false, windowsHide: true, stdio: 'ignore' });
      } catch { reject(new Error('Unable to start FFmpeg audio extraction.')); return; }
      let timedOut = false;
      const abort = () => { child.kill('SIGKILL'); };
      const timer = setTimeout(() => { timedOut = true; abort(); }, EXTRACTION_TIMEOUT);
      const finish = (ok: boolean) => {
        clearTimeout(timer); signal.removeEventListener('abort', abort);
        if (signal.aborted) reject(new Error('ASR cancelled.'));
        else if (timedOut) reject(new Error('FFmpeg audio extraction timed out.'));
        else if (!ok) reject(new Error('FFmpeg audio extraction failed. Verify that the local media contains a supported audio track.'));
        else resolve();
      };
      child.once('error', () => finish(false));
      child.once('close', code => finish(code === 0));
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    });
  }

  private async upload(config: AsrSettings, key: string, pcm: Uint8Array, signal: AbortSignal, provider?: ResolvedProvider): Promise<unknown> {
    this.check(signal);
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener('abort', abort, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, UPLOAD_TIMEOUT);
    try {
      const adapter = provider?.adapter.asr ?? fallbackAsrAdapter;
      const request = adapter.build(provider?.context ?? { baseUrl: config.baseUrl, apiKey: key }, { ...config, wav: pcmWav(pcm) });
      const response = await (this.dependencies.fetch ?? fetch)(request.url, {
        ...request.init, signal: controller.signal, redirect: 'error',
      });
      if (!response.ok || Number(response.headers.get('content-length')) > MAX_RESPONSE_BYTES) { await response.body?.cancel(); throw new Error(); }
      const reader = response.body?.getReader();
      if (!reader) throw new Error();
      const decoder = new TextDecoder();
      let body = ''; let bytes = 0;
      try {
        while (true) {
          this.check(signal);
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > MAX_RESPONSE_BYTES) { await reader.cancel(); throw new Error(); }
          body += decoder.decode(chunk.value, { stream: true });
        }
        body += decoder.decode();
      } finally { reader.releaseLock(); }
      this.check(signal);
      return JSON.parse(body) as unknown;
    } catch {
      controller.abort();
      if (signal.aborted) throw new Error('ASR cancelled.');
      if (timedOut) throw new Error('ASR upload timed out.');
      throw new Error('ASR provider request failed. Check the URL, credentials, model and provider availability.');
    } finally { clearTimeout(timer); signal.removeEventListener('abort', abort); }
  }

  async transcribe(request: AsrRequest): Promise<AsrCue[]> {
    if (this.run) throw new Error('ASR is already busy.');
    const run = new AbortController(); this.run = run;
    let temporary: string | undefined;
    try {
      if (!record(request) || Object.keys(request).some(key => key !== 'file') || typeof request.file !== 'string' ||
        !path.isAbsolute(request.file) || /[\u0000-\u001f\u007f]/.test(request.file) || /^(?:[a-z][a-z\d+.-]*:\/\/|\\\\|\/\/)/i.test(request.file) ||
        (process.platform === 'win32' && request.file.slice(2).includes(':'))) {
        throw new Error('Choose an absolute local media file path, not a URL or network path.');
      }
      const file = path.resolve(request.file);
      let regular = false;
      try { regular = (await fs.stat(file)).isFile(); } catch { /* Report a safe, consistent validation error. */ }
      if (!regular) throw new Error('The local media path must be an existing regular file.');
      await this.pending;
      const state = await this.load();
      const provider = this.providers ? await this.providers.resolve(state.settings.providerId || '', 'asr') : undefined;
      let key = '';
      try { if (!provider && state.apiKey) key = text(this.vault.decrypt(state.apiKey), 'ASR credential', 8192); }
      catch { throw new Error('Unable to decrypt ASR credentials. Save the key again.'); }
      this.check(run.signal);
      temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'lingvoice-asr-'));
      const raw = path.join(temporary, 'audio.pcm');
      this.progress({ stage: 'extracting', completed: 0, total: 1 });
      await this.extract(file, raw, run.signal);
      this.check(run.signal);
      const size = (await fs.stat(raw)).size;
      if (size > MAX_BYTES) throw new Error('Media exceeds the six-hour ASR duration limit.');
      if (!size) throw new Error('No speech found: the extracted audio is empty.');
      if (size % 2) throw new Error('FFmpeg returned invalid PCM audio.');
      this.progress({ stage: 'extracting', completed: 1, total: 1 });
      const total = Math.ceil(size / CHUNK_BYTES);
      const cues: AsrCue[] = [];
      this.progress({ stage: 'transcribing', completed: 0, total });
      const handle = await fs.open(raw, 'r');
      try {
        for (let offset = 0; offset < size; offset += CHUNK_BYTES) {
          this.check(run.signal);
          const length = Math.min(CHUNK_BYTES, size - offset);
          const pcm = Buffer.alloc(length);
          let read = 0;
          while (read < length) {
            const result = await handle.read(pcm, read, length - read, offset + read);
            if (!result.bytesRead) throw new Error('Unable to read extracted audio.');
            read += result.bytesRead;
          }
          const response = await this.upload(state.settings, key, pcm, run.signal, provider);
          this.check(run.signal);
          const segments = parseAsrSegments(provider ? provider.adapter.asr!.parse(response) : response, length / BYTES_PER_SECOND, offset / BYTES_PER_SECOND);
          if (cues.length + segments.length > MAX_CUES) throw new Error('ASR result exceeds the subtitle count limit.');
          for (const cue of segments) cues.push(cue);
          this.progress({ stage: 'transcribing', completed: Math.floor(offset / CHUNK_BYTES) + 1, total });
        }
      } finally { await handle.close(); }
      this.check(run.signal);
      if (!cues.length) throw new Error('No speech found in the selected media.');
      return cues.sort((a, b) => a.start - b.start || a.end - b.end).map((cue, index) => ({ ...cue, id: index + 1 }));
    } finally {
      try { if (temporary) await fs.rm(temporary, { recursive: true, force: true }); }
      finally { this.run = undefined; }
    }
  }
}
