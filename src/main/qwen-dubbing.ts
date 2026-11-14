import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import * as https from 'node:https';
import { Readable } from 'node:stream';

/** Cloned voices are bound to a specific model and must not be mixed across models. */
export const SUPPORTED_QWEN_DUBBING_MODELS = ['qwen-audio-3.1-tts-plus', 'qwen-audio-3.0-tts-plus', 'doubao-seed-tts-2.0'] as const;
export type QwenDubbingModel = (typeof SUPPORTED_QWEN_DUBBING_MODELS)[number];
export const QWEN_DUBBING_MODEL: QwenDubbingModel = 'qwen-audio-3.1-tts-plus';
const REFERENCE_LIMIT = 10 * 1024 * 1024;
const AUDIO_LIMIT = 32 * 1024 * 1024;
const JSON_LIMIT = 64 * 1024;
const CUSTOMIZATION = '/services/audio/tts/customization';
export interface QwenDubbingCredentials { baseUrl: string; apiKey: string; model?: QwenDubbingModel }
export interface QwenDubbingOptions {
  fetch?: typeof globalThis.fetch;
  /** Injectable for offline tests. Production must resolve real DNS addresses. */
  resolveHost?: (hostname: string) => Promise<readonly string[]>;
  timeoutMs?: number;
  pollIntervalMs?: number;
  /** Explicit backend-only diagnostics: receives a copy of bounded audio before validation. No URLs or credentials. */
  inspectAudio?: (audio: Uint8Array) => void | Promise<void>;
}
export interface QwenVoice {
  voiceId: string;
  model: QwenDubbingModel;
  status: 'OK' | 'DEPLOYING' | 'UNDEPLOYED';
}
export interface QwenDubbingAudio {
  outputFile: string;
  bytes: number;
  sampleRate: 24000;
  durationSeconds: number;
}
const STAGES = {
  reference: '读取参考音频 / reference audio',
  referenceValidation: '校验参考音频 / reference validation',
  enrollment: '创建复刻音色 / voice enrollment',
  registry: '保存音色记录 / voice registry',
  query: '查询音色状态 / voice query',
  readiness: '检查音色就绪状态 / voice readiness',
  deletion: '删除音色 / voice deletion',
  synthesis: '合成配音 / speech synthesis',
  downloadAddress: '校验音频下载地址 / audio download URL',
  download: '下载配音音频 / audio download',
  validation: '校验配音音频 / audio validation',
  output: '保存配音音频 / audio output',
} as const;
type SpeechStage = keyof typeof STAGES;
interface Operation { signal: AbortSignal; wait<T>(promise: Promise<T>): Promise<T>; stage: SpeechStage }
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function safeUrl(value: string): URL {
  if (typeof value !== 'string' || value.length > 8192 || /[\s\\\u0000-\u001f\u007f]/.test(value)) throw new SpeechError('Unsafe URL.');
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || value.includes('#') || url.port) throw new SpeechError('Unsafe URL.');
  return url;
}
function endpoint(value: string): { base: string; region: 'cn-beijing' | 'ap-southeast-1' } {
  const url = safeUrl(value);
  if (url.search || !/^\/(?:api\/v1|compatible-mode\/v1(?:\/chat\/completions)?)\/?$/.test(url.pathname)) throw new SpeechError('Use an official /api/v1 or /compatible-mode/v1 endpoint.');
  const workspace = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.(cn-beijing|ap-southeast-1)\.maas\.aliyuncs\.com$/.exec(url.hostname);
  const region = workspace?.[1] ?? (url.hostname === 'dashscope.aliyuncs.com' ? 'cn-beijing' : url.hostname === 'dashscope-intl.aliyuncs.com' ? 'ap-southeast-1' : undefined);
  if (region !== 'cn-beijing' && region !== 'ap-southeast-1') throw new SpeechError('Untrusted speech endpoint.');
  return { base: `${url.origin}/api/v1`, region };
}
/** Offline validation and same-origin conversion to the native speech API. */
export function normalizeQwenDubbingBaseUrl(value: string): string { return endpoint(value).base; }

