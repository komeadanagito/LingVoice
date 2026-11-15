import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createDefaultProviderRegistry, stripBgmHallucinations, type ProviderService, type ResolvedProvider } from './providers';
import { aliyunAsrEndpoint } from './aliyun-asr';
const fallbackAsrAdapter = createDefaultProviderRegistry().get('openai-compatible').asr!;
import { defaultAsrSettings, type AsrSettings, type AsrConfig, type AsrConfigUpdate, type AsrCue, type AsrProgress, type AsrRequest } from '../shared/asr';
import type { LocalPluginManager } from './local-plugins';

interface Vault { encrypt(value: string): string; decrypt(value: string): string }
interface SavedConfig { settings: AsrSettings; apiKey: string }
interface Dependencies {
  spawn?: typeof spawn;
  fetch?: typeof fetch;
  /** Optional pre-ASR vocal stem separator. Returns a local dialogue WAV path when available. */
  prepareVocals?: (file: string, signal: AbortSignal) => Promise<string | undefined>;
  localPlugins?: LocalPluginManager;
}
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
function requestFailureDetail(error: unknown): string {
  if (error instanceof SyntaxError) return '识别服务返回的 JSON 无效或不完整，请检查接口地址或上游代理。 / The provider returned invalid or incomplete JSON; check the endpoint or upstream proxy.';
  const codes: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 5 && record(current); depth++) {
    if (typeof current.code === 'string') codes.push(current.code);
    current = current.cause;
  }
  const reasons: [string[], string][] = [
    [['ENOTFOUND', 'EAI_AGAIN'], '域名解析失败，请检查 Base URL 和 DNS。 / DNS lookup failed; check the provider hostname and DNS.'],
    [['ECONNREFUSED'], '连接被拒绝，请检查接口地址、端口及服务是否启动。 / Connection refused; check the endpoint, port and service.'],
    [['ECONNRESET', 'EPIPE', 'UND_ERR_SOCKET'], '连接中断，可能是网络或上游代理断开。 / Connection interrupted by the network or upstream proxy.'],
    [['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT'], '上游连接或响应超时，请检查网络和服务可用性。 / Upstream connection or response timed out; check the network and provider availability.'],
    [['CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'ERR_TLS_CERT_ALTNAME_INVALID'], 'TLS 证书验证失败，请检查服务端证书；证书校验保持启用。 / TLS certificate verification failed; check the provider certificate. Verification remains enabled.'],
  ];
  for (const [allowed, detail] of reasons) {
    const code = codes.find(value => allowed.includes(value));
    if (code) return `${detail} (${code})`;
  }
  // Never echo exception messages: fetch errors may contain URLs, credentials or response text.
  return '网络请求或响应读取失败，未获取到可用的 HTTP 错误详情。请检查网络、Base URL 与上游代理。 / Network request or response reading failed without usable HTTP error details; check the network, endpoint and upstream proxy.';
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
  if (value.mode !== undefined && value.mode !== 'cloud' && value.mode !== 'local') throw new Error('Invalid ASR mode.');
  apiUrl(value.baseUrl);
  return {
    ...(value.mode === 'local' ? { mode: 'local' as const } : {}),
    providerId: value.providerId === undefined ? 'legacy-asr' : text(value.providerId, 'provider ID', 200, true),
    baseUrl: (value.baseUrl as string).trim(), fullUrl: false,
    model: text(value.model, 'ASR model', 200).trim(),
    language: text(value.language, 'ASR language', 100, true).trim(),
    prompt: text(value.prompt, 'ASR prompt', 10000, true),
  };
}

interface LocalAsrWord { text?: unknown; start?: unknown; end?: unknown }
interface LocalAsrSegment { start?: unknown; end?: unknown; text?: unknown; words?: unknown }

function needsSpaceBetween(prev: string, next: string): boolean {
  if (!prev || !next) return false;
  const last = prev[prev.length - 1];
  const first = next[0];
  return /[A-Za-z0-9,.;:!?]/.test(last) && /[A-Za-z0-9]/.test(first);
}

export function localAsrResponseToCues(segments: unknown, offsetSeconds = 0): AsrCue[] {
  if (!Array.isArray(segments)) return [];
  const cues: AsrCue[] = [];
  for (const rawSeg of segments as LocalAsrSegment[]) {
    if (!record(rawSeg)) continue;
    const segStart = typeof rawSeg.start === 'number' && Number.isFinite(rawSeg.start) ? rawSeg.start : 0;
    const segEnd = typeof rawSeg.end === 'number' && Number.isFinite(rawSeg.end) ? rawSeg.end : segStart;
    const rawText = typeof rawSeg.text === 'string' ? rawSeg.text : '';
    const wordsRaw = Array.isArray(rawSeg.words) ? (rawSeg.words as LocalAsrWord[]).filter(w => record(w) && typeof w.text === 'string' && typeof w.start === 'number' && typeof w.end === 'number') : [];
    if (wordsRaw.length > 0) {
      let cursor = 0;
      const tokens = wordsRaw.map(word => {
        const wText = String(word.text);
        let wStart = Number(word.start);
        let wEnd = Math.max(wStart, Number(word.end));
        let trailingPunct = '';
        if (rawText && wText) {
          const idx = rawText.indexOf(wText, cursor);
          if (idx >= 0 && idx - cursor <= 8) {
            cursor = idx + wText.length;
            while (cursor < rawText.length && /^[.,!?;:'"”’）)\]】…，。！？；：、~～—\-]/.test(rawText[cursor])) {
              trailingPunct += rawText[cursor];
              cursor++;
            }
          }
        }
        return { text: wText, start: wStart, end: wEnd, punct: trailingPunct };
      });
      // Snap isolated ForcedAligner boundary outliers (e.g. first char aligned seconds before the rest of its word/phrase).
      if (tokens.length >= 2 && !tokens[0].punct && tokens[0].text.length <= 2 && tokens[1].start - tokens[0].end > 1.0) {
        tokens[0].end = tokens[1].start;
        tokens[0].start = Math.max(0, Number((tokens[1].start - 0.16).toFixed(3)));
      }
      let cStart = -1;
      let cEnd = -1;
      let cText = '';
      let wordCount = 0;
      const flush = () => {
        const cleaned = stripBgmHallucinations(cText);
        if (cleaned && cStart >= 0) {
          const start = Math.max(0, offsetSeconds + cStart);
          const end = Math.max(start + 0.05, offsetSeconds + Math.max(cEnd, cStart));
          cues.push({ id: 0, start: Number(start.toFixed(3)), end: Number(end.toFixed(3)), text: cleaned });
        }
        cStart = -1;
        cEnd = -1;
        cText = '';
        wordCount = 0;
      };
      for (let ti = 0; ti < tokens.length; ti++) {
        const tok = tokens[ti];
        const wText = tok.text;
        const wStart = tok.start;
        const wEnd = tok.end;
        const trailingPunct = tok.punct;
        const hasCjkBefore = /[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(cText);
        const minPauseLen = hasCjkBefore ? 12 : 28;
        const maxClauseLen = hasCjkBefore ? 34 : 84;
        const isTrailingParticle = tok.text.length <= 2 && /[。！？!?]/.test(trailingPunct) && !/[，,。！？!?；;]/.test(cText.slice(-1));
        const pauseGap = wStart - cEnd;
        if (
          cStart >= 0 &&
          !isTrailingParticle &&
          ((cText.length >= minPauseLen && pauseGap >= 0.55 && !trailingPunct) ||
            (cText.length >= (hasCjkBefore ? 6 : 14) && pauseGap >= 0.95) ||
            (cEnd - cStart >= 8.0 && cText.length >= maxClauseLen))
        ) {
          flush();
        }
        if (cStart < 0) cStart = wStart;
        cEnd = Math.max(cEnd, wEnd);
        cText += (needsSpaceBetween(cText, wText) ? ' ' : '') + wText + trailingPunct;
        wordCount++;
        const checkStr = wText + trailingPunct;
        const hasCjk = /[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(cText);
        const sentenceEnd = /[。！？!?；;\n][”’"）)\]】]*$/.test(checkStr) || /\.[”’"）)\]】]*$/.test(checkStr);
        const commaBreak = /[，,：:][”’"）)\]】]*$/.test(checkStr) &&
          ((cText.length >= (hasCjk ? 18 : 42) && cEnd - cStart >= 1.8) || cText.length >= (hasCjk ? 24 : 58));
        const enumBreak = /、$/.test(checkStr) && cText.length >= 38;
        const tooLong = hasCjk ? cText.length >= 40 : (cText.length >= 92 || wordCount >= 22);
        if (sentenceEnd || commaBreak || enumBreak || tooLong) {
          flush();
        }
      }
      flush();
      continue;
    }
    const segText = stripBgmHallucinations(rawText);
    if (segText && segEnd > segStart) {
      const rawSentences = segText.split(/([。！？!?；;\n]+)/).filter(Boolean);
      const sentences: string[] = [];
      for (const part of rawSentences) {
        const trimmed = part.trim();
        if (!trimmed) continue;
        if (/^[。！？!?；;\n]+$/.test(trimmed) && sentences.length > 0) {
          sentences[sentences.length - 1] += trimmed;
        } else {
          const cleanPart = stripBgmHallucinations(trimmed);
          if (cleanPart) sentences.push(cleanPart);
        }
      }
      const balanced: string[] = [];
      for (const s of (sentences.length > 0 ? sentences : [segText])) {
        const isCjk = /[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(s);
        const maxLen = isCjk ? 28 : 72;
        if (s.length <= maxLen) {
          balanced.push(s);
          continue;
        }
        const pieces = s.split(/([，,]\s*)/).filter(Boolean);
        let buf = '';
        for (const piece of pieces) {
          if (/^[，,]\s*$/.test(piece)) {
            buf += piece.trim();
            if (buf.length >= (isCjk ? 14 : 36)) {
              balanced.push(buf);
              buf = '';
            }
          } else if (buf && buf.length + piece.trim().length > maxLen && buf.length >= (isCjk ? 10 : 24)) {
            balanced.push(buf);
            buf = piece.trim();
          } else {
            buf += (buf && !isCjk && !/[，,]$/.test(buf) ? ' ' : '') + piece.trim();
          }
        }
        if (buf.trim()) {
          if (balanced.length > 0 && buf.trim().length < (isCjk ? 6 : 15) && balanced[balanced.length - 1].length + buf.trim().length <= maxLen + 8) {
            balanced[balanced.length - 1] += (isCjk ? '' : ' ') + buf.trim();
          } else {
            balanced.push(buf.trim());
          }
        }
      }
      const list = balanced.length > 0 ? balanced : [segText];
      const totalChars = list.reduce((sum, s) => sum + Math.max(1, s.length), 0);
      let cursorStart = segStart;
      const span = segEnd - segStart;
      for (let i = 0; i < list.length; i++) {
        const s = list[i];
        const partEnd = i === list.length - 1 ? segEnd : Math.min(segEnd, cursorStart + span * (Math.max(1, s.length) / totalChars));
        if (partEnd > cursorStart) {
          cues.push({
            id: 0,
            start: Number((offsetSeconds + cursorStart).toFixed(3)),
            end: Number(Math.max(offsetSeconds + cursorStart + 0.05, offsetSeconds + partEnd).toFixed(3)),
            text: s,
          });
          cursorStart = partEnd;
        }
      }
    }
  }
  cues.sort((a, b) => a.start - b.start || a.end - b.end);
  // Heal sentences split across ASR chunk boundaries or tiny orphan comma-tails without breaking distinct sentences.
  const merged: AsrCue[] = [];
  for (const cue of cues) {
    const prev = merged[merged.length - 1];
    if (prev) {
      const gap = cue.start - prev.end;
      const hasCjk = /[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(prev.text + cue.text);
      const maxCombined = hasCjk ? 36 : 84;
      const prevTerminal = /[。！？!?；;\n][”’"）)\]】]*$/.test(prev.text) || /\.[”’"）)\]】]*$/.test(prev.text);
      const prevComma = /[，,：:、]$/.test(prev.text);
      const cueNoPunct = cue.text.replace(/[，,。！？!?.；;：:、\s"”’'）)\]】]/g, '');
      const tinyNext = cueNoPunct.length <= (hasCjk ? 4 : 12);
      const canHealSplit = gap >= -0.05 && gap <= 0.20 && !prevTerminal && (!prevComma || tinyNext);
      const canAttachTinyCommaTail = prevComma && tinyNext && gap >= -0.05 && gap <= 0.60;
      if ((canHealSplit || canAttachTinyCommaTail) && prev.text.length + cue.text.length <= maxCombined) {
        prev.end = Math.max(prev.end, cue.end);
        prev.text = `${prev.text}${needsSpaceBetween(prev.text, cue.text) ? ' ' : ''}${cue.text}`;
        continue;
      }
    }
    merged.push({ ...cue });
  }
  // Second pass: fold any remaining tiny non-terminal orphan cue into its adjacent neighbor when gap is small.
  const healed: AsrCue[] = [];
  for (let i = 0; i < merged.length; i++) {
    const cur = merged[i];
    const hasCjk = /[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(cur.text);
    const bareLen = cur.text.replace(/[，,。！？!?.；;：:、\s"”’'）)\]】]/g, '').length;
    const isTerminal = /[。！？!?；;\n][”’"）)\]】]*$/.test(cur.text) || /\.[”’"）)\]】]*$/.test(cur.text);
    const isTiny = bareLen <= (hasCjk ? 2 : 8);
    if (isTiny && !isTerminal && i + 1 < merged.length && merged[i + 1].start - cur.end <= 0.7) {
      const next = merged[i + 1];
      const maxComb = hasCjk ? 36 : 84;
      if (cur.text.length + next.text.length <= maxComb) {
        next.start = Math.min(cur.start, next.start);
        next.text = `${cur.text}${needsSpaceBetween(cur.text, next.text) ? ' ' : ''}${next.text}`;
        continue;
      }
    }
    healed.push(cur);
  }
  for (let i = 1; i < healed.length; i++) {
    if (healed[i].start < healed[i - 1].end) {
      if (healed[i].start > healed[i - 1].start + 0.05) {
        healed[i - 1].end = healed[i].start;
      } else {
        healed[i].start = healed[i - 1].end;
        if (healed[i].end <= healed[i].start) {
          healed[i].end = Number((healed[i].start + 0.05).toFixed(3));
        }
      }
    }
  }
  return healed;
}

export function asrEndpoint(config: AsrSettings): string {
  return aliyunAsrEndpoint(apiUrl(config.baseUrl).toString());
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

/** Detects active speech time windows in 16 kHz 16-bit mono PCM to avoid stretching dialogue over BGM/silence. */
export function detectVoicedWindows(pcm: Uint8Array, duration: number): { start: number; end: number }[] {
  if (!pcm || pcm.byteLength < 3200 || !Number.isFinite(duration) || duration <= 0) {
    return [{ start: 0, end: duration }];
  }
  const frameSamples = 800; // 50 ms at 16 kHz
  const frameBytes = frameSamples * 2;
  const frameCount = Math.floor(pcm.byteLength / frameBytes);
  if (frameCount < 4) return [{ start: 0, end: duration }];

  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const rmsValues: number[] = new Array(frameCount);
  const zcrValues: number[] = new Array(frameCount);
  let minRms = Infinity;
  let maxRms = 0;

  for (let f = 0; f < frameCount; f++) {
    const base = f * frameBytes;
    let sumSq = 0;
    let crossings = 0;
    let prev = view.getInt16(base, true);
    for (let i = 0; i < frameSamples; i++) {
      const sample = view.getInt16(base + i * 2, true);
      sumSq += sample * sample;
      if ((sample >= 0 && prev < 0) || (sample < 0 && prev >= 0)) crossings++;
      prev = sample;
    }
    const rms = Math.sqrt(sumSq / frameSamples);
    rmsValues[f] = rms;
    zcrValues[f] = crossings / frameSamples;
    if (rms < minRms) minRms = rms;
    if (rms > maxRms) maxRms = rms;
  }

  // Synthetic/uniform buffers (all-zero test fixtures or constant sine tones) keep full-window mapping.
  if (maxRms < 150 || maxRms <= minRms * 2.2) {
    return [{ start: 0, end: duration }];
  }

  const sortedRms = [...rmsValues].sort((a, b) => a - b);
  const noiseFloor = sortedRms[Math.floor(frameCount * 0.05)] ?? minRms;
  const speechPeak = sortedRms[Math.floor(frameCount * 0.9)] ?? maxRms;
  const threshold = Math.max(150, noiseFloor + (speechPeak - noiseFloor) * 0.18);
  const frameDuration = duration / frameCount;

  const rawWindows: { start: number; end: number }[] = [];
  let activeStart = -1;
  for (let f = 0; f < frameCount; f++) {
    const isSpeech = rmsValues[f] >= threshold && zcrValues[f] >= 0.008 && zcrValues[f] <= 0.48;
    if (isSpeech && activeStart < 0) {
      activeStart = f * frameDuration;
    } else if (!isSpeech && activeStart >= 0) {
      rawWindows.push({ start: activeStart, end: f * frameDuration });
      activeStart = -1;
    }
  }
  if (activeStart >= 0) rawWindows.push({ start: activeStart, end: duration });

  // Merge nearby speech windows separated by natural pauses (<= 0.65 s) and pad edges slightly.
  const merged: { start: number; end: number }[] = [];
  for (const win of rawWindows) {
    const paddedStart = Math.max(0, win.start - 0.12);
    const paddedEnd = Math.min(duration, win.end + 0.12);
    const prev = merged[merged.length - 1];
    if (prev && paddedStart - prev.end <= 0.65) {
      prev.end = Math.max(prev.end, paddedEnd);
    } else {
      merged.push({ start: paddedStart, end: paddedEnd });
    }
  }

  const valid = merged.filter(w => w.end - w.start >= 0.25);
  return valid.length > 0 ? valid : [{ start: 0, end: duration }];
}

/** Attenuates non-voiced BGM/noise intervals outside active speech windows before sending PCM to ASR. */
export function gateNonVoicedPcm(pcm: Uint8Array, duration: number): Uint8Array {
  const windows = detectVoicedWindows(pcm, duration);
  if (windows.length === 1 && windows[0].start === 0 && Math.abs(windows[0].end - duration) < 1e-6) {
    return pcm;
  }
  const gated = new Uint8Array(pcm);
  const view = new DataView(gated.buffer, gated.byteOffset, gated.byteLength);
  const totalSamples = Math.floor(gated.byteLength / 2);
  const sampleRate = 16000;
  const fadeSamples = 320; // 20 ms cosine fade at window edges
  const mask = new Float32Array(totalSamples).fill(0.02); // -34 dB floor in non-voiced BGM intervals

  for (const win of windows) {
    const startSample = Math.max(0, Math.floor(win.start * sampleRate));
    const endSample = Math.min(totalSamples, Math.ceil(win.end * sampleRate));
    for (let i = startSample; i < endSample; i++) mask[i] = 1.0;
    for (let f = 1; f <= fadeSamples; f++) {
      const weight = 0.02 + 0.98 * 0.5 * (1 - Math.cos((Math.PI * f) / fadeSamples));
      const beforeIdx = startSample - fadeSamples + f - 1;
      if (beforeIdx >= 0 && mask[beforeIdx] < weight) mask[beforeIdx] = weight;
      const afterIdx = endSample + fadeSamples - f;
      if (afterIdx < totalSamples && mask[afterIdx] < weight) mask[afterIdx] = weight;
    }
  }

  for (let i = 0; i < totalSamples; i++) {
    if (mask[i] < 0.999) {
      const sample = view.getInt16(i * 2, true);
      view.setInt16(i * 2, Math.round(sample * mask[i]), true);
    }
  }
  return gated;
}

function mapProportionalToWindows(ratio: number, windows: readonly { start: number; end: number }[], duration: number): number {
  const clamped = Math.max(0, Math.min(1, ratio));
  const totalVoiced = windows.reduce((sum, w) => sum + (w.end - w.start), 0);
  if (totalVoiced <= 0) return clamped * duration;
  let target = clamped * totalVoiced;
  for (let i = 0; i < windows.length; i++) {
    const w = windows[i];
    const len = w.end - w.start;
    if (target <= len || i === windows.length - 1) {
      return Math.min(duration, w.start + Math.min(len, target));
    }
    target -= len;
  }
  return duration;
}

export function parseAsrSegments(value: unknown, duration: number, offset = 0, pcm?: Uint8Array): AsrCue[] {
  if (!Number.isFinite(duration) || duration <= 0 || !Number.isFinite(offset) || offset < 0) throw new Error('Invalid ASR chunk timing.');
  if (!record(value) || !Array.isArray(value.segments)) throw new Error('ASR response must contain timestamped segments after Qwen response conversion. Check the Alibaba Cloud model and response format.');
  if (value.segments.length > MAX_CUES) throw new Error('ASR provider returned too many segments.');
  const cues: AsrCue[] = [];
  const isProportional = Boolean(value._proportional);
  const windows = isProportional && pcm ? detectVoicedWindows(pcm, duration) : [{ start: 0, end: duration }];
  for (const segment of value.segments) {
    if (!record(segment) || typeof segment.start !== 'number' || !Number.isFinite(segment.start) || segment.start < 0 ||
      typeof segment.end !== 'number' || !Number.isFinite(segment.end) || segment.end <= segment.start ||
      typeof segment.text !== 'string' || segment.text.length > 100000) {
      throw new Error('ASR provider returned invalid segment timestamps or text.');
    }
    const rawStart = isProportional ? mapProportionalToWindows(segment.start, windows, duration) : segment.start;
    const rawEnd = isProportional ? Math.min(duration, mapProportionalToWindows(segment.end, windows, duration)) : segment.end;
    if (rawStart >= duration || rawEnd > duration + 0.25 || rawEnd <= rawStart) {
      throw new Error('ASR provider returned invalid segment timestamps or text.');
    }
    const cleaned = stripBgmHallucinations(segment.text);
    if (!cleaned) continue;
    cues.push({ id: 0, start: offset + rawStart, end: offset + Math.min(duration, rawEnd), text: cleaned });
  }
  cues.sort((a, b) => a.start - b.start || a.end - b.end);
  for (let i = 1; i < cues.length; i++) {
    if (cues[i].start < cues[i - 1].end) {
      if (cues[i].start > cues[i - 1].start + 0.05) {
        cues[i - 1].end = cues[i].start;
      } else {
        cues[i].start = cues[i - 1].end;
        if (cues[i].end <= cues[i].start) {
          cues[i].end = Math.min(offset + duration, cues[i].start + 0.05);
        }
      }
    }
  }
  return cues.filter(cue => cue.end > cue.start).map((cue, index) => ({ ...cue, id: index + 1 }));
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
      const context = provider ? { ...provider.context, apiKey: key || provider.context.apiKey } : { baseUrl: config.baseUrl, apiKey: key };
      const wavBytes = pcmWav(pcm);
      const request = adapter.build(context, { ...config, wav: wavBytes });
      const doFetch = this.dependencies.fetch ?? fetch;
      let response = await doFetch(request.url, {
        ...request.init, signal: controller.signal, redirect: 'error',
      });
      const readErrorDetails = async (res: Response): Promise<{ serverCode: string; serverMessage: string }> => {
        let serverMessage = '';
        let serverCode = '';
        try {
          const reader = res.body?.getReader();
          let raw = '';
          if (reader) {
            try {
              const decoder = new TextDecoder();
              let bytes = 0;
              while (true) {
                const chunk = await reader.read();
                if (chunk.done) break;
                bytes += chunk.value.byteLength;
                if (bytes > 16384) break;
                raw += decoder.decode(chunk.value, { stream: true });
              }
              raw += decoder.decode();
            } finally {
              await reader.cancel().catch(() => {});
              reader.releaseLock();
            }
          }
          const parsed = JSON.parse(raw);
          if (record(parsed)) {
            const error = record(parsed.error) ? parsed.error : parsed;
            const code = error.code ?? error.Code;
            const message = error.message ?? error.Message;
            if (typeof code === 'string') serverCode = code;
            if (typeof message === 'string') serverMessage = message;
          }
        } catch {
          await res.body?.cancel().catch(() => {});
        }
        return { serverCode, serverMessage };
      };
      if (!response.ok) {
        let { serverCode, serverMessage } = await readErrorDetails(response);
        const isDashScopeHost = /dashscope(?:-intl)?\.aliyuncs\.com|(?:cn-beijing|ap-southeast-1)\.maas\.aliyuncs\.com/i.test(request.url);
        if (
          response.status === 400 &&
          isDashScopeHost &&
          ((!serverCode && !serverMessage) || /url error/i.test(serverMessage))
        ) {
          // Models like qwen-audio-3.0-asr-flash / qwen-audio-3.1-asr-flash require DashScope's native multimodal-generation endpoint.
          const mmUrl = `${new URL(request.url).origin}/api/v1/services/aigc/multimodal-generation/generation`;
          const mmMessages: Array<Record<string, unknown>> = [];
          if (config.prompt) mmMessages.push({ role: 'system', content: [{ text: config.prompt }] });
          mmMessages.push({
            role: 'user',
            content: [{ audio: `data:audio/wav;base64,${Buffer.from(wavBytes).toString('base64')}`, format: 'wav' }],
          });
          const mmBody = {
            model: config.model,
            input: { messages: mmMessages },
            parameters: {
              format: 'wav',
              audio_format: 'wav',
              asr_options: { enable_itn: false, ...(config.language ? { language: config.language } : {}) },
            },
          };
          response = await doFetch(mmUrl, {
            method: 'POST',
            headers: request.init.headers,
            body: JSON.stringify(mmBody),
            signal: controller.signal,
            redirect: 'error',
          });
          if (!response.ok) {
            ({ serverCode, serverMessage } = await readErrorDetails(response));
          }
        }
        if (!response.ok) {
          if (/ASR_RESPONSE_HAVE_NO_WORDS|ASR_RESPONSE_NO_WORDS/.test(`${serverCode} ${serverMessage}`) || (serverCode === 'CLIENT_ERROR' && serverMessage.includes('NO_WORDS'))) {
            return { segments: [] };
          }
          if (serverMessage || serverCode) {
            let sanitized = [serverCode, serverMessage].filter(Boolean).join(': ');
            if (key) sanitized = sanitized.replaceAll(key, '[REDACTED]');
            sanitized = sanitized.replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED]');
            sanitized = sanitized.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 300);
            throw new Error(`HTTP ${response.status}: ${sanitized}`);
          }
          throw new Error(`HTTP ${response.status}`);
        }
      }
      if (Number(response.headers.get('content-length')) > MAX_RESPONSE_BYTES) {
        await response.body?.cancel().catch(() => {});
        throw new Error('size limit');
      }
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
          if (bytes > MAX_RESPONSE_BYTES) { await reader.cancel(); throw new Error('size limit'); }
          body += decoder.decode(chunk.value, { stream: true });
        }
        body += decoder.decode();
      } finally { reader.releaseLock(); }
      this.check(signal);
      return JSON.parse(body) as unknown;
    } catch (err) {
      controller.abort();
      if (signal.aborted) throw new Error('ASR cancelled.');
      if (timedOut) throw new Error('ASR upload timed out.');
      const httpMatch = err instanceof Error && /^HTTP (\d+)(?:: (.*))?/.exec(err.message);
      if (httpMatch) {
        const code = Number(httpMatch[1]);
        const detail = httpMatch[2]?.trim();
        if (code === 404) {
          throw new Error('ASR provider request failed (HTTP 404 Not Found): 阿里云 Qwen ASR 接口不存在。请填写对应地域的百炼工作空间 Base URL（以 /compatible-mode/v1 结尾），程序会请求 /chat/completions。');
        }
        if (code === 401 || code === 403) {
          throw new Error(`ASR provider request failed (HTTP ${code}): 身份验证失败，请检查 API Key 或模型权限。`);
        }
        if (detail) {
          throw new Error(`ASR provider request failed (HTTP ${code}): ${detail}`);
        }
        if (code === 400) {
          throw new Error('ASR provider request failed (HTTP 400): 阿里云未返回可解析的错误详情。请确认 Base URL 为对应地域的百炼工作空间地址、模型为已开通的 Qwen ASR Flash，且 API Key 属于同一地域；本程序使用 /compatible-mode/v1/chat/completions。');
        }
        throw new Error(`ASR provider request failed (HTTP ${code}). Check the Alibaba Cloud endpoint, API key and model availability.`);
      }
      if (err instanceof Error && err.message === 'size limit') {
        throw new Error('ASR provider request failed: response size exceeded the limit.');
      }
      throw new Error(`ASR provider request failed: ${requestFailureDetail(err)}`);
    } finally { clearTimeout(timer); signal.removeEventListener('abort', abort); }
  }

  async test(): Promise<void> {
    if (this.busy) throw new Error('ASR is already busy.');
    await this.pending;
    const state = await this.load();
    if (state.settings.mode === 'local') {
      const localPlugins = this.dependencies.localPlugins;
      if (!localPlugins) throw new Error('当前后端未启用本地模型插件管理器。 / Local plugin manager is unavailable.');
      const inputsDir = localPlugins.inputsDir();
      await fs.mkdir(inputsDir, { recursive: true });
      const filename = `lingvoice-test-${randomUUID()}.wav`;
      const wavFile = path.join(inputsDir, filename);
      const pcm = new Uint8Array(32000);
      const view = new DataView(pcm.buffer);
      for (let index = 0; index < 16000; index++) view.setInt16(index * 2, Math.round(Math.sin(index * 2 * Math.PI * 440 / 16000) * 10000), true);
      await fs.writeFile(wavFile, pcmWav(pcm));
      try {
        await localPlugins.requestJson('asr', '/infer', {
          audio_path: filename,
          align: false,
          device: 'cuda',
        });
      } finally {
        await fs.rm(wavFile, { force: true }).catch(() => {});
      }
      return;
    }
    if (!state.settings.providerId && !state.settings.baseUrl) {
      throw new Error('未配置语音识别接口地址，请在设置中填写 Base URL 或选择 Provider。');
    }
    const provider = this.providers && state.settings.providerId ? await this.providers.resolve(state.settings.providerId, 'asr') : undefined;
    let key = '';
    try {
      if (state.apiKey) key = text(this.vault.decrypt(state.apiKey), 'ASR credential', 8192, true);
      else if (provider) key = provider.context.apiKey;
    } catch {
      throw new Error('Unable to decrypt ASR credentials. Save the key again.');
    }

    const controller = new AbortController();
    const pcm = new Uint8Array(32000);
    const view = new DataView(pcm.buffer);
    for (let index = 0; index < 16000; index++) view.setInt16(index * 2, Math.round(Math.sin(index * 2 * Math.PI * 440 / 16000) * 10000), true);

    const response = await this.upload(state.settings, key, pcm, controller.signal, provider);
    const parsed = provider ? provider.adapter.asr!.parse(response) : fallbackAsrAdapter.parse(response);
    parseAsrSegments(parsed, 1, 0);
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
      const useLocal = state.settings.mode === 'local';
      if (useLocal && !this.dependencies.localPlugins) {
        throw new Error('当前后端未启用本地模型插件管理器。 / Local plugin manager is unavailable.');
      }
      const provider = !useLocal && this.providers && state.settings.providerId ? await this.providers.resolve(state.settings.providerId, 'asr') : undefined;
      let key = '';
      if (!useLocal) {
        try {
          if (state.apiKey) key = text(this.vault.decrypt(state.apiKey), 'ASR credential', 8192, true);
          else if (provider) key = provider.context.apiKey;
        }
        catch { throw new Error('Unable to decrypt ASR credentials. Save the key again.'); }
      }
      this.check(run.signal);
      temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'lingvoice-asr-'));
      const raw = path.join(temporary, 'audio.pcm');
      this.progress({ stage: 'extracting', completed: 0, total: 1 });
      let audioSource = file;
      if (this.dependencies.prepareVocals) {
        try {
          const separated = await this.dependencies.prepareVocals(file, run.signal);
          if (separated) audioSource = separated;
        } catch {
          this.check(run.signal);
        }
      }
      await this.extract(audioSource, raw, run.signal);
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
          const chunkDuration = length / BYTES_PER_SECOND;
          let segments: AsrCue[];
          if (useLocal) {
            const localPlugins = this.dependencies.localPlugins!;
            const inputsDir = localPlugins.inputsDir();
            await fs.mkdir(inputsDir, { recursive: true });
            const filename = `lingvoice-${randomUUID()}.wav`;
            const wavFile = path.join(inputsDir, filename);
            await fs.writeFile(wavFile, pcmWav(pcm));
            try {
              const lang = state.settings.language || null;
              let response: { segments?: unknown };
              try {
                response = await localPlugins.requestJson<{ segments?: unknown }>('asr', '/infer', {
                  audio_path: filename,
                  language: lang,
                  align: true,
                  chunk_seconds: 20,
                  max_new_tokens: 512,
                  device: 'cuda',
                }, run.signal);
              } catch (err) {
                const errCode = (err as { code?: string }).code;
                if (errCode === 'unsupported_alignment_language' || errCode === 'alignment_failed') {
                  response = await localPlugins.requestJson<{ segments?: unknown }>('asr', '/infer', {
                    audio_path: filename,
                    language: lang,
                    align: false,
                    chunk_seconds: 20,
                    max_new_tokens: 512,
                    device: 'cuda',
                  }, run.signal);
                } else {
                  throw err;
                }
              }
              this.check(run.signal);
              segments = localAsrResponseToCues(response.segments, offset / BYTES_PER_SECOND);
            } finally {
              await fs.rm(wavFile, { force: true }).catch(() => {});
            }
          } else {
            const response = await this.upload(state.settings, key, pcm, run.signal, provider);
            this.check(run.signal);
            const parsed = provider ? provider.adapter.asr!.parse(response) : fallbackAsrAdapter.parse(response);
            segments = parseAsrSegments(parsed, chunkDuration, offset / BYTES_PER_SECOND, pcm);
          }
          if (cues.length + segments.length > MAX_CUES) throw new Error('ASR result exceeds the subtitle count limit.');
          for (const cue of segments) cues.push(cue);
          this.progress({ stage: 'transcribing', completed: Math.floor(offset / CHUNK_BYTES) + 1, total });
        }
      } finally { await handle.close(); }
      this.check(run.signal);
      if (!cues.length) throw new Error('No speech found in the selected media. 未在所选媒体中检测到人声台词（请确认视频包含说话人声而非纯背景音乐/纯录屏）。');
      return cues.sort((a, b) => a.start - b.start || a.end - b.end).map((cue, index) => ({ ...cue, id: index + 1 }));
    } finally {
      try { if (temporary) await fs.rm(temporary, { recursive: true, force: true }); }
      finally { this.run = undefined; }
    }
  }
}