/** Only locally constructed, fixed diagnostic text may cross the operation boundary. */
class SpeechError extends Error {}
const PROVIDER_CODES = new Set([
  'InvalidApiKey', 'InvalidParameter', 'InvalidParameterValue', 'MissingParameter',
  'AccessDenied', 'Forbidden', 'Unauthorized', 'ModelNotFound', 'InvalidModel',
  'ResourceNotFound', 'VoiceNotFound', 'QuotaExceeded', 'Throttling', 'Throttling.RateQuota',
  'Throttling.AllocationQuota', 'InternalError', 'ServiceUnavailable', 'BadRequest',
  'InvalidInput', 'UnsupportedOperation', 'OperationDenied',
]);
function providerCode(data: unknown): string | undefined {
  if (!object(data)) return undefined;
  const code = data.code ?? (object(data.error) ? data.error.code : undefined);
  return typeof code === 'string' && PROVIDER_CODES.has(code) ? code : undefined;
}
function parseOutput(raw: Buffer): Record<string, unknown> {
  let data: unknown;
  try { data = JSON.parse(raw.toString('utf8')); }
  catch { throw new SpeechError('The speech service returned malformed JSON.'); }
  const code = providerCode(data);
  if (code) throw new SpeechError(`The speech service rejected the request (${code}).`);
  if (!object(data) || data.code || data.error || !object(data.output)) throw new SpeechError('The speech service returned invalid JSON output.');
  return data.output;
}
function downloadUrl(value: string): URL {
  // Official synthesis responses may advertise http:// OSS URLs. Validate the
  // authority first, then upgrade the same signed path/query to HTTPS; never
  // send the signed URL or a request over plaintext HTTP.
  if (typeof value !== 'string' || value.length > 8192 || /[\s\\\u0000-\u001f\u007f]/.test(value)) throw new SpeechError('Invalid audio download URL.');
  let url: URL;
  try { url = new URL(value); }
  catch { throw new SpeechError('Invalid audio download URL.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash || value.includes('#') || url.port) throw new SpeechError('Unsafe audio download URL.');
  // Public bucket endpoints only, not arbitrary *.aliyuncs.com, internal OSS, IPs, or custom CNAMEs.
  if (!/^[a-z0-9][a-z0-9-]{1,62}\.oss-(?:cn-beijing|ap-southeast-1)\.aliyuncs\.com$/.test(url.hostname)) {
    throw new SpeechError('Untrusted audio download host.');
  }
  url.protocol = 'https:';
  return safeUrl(url.href);
}
const blocked = new BlockList();
for (const [ip, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) blocked.addSubnet(ip, prefix, 'ipv4');
blocked.addSubnet('2001:db8::', 32, 'ipv6');
blocked.addSubnet('2001::', 23, 'ipv6');
blocked.addSubnet('2002::', 16, 'ipv6');
blocked.addSubnet('3fff::', 20, 'ipv6');
blocked.addSubnet('192.88.99.0', 24, 'ipv4');
function publicAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return !blocked.check(ip, 'ipv4');
  // Excludes loopback, mapped IPv4, link-local, unique-local, multicast and unspecified addresses.
  return family === 6 && /^[23][0-9a-f]{3}:/i.test(ip) && !blocked.check(ip, 'ipv6');
}
function voiceId(value: unknown, expectedModel?: QwenDubbingModel): string {
  if (typeof value !== 'string' || value.length > 256 || !/^[a-zA-Z0-9._-]+$/.test(value)) throw new SpeechError('Invalid voice identifier.');
  const models = expectedModel ? [expectedModel] : SUPPORTED_QWEN_DUBBING_MODELS;
  const match = models.find(m => value.startsWith(`${m}-`) && value.length > m.length + 1);
  if (!match) throw new SpeechError('Voice must belong to a supported dubbing model.');
  return value;
}
/** Validates RIFF boundaries and PCM metadata, rather than trusting MIME or file extensions. */
function wav(buffer: Buffer, reference: boolean): { sampleRate: number; durationSeconds: number } {
  if (buffer.length < 44 || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE' ||
      buffer.readUInt32LE(4) + 8 !== buffer.length) throw new SpeechError('Invalid PCM WAV.');
  let format: { rate: number; align: number } | undefined;
  let dataBytes: number | undefined;
  let offset = 12;
  while (offset < buffer.length) {
    if (offset + 8 > buffer.length) throw new SpeechError('Invalid WAV chunk.');
    const name = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const start = offset + 8;
    const end = start + size;
    if (end + (size % 2) > buffer.length) throw new SpeechError('Invalid WAV size.');
    if (name === 'fmt ') {
      if (format || size < 16 || buffer.readUInt16LE(start) !== 1) throw new SpeechError('Expected 16-bit PCM WAV.');
      const channels = buffer.readUInt16LE(start + 2);
      const rate = buffer.readUInt32LE(start + 4);
      const byteRate = buffer.readUInt32LE(start + 8);
      const align = buffer.readUInt16LE(start + 12);
      const bits = buffer.readUInt16LE(start + 14);
      if (![1, 2].includes(channels) || bits !== 16 || align !== channels * 2 || byteRate !== rate * align ||
          rate < 16000 || rate > 192000 || (!reference && rate !== 24000)) throw new SpeechError('Unsupported WAV format.');
      format = { rate, align };
    } else if (name === 'data') {
      if (dataBytes !== undefined) throw new SpeechError('Duplicate WAV data.');
      dataBytes = size;
    }
    offset = end + (size % 2);
  }
  if (!format || !dataBytes || dataBytes % format.align) throw new SpeechError('Missing WAV audio.');
  const durationSeconds = dataBytes / (format.rate * format.align);
  if (reference && (durationSeconds < 5 || durationSeconds > 60)) throw new SpeechError('Reference WAV must be 5–60 seconds.');
  return { sampleRate: format.rate, durationSeconds };
}

/** Independent, credential-injected client; importing/constructing it performs no I/O. */
export class QwenDubbingClient {
  readonly region: 'cn-beijing' | 'ap-southeast-1';
  readonly model: QwenDubbingModel;
  private readonly base: string;
  private readonly key: string;
  private readonly fetcher: typeof globalThis.fetch | undefined;
  private readonly resolveHost: NonNullable<QwenDubbingOptions['resolveHost']>;
  private readonly timeoutMs: number;
  private readonly pollMs: number;
  private readonly inspectAudio?: QwenDubbingOptions['inspectAudio'];

  constructor(credentials: QwenDubbingCredentials, options: QwenDubbingOptions = {}) {
    const target = endpoint(credentials.baseUrl);
    if (typeof credentials.apiKey !== 'string' || !credentials.apiKey.trim() || credentials.apiKey.length > 4096 || /[\s\u0000-\u001f\u007f]/.test(credentials.apiKey)) throw new SpeechError('Invalid speech credentials.');
    const selectedModel = credentials.model ?? QWEN_DUBBING_MODEL;
    if (!SUPPORTED_QWEN_DUBBING_MODELS.includes(selectedModel)) throw new SpeechError('Unsupported dubbing model.');
    this.model = selectedModel;
    this.base = target.base;
    this.region = target.region;
    this.key = credentials.apiKey;
    this.fetcher = options.fetch;
    this.resolveHost = options.resolveHost ?? (async host => (await lookup(host, { all: true })).map(entry => entry.address));
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.pollMs = options.pollIntervalMs ?? 1000;
    this.inspectAudio = options.inspectAudio;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 300_000 ||
        !Number.isInteger(this.pollMs) || this.pollMs < 1 || this.pollMs > 10_000) throw new SpeechError('Invalid timeout or polling interval.');
  }

  private async operation<T>(stage: SpeechStage, signal: AbortSignal | undefined, action: (operation: Operation) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    let timedOut = false;
    const abort = () => controller.abort();
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, this.timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) controller.abort();
    const wait = <U>(promise: Promise<U>): Promise<U> => new Promise((resolve, reject) => {
      const cancel = () => {
        controller.signal.removeEventListener('abort', cancel);
        reject(new Error('Cancelled.'));
      };
      controller.signal.addEventListener('abort', cancel, { once: true });
      if (controller.signal.aborted) cancel();
      promise.then(value => {
        controller.signal.removeEventListener('abort', cancel);
        if (controller.signal.aborted) reject(new Error('Cancelled.')); else resolve(value);
      }, error => { controller.signal.removeEventListener('abort', cancel); reject(error); });
    });
    const op: Operation = { signal: controller.signal, wait, stage };
    try {
      controller.signal.throwIfAborted();
      return await wait(action(op));
    } catch (error) {
      // Never include remote messages, signed URLs, filesystem paths or API keys in errors.
      let detail = error instanceof SpeechError ? error.message : 'Unexpected transport or processing failure; raw details are hidden for credential safety.';
      const networkCodes = ['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'ERR_TLS_CERT_ALTNAME_INVALID'];
      const fileCodes: Record<string, string> = {
        ENOSPC: '磁盘空间不足 / Disk space exhausted.',
        EACCES: '文件访问权限不足 / File permission denied.',
        EPERM: '文件操作被拒绝 / File operation not permitted.',
        ENOENT: '参考文件或输出目录不存在 / Reference file or output directory is missing.',
        EROFS: '输出文件系统为只读 / Read-only filesystem.',
        EMFILE: '打开的文件过多 / Too many open files.',
      };
      let cause: unknown = error;
      for (let depth = 0; !(error instanceof SpeechError) && depth < 5 && object(cause); depth++) {
        if (typeof cause.code === 'string') {
          if (networkCodes.includes(cause.code)) { detail = `Network or TLS connection failed (${cause.code}).`; break; }
          if (Object.hasOwn(fileCodes, cause.code)) { detail = `${fileCodes[cause.code]} (${cause.code})`; break; }
        }
        cause = cause.cause;
      }
      // Even fixed diagnostics must not disclose a coincidentally matching credential.
      detail = `[${STAGES[op.stage]}] ${detail}`.split(this.key).join('[redacted]');
      throw new Error(controller.signal.aborted ? (timedOut ? 'Qwen dubbing timed out.' : 'Qwen dubbing cancelled.') : `Qwen dubbing failed: ${detail}`);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  }

  /** Native transport pins validated DNS results while preserving TLS hostname verification.
   * Injected fetch implementations are trusted dependencies and must preserve equivalent policy.
   */
  private pinnedFetch(url: URL, init: RequestInit, addresses: readonly string[], op: Operation): Promise<Response> {
    return new Promise((resolve, reject) => {
      const request = https.request(url, {
        method: init.method,
        headers: Object.fromEntries(new Headers(init.headers).entries()),
        signal: op.signal,
        // A fresh connection prevents pooled sockets or a second DNS resolution bypassing the check.
        agent: false,
        lookup: (_host, options, callback) => {
          if (options.all) callback(null, addresses.map(address => ({ address, family: isIP(address) })));
          else callback(null, addresses[0], isIP(addresses[0]));
        },
      }, response => {
        const status = response.statusCode ?? 500;
        if (op.signal.aborted) {
          response.destroy();
          reject(new Error('Cancelled.'));
          return;
        }
        const headers = new Headers();
        for (const [name, value] of Object.entries(response.headers)) {
          if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value);
        }
        try {
          const body = status === 204 || status === 205 ? null : Readable.toWeb(response) as ReadableStream<Uint8Array>;
          if (body === null) response.resume();
          resolve(new Response(body, { status, headers }));
        } catch (error) { response.destroy(); reject(error); }
      });
      request.on('error', reject);
      if (typeof init.body === 'string') request.end(init.body); else request.end();
    });
  }

  private async request(url: URL, init: RequestInit, op: Operation): Promise<Response> {
    op.signal.throwIfAborted();
    const addresses = await op.wait(this.resolveHost(url.hostname));
    if (!addresses.length || !addresses.every(publicAddress)) throw new SpeechError('Non-public network target.');
    op.signal.throwIfAborted();
    const pending = this.fetcher
      ? this.fetcher(url.href, { ...init, redirect: 'error', signal: op.signal })
      : this.pinnedFetch(url, init, addresses, op);
    // Dispose late responses even when a mock or transport ignores AbortSignal.
    void pending.then(response => { if (op.signal.aborted) void response.body?.cancel().catch(() => {}); }, () => {});
    const response = await op.wait(pending);
    if (response.redirected || (response.url && response.url !== url.href)) {
      void response.body?.cancel().catch(() => {});
      throw new SpeechError('Unexpected redirect from the speech service.');
    }
    if (!response.ok) {
      let code: string | undefined;
      try { code = providerCode(JSON.parse((await this.read(response, JSON_LIMIT, op)).toString('utf8'))); }
      catch { /* An HTTP status remains useful even when the bounded error body is invalid. */ }
      const enrollment = url.pathname.endsWith(CUSTOMIZATION);
      const hint = enrollment && (response.status === 403 || response.status === 404)
        ? (url.hostname === 'token-plan.cn-beijing.maas.aliyuncs.com'
          ? ' Token Plan voice enrollment may be unavailable or not permitted for this account.'
          : ' Voice enrollment may be unavailable or not permitted for this account.')
        : response.status === 401 ? ' Check the speech API credential for this endpoint.'
        : response.status === 429 ? ' Speech quota or rate limit reached.' : '';
      throw new SpeechError(`Speech ${enrollment ? 'voice enrollment' : init.method === 'GET' ? 'audio download' : 'synthesis'} returned HTTP ${response.status}${code ? ` (${code})` : ''}.${hint}`);
    }
    return response;
  }

  private async read(response: Response, max: number, op: Operation): Promise<Buffer> {
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const cancel = () => { void reader?.cancel().catch(() => {}); };
    try {
      const length = response.headers.get('content-length');
      if (length !== null && (!/^\d+$/.test(length) || Number(length) > max)) throw new SpeechError('Speech response exceeds the size limit.');
      reader = response.body?.getReader();
      if (!reader) throw new SpeechError('The speech service returned an empty response.');
      op.signal.addEventListener('abort', cancel, { once: true });
      const chunks: Buffer[] = [];
      let bytes = 0;
      while (true) {
        const chunk = await op.wait(reader.read());
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > max) throw new SpeechError('Speech response exceeds the size limit.');
        chunks.push(Buffer.from(chunk.value));
      }
      if (!bytes) throw new SpeechError('The speech service returned an empty response.');
      return Buffer.concat(chunks, bytes);
    } finally {
      op.signal.removeEventListener('abort', cancel);
      if (reader) { void reader.cancel().catch(() => {}); }
      else { void response.body?.cancel().catch(() => {}); }
    }
  }

  private async post(suffix: string, body: unknown, op: Operation): Promise<Record<string, unknown>> {
    const response = await this.request(new URL(this.base + suffix), {
      method: 'POST', headers: { Authorization: `Bearer ${this.key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }, op);
    return parseOutput(await this.read(response, JSON_LIMIT, op));
  }

  private async query(id: string, op: Operation): Promise<QwenVoice> {
    op.stage = 'query';
    const output = await this.post(CUSTOMIZATION, { model: 'voice-enrollment', input: { action: 'query_voice', voice_id: id } }, op);
    const targetModel = output.target_model !== undefined ? String(output.target_model) : this.model;
    if (targetModel !== this.model) throw new SpeechError('音色绑定模型与所选模型不一致，请重新创建音色。 / Voice model mismatch; recreate the voice for the selected model.');
    if (typeof output.status !== 'string' || !['OK', 'DEPLOYING', 'UNDEPLOYED'].includes(output.status)) throw new SpeechError('音色查询返回缺失或未知的状态。 / Voice query returned a missing or unsupported status.');
    return { voiceId: id, model: targetModel as QwenDubbingModel, status: output.status as QwenVoice['status'] };
  }

  queryVoice(id: string, signal?: AbortSignal): Promise<QwenVoice> {
    return this.operation('query', signal, op => this.query(voiceId(id, this.model), op));
  }

  deleteVoice(id: string, signal?: AbortSignal): Promise<{ voiceId: string; deleted: true }> {
    return this.operation('deletion', signal, async op => {
      const validated = voiceId(id, this.model);
      await this.query(validated, op); // Reject a server-reported model mismatch before deletion.
      op.stage = 'deletion';
      await this.post(CUSTOMIZATION, { model: 'voice-enrollment', input: { action: 'delete_voice', voice_id: validated } }, op);
      return { voiceId: validated, deleted: true };
    });
  }

  createVoice(reference: string | Buffer, signal?: AbortSignal, onCreated?: (voice: QwenVoice) => Promise<void>): Promise<QwenVoice> {
    return this.operation('reference', signal, async op => {
      let audio: Buffer;
      if (Buffer.isBuffer(reference)) {
        if (reference.length > REFERENCE_LIMIT) throw new SpeechError('Reference too large.');
        audio = Buffer.from(reference);
      } else {
        if (typeof reference !== 'string' || !reference) throw new SpeechError('Invalid reference file.');
        const file = await fs.open(reference, 'r');
        try {
          op.signal.throwIfAborted();
          const stat = await file.stat();
          if (!stat.isFile() || stat.size > REFERENCE_LIMIT) throw new SpeechError('Reference too large.');
          // Bound reads even if another process grows the file after stat().
          const storage = Buffer.alloc(Math.min(stat.size + 1, REFERENCE_LIMIT + 1));
          let used = 0;
          while (used < storage.length) {
            op.signal.throwIfAborted();
            const { bytesRead } = await file.read(storage, used, storage.length - used, null);
            if (!bytesRead) break;
            used += bytesRead;
          }
          if (used > stat.size || used > REFERENCE_LIMIT) throw new SpeechError('Reference changed.');
          audio = storage.subarray(0, used);
        } finally { await file.close(); }
      }
      op.stage = 'referenceValidation';
      wav(audio, true);
      op.signal.throwIfAborted();
      op.stage = 'enrollment';
      const output = await this.post(CUSTOMIZATION, { model: 'voice-enrollment', input: {
        action: 'create_voice', target_model: this.model, prefix: 'lingvoice', audio: `data:audio/wav;base64,${audio.toString('base64')}`,
      } }, op);
      const id = voiceId(output.voice_id, this.model);
      // Hand off the created resource before polling so callers can persist it for later cleanup.
      if (onCreated) {
        op.stage = 'registry';
        await onCreated({ voiceId: id, model: this.model, status: 'DEPLOYING' });
      }
      op.signal.throwIfAborted();
      while (true) {
        const details = await this.query(id, op);
        if (details.status === 'OK') return details;
        op.stage = 'readiness';
        if (details.status !== 'DEPLOYING') throw new SpeechError('音色部署未成功，请检查参考音频质量和音色状态。 / Voice enrollment did not deploy successfully; check reference audio and voice status.');
        await op.wait(new Promise<void>(resolve => {
          const timer = setTimeout(done, this.pollMs);
          function done() { clearTimeout(timer); op.signal.removeEventListener('abort', done); resolve(); }
          op.signal.addEventListener('abort', done, { once: true });
          if (op.signal.aborted) done();
        }));
      }
    });
  }

  synthesize(text: string, id: string, outputFile: string, signal?: AbortSignal, options?: { rate?: number }): Promise<QwenDubbingAudio> {
    return this.operation('synthesis', signal, async op => {
      const validated = voiceId(id, this.model);
      if (typeof text !== 'string' || !text.trim() || text.length > 4096 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text) ||
          typeof outputFile !== 'string' || !outputFile || outputFile.length > 4096 || outputFile.includes('\0')) throw new SpeechError('Invalid synthesis input.');
      const details = await this.query(validated, op);
      op.stage = 'readiness';
      if (details.status !== 'OK') throw new SpeechError('音色尚未就绪，请等待部署完成或重新创建。 / Voice is not ready; wait for deployment or recreate it.');
      op.stage = 'synthesis';
      const rate = options?.rate !== undefined && Number.isFinite(options.rate)
        ? Math.max(0.5, Math.min(2.0, Number(options.rate.toFixed(2))))
        : undefined;
      const payload: Record<string, unknown> = {
        model: this.model,
        input: { text, voice: validated, format: 'wav', sample_rate: 24000 },
        ...(rate !== undefined && Math.abs(rate - 1) > 0.02 ? { parameters: { rate } } : {}),
      };
      const response = await this.request(new URL(this.base + '/services/audio/tts/SpeechSynthesizer'), {
        method: 'POST', headers: { Authorization: `Bearer ${this.key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
      }, op);
      // Token Plan can return a WAV directly; standard DashScope returns output.audio.url.
      // Inspect bounded bytes rather than trusting the provider's MIME type.
      const raw = await this.read(response, /json/i.test(response.headers.get('content-type') ?? '') ? JSON_LIMIT : AUDIO_LIMIT, op);
      let audio: Buffer;
      if (raw.toString('ascii', 0, 4) === 'RIFF') {
        audio = raw;
      } else {
        const mime = response.headers.get('content-type') ?? '';
        if (!/^\s*\{/.test(raw.toString('utf8', 0, 64)) && !/json/i.test(mime)) {
          throw new SpeechError('The speech service returned invalid PCM WAV audio.');
        }
        if (raw.length > JSON_LIMIT) throw new SpeechError('Speech JSON response exceeds the size limit.');
        const output = parseOutput(raw);
        if (!object(output.audio) || typeof output.audio.url !== 'string') throw new SpeechError('The speech service returned no audio URL.');
        op.stage = 'downloadAddress';
        const url = downloadUrl(output.audio.url);
        op.stage = 'download';
        // Authorization is intentionally absent from signed OSS downloads.
        audio = await this.read(await this.request(url, { method: 'GET' }, op), AUDIO_LIMIT, op);
      }
      op.stage = 'validation';
      if (this.inspectAudio) await op.wait(Promise.resolve(this.inspectAudio(new Uint8Array(audio))));
      let info: { sampleRate: number; durationSeconds: number };
      try { info = wav(audio, false); }
      catch (error) { throw new SpeechError(`The speech service returned invalid 24 kHz PCM WAV audio. ${error instanceof SpeechError ? error.message : ''}`.trim()); }
      op.signal.throwIfAborted();
      op.stage = 'output';
      const target = path.resolve(outputFile);
      const temporary = path.join(path.dirname(target), `.qwen-${randomUUID()}.tmp`);
      try {
        await fs.writeFile(temporary, audio, { flag: 'wx', mode: 0o600, signal: op.signal });
        op.signal.throwIfAborted();
        await fs.rename(temporary, target);
      } finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
      return { outputFile: target, bytes: audio.length, sampleRate: 24000, durationSeconds: info.durationSeconds };
    });
  }
}
