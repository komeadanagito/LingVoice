import * as fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DEFAULT_DUBBING_MODEL, DUBBING_MODEL, SUPPORTED_DUBBING_MODELS, defaultDubbingSettings, type DubbingConfig, type DubbingCue, type DubbingEnvironment, type DubbingModel, type DubbingProgress, type DubbingRequest, type DubbingResult, type DubbingSettings } from '../shared/dubbing';
import { advanceTranslationMemory, translationWindow, type TranslationMemoryState } from '../shared/translation';
import type { TtsService } from './tts';
import type { TranslationService } from './translation';
import type { InferenceMode } from '../shared/local-models';
import type { LocalPluginManager } from './local-plugins';
import { QwenDubbingClient, normalizeQwenDubbingBaseUrl } from './qwen-dubbing';
import { detectSeparationEnvironment, separateAudio, separateAudioRoformer, type RoformerSeparationOptions, type SeparationOptions } from './audio-separation';
import { buildSmartBackground, extractAudio, extractLocalVoiceReference, extractVoiceReference, ffmpegBase, localFile, readWavInfo, runAudioProcess, separateAudioFfmpegFallback } from './audio-process';
import { alignAudio, detectWavTrimBounds, type AudioSegment } from './audio-alignment';
import { mixDubbedVideo } from './audio-mix';

function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function hash(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function validString(value: unknown, max = 4096, empty = false): value is string {
  return typeof value === 'string' && value.length <= max && (empty || !!value.trim()) && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value);
}
export function validateDubbingSettings(value: unknown): DubbingSettings {
  if (!object(value) || Object.keys(value).some(key => !['pythonPath', 'modelFile', 'baseUrl', 'model'].includes(key)) ||
      !validString(value.pythonPath, 2048) || !validString(value.modelFile, 4096, true) || !validString(value.baseUrl, 2048, true)) throw new Error('Invalid dubbing settings.');
  const model = value.model !== undefined
    ? (typeof value.model === 'string' && (SUPPORTED_DUBBING_MODELS as readonly string[]).includes(value.model) ? value.model as DubbingModel : undefined)
    : DEFAULT_DUBBING_MODEL;
  if (value.model !== undefined && model === undefined) throw new Error('Unsupported dubbing model. Choose qwen-audio-3.1-tts-plus, qwen-audio-3.0-tts-plus or doubao-seed-tts-2.0.');
  const settings: DubbingSettings = {
    pythonPath: value.pythonPath.trim(),
    modelFile: value.modelFile.trim(),
    baseUrl: value.baseUrl.trim(),
    model: model ?? DEFAULT_DUBBING_MODEL,
  };
  if (settings.modelFile && !path.isAbsolute(settings.modelFile)) throw new Error('Select an absolute path to an already downloaded separation model.');
  if (settings.baseUrl) settings.baseUrl = normalizeQwenDubbingBaseUrl(settings.baseUrl);
  return settings;
}
export function validateDubbingRequest(value: unknown): DubbingRequest {
  if (!object(value) || Object.keys(value).some(key => !['jobId', 'file', 'cues', 'offset', 'backgroundVolume', 'preview', 'consent', 'useTtsConfig'].includes(key)) ||
      typeof value.jobId !== 'string' || !/^[a-zA-Z0-9-]{8,80}$/.test(value.jobId) || !validString(value.file) ||
      !Array.isArray(value.cues) || !value.cues.length || value.cues.length > 10000 ||
      typeof value.offset !== 'number' || !Number.isFinite(value.offset) || Math.abs(value.offset) > 60 ||
      typeof value.backgroundVolume !== 'number' || !Number.isFinite(value.backgroundVolume) || value.backgroundVolume < 0 || value.backgroundVolume > 2 ||
      typeof value.preview !== 'boolean' || value.consent !== true || (value.useTtsConfig !== undefined && typeof value.useTtsConfig !== 'boolean')) throw new Error('Provide a media file, subtitle cues and explicit upload/billing consent.');
  let previousEnd = 0, characters = 0;
  const ids = new Set<number>();
  const cues = value.cues.map((item: unknown): DubbingCue => {
    if (!object(item) || Object.keys(item).some(key => !['id', 'start', 'end', 'text', 'translated', 'speechText'].includes(key)) ||
        !Number.isSafeInteger(item.id) || ids.has(item.id as number) || typeof item.start !== 'number' || !Number.isFinite(item.start) ||
        typeof item.end !== 'number' || !Number.isFinite(item.end) || item.start < 0 || item.end <= item.start || item.end > 21600 ||
        item.start + (value.offset as number) < previousEnd || !validString(item.text) ||
        (item.translated !== undefined && !validString(item.translated)) || (item.speechText !== undefined && !validString(item.speechText))) throw new Error('Single-speaker dubbing requires ordered, non-overlapping cues and nonempty text (maximum 4096 characters per field). Check subtitle delay too.');
    ids.add(item.id as number); previousEnd = item.end + (value.offset as number);
    characters += (item.text as string).length + String(item.translated ?? '').length + String(item.speechText ?? '').length;
    if (characters > 500_000) throw new Error('Dubbing transcript exceeds the character limit. Split the video.');
    return { id: item.id as number, start: item.start, end: item.end, text: item.text, ...(item.translated === undefined ? {} : { translated: item.translated as string }), ...(item.speechText === undefined ? {} : { speechText: item.speechText as string }) };
  });
  return { jobId: value.jobId, file: value.file, cues, offset: value.offset, backgroundVolume: value.backgroundVolume, preview: value.preview, consent: true, ...(value.useTtsConfig !== undefined ? { useTtsConfig: value.useTtsConfig as boolean } : {}) };
}
export function selectVoiceReference(cues: readonly DubbingCue[], offset: number, duration: number): { start: number; duration: number } {
  // Score all valid continuous speech windows so we prefer 10–20s dense dialogue over short/intro clips.
  const findBest = (maxGap: number, minVoiced: number) => {
    let best: { start: number; duration: number; score: number } | undefined;
    for (let index = 0; index < cues.length; index++) {
      const start = cues[index].start + offset;
      if (start < 0 || start >= duration) continue;
      let end = cues[index].end + offset, voiced = end - start;
      for (let next = index + 1; next < cues.length && end - start < 16; next++) {
        const cue = cues[next];
        if (cue.start + offset - end > maxGap) break;
        voiced += cue.end - cue.start; end = cue.end + offset;
      }
      const length = Math.min(20, duration - start, end - start);
      if (length >= 5 && voiced >= minVoiced) {
        const effectiveVoiced = Math.min(voiced, length);
        const density = effectiveVoiced / length;
        const durationScore = Math.min(effectiveVoiced, 16) / 16;
        const introPenalty = start < 2 && cues.length > 2 ? 0.1 : 0;
        const score = density * 0.6 + durationScore * 0.4 - introPenalty;
        if (!best || score > best.score + 0.05) {
          best = { start, duration: length, score };
        }
      }
    }
    return best;
  };
  const primary = findBest(1, 5);
  if (primary) return { start: primary.start, duration: primary.duration };
  const relaxed = findBest(2.5, 3.5);
  if (relaxed) return { start: relaxed.start, duration: relaxed.duration };
  throw new Error('No suitable voice reference: provide at least 5 seconds of clear, continuous single-speaker speech (10–20 seconds recommended).');
}

/** Evaluates candidate voice reference windows against actual separated dialogue WAV energy/SNR when available. */
export async function selectCleanestVoiceReference(
  cues: readonly DubbingCue[],
  offset: number,
  duration: number,
  dialoguePath?: string,
): Promise<{ start: number; duration: number }> {
  const fallback = selectVoiceReference(cues, offset, duration);
  if (!dialoguePath) return fallback;
  try {
    const info = await readWavInfo(dialoguePath);
    if (info.bitsPerSample !== 16 || info.duration < 5) return fallback;
    const collectCandidates = (maxGap: number, minVoiced: number) => {
      const list: { start: number; duration: number; cueScore: number }[] = [];
      for (let index = 0; index < cues.length; index++) {
        const start = cues[index].start + offset;
        if (start < 0 || start >= duration) continue;
        let end = cues[index].end + offset, voiced = end - start;
        for (let next = index + 1; next < cues.length && end - start < 16; next++) {
          const cue = cues[next];
          if (cue.start + offset - end > maxGap) break;
          voiced += cue.end - cue.start; end = cue.end + offset;
        }
        const length = Math.min(20, duration - start, end - start);
        if (length >= 5 && voiced >= minVoiced) {
          const effectiveVoiced = Math.min(voiced, length);
          const density = effectiveVoiced / length;
          const durationScore = Math.min(effectiveVoiced, 16) / 16;
          const introPenalty = start < 2 && cues.length > 2 ? 0.1 : 0;
          list.push({ start, duration: length, cueScore: density * 0.6 + durationScore * 0.4 - introPenalty });
        }
      }
      return list;
    };
    const primaryCandidates = collectCandidates(1, 5);
    const candidates = primaryCandidates.length ? primaryCandidates : collectCandidates(2.5, 3.5);
    if (candidates.length <= 1) return fallback;
    const handle = await fs.open(dialoguePath, 'r');
    try {
      const bytesPerSec = info.sampleRate * info.channels * 2;
      let best = fallback;
      let bestCombined = -Infinity;
      for (const cand of candidates) {
        const byteStart = 44 + Math.max(0, Math.floor(cand.start * bytesPerSec)) & ~1;
        const byteLen = Math.min(16 * bytesPerSec, Math.floor(cand.duration * bytesPerSec)) & ~1;
        if (byteLen < 3200) continue;
        const buf = Buffer.alloc(byteLen);
        const { bytesRead } = await handle.read(buf, 0, byteLen, byteStart);
        if (bytesRead < 3200) continue;
        const view = new DataView(buf.buffer, buf.byteOffset, bytesRead);
        const samples = Math.floor(bytesRead / 2);
        let sumSq = 0;
        let clips = 0;
        for (let i = 0; i < samples; i++) {
          const s = view.getInt16(i * 2, true);
          sumSq += s * s;
          if (Math.abs(s) >= 32500) clips++;
        }
        const rms = Math.sqrt(sumSq / samples);
        const snrScore = rms > 200 ? Math.min(1, Math.log10(rms / 100) / 2) : 0;
        const clipPenalty = (clips / samples) > 0.005 ? 0.3 : 0;
        const combined = cand.cueScore * 0.7 + snrScore * 0.3 - clipPenalty;
        if (combined > bestCombined + 0.02) {
          bestCombined = combined;
          best = { start: cand.start, duration: cand.duration };
        }
      }
      return best;
    } finally {
      await handle.close();
    }
  } catch {
    return fallback;
  }
}
/** Selects a clean 3.1–5.2s single-utterance reference window for local GPT-SoVITS V5.
 * Short single/two-cue references with clean pauses prevent V5 AR prompt-tail leakage and repetition.
 */
export async function selectLocalV5Reference(
  cues: readonly DubbingCue[],
  offset: number,
  duration: number,
  dialoguePath?: string,
): Promise<{ start: number; duration: number; trailingPad: number; cues: DubbingCue[] }> {
  interface Candidate { start: number; duration: number; score: number; cues: DubbingCue[] }
  const terminalRe = /[.!?。！？;；]$/;
  const candidates: Candidate[] = [];
  for (let i = 0; i < cues.length; i++) {
    const start = cues[i].start + offset;
    if (start < 0 || start >= duration) continue;
    const picked: DubbingCue[] = [];
    let end = start;
    let voiced = 0;
    for (let j = i; j < cues.length && j < i + 3; j++) {
      const c = cues[j];
      const cs = c.start + offset;
      const ce = Math.min(duration, c.end + offset);
      if (j > i && cs - end > 0.55) break;
      if (ce - start > 6.2 && picked.length > 0) break;
      picked.push(c);
      voiced += Math.max(0.05, ce - Math.max(start, cs));
      end = ce;
      const span = end - start;
      if (span >= 3.0 && span <= 5.5) {
        const nextCueStart = j + 1 < cues.length ? cues[j + 1].start + offset : duration;
        const postPause = Math.max(0, nextCueStart - end);
        const density = voiced / span;
        const idealLenScore = 1 - Math.min(1, Math.abs(span - 4.0) / 2.5);
        const termBonus = terminalRe.test(c.text.trim()) ? 0.25 : 0;
        const pauseBonus = postPause >= 0.15 ? 0.25 : postPause >= 0.05 ? 0.1 : 0;
        const introPenalty = start < 1.0 && cues.length > 2 ? 0.08 : 0;
        const mixPenalty = /[\u4e00-\u9fff]/.test(picked.map(x => x.text).join('')) && /[A-Za-z]{2,}/.test(picked.map(x => x.text).join('')) ? 0.12 : 0;
        candidates.push({
          start,
          duration: span,
          cues: [...picked],
          score: density * 0.45 + idealLenScore * 0.35 + termBonus + pauseBonus - introPenalty - mixPenalty,
        });
      }
    }
  }
  // Relaxed fallback: accept a single 2.6–6.5s window or combine up to 8.5s
  if (!candidates.length) {
    for (let i = 0; i < cues.length; i++) {
      const start = cues[i].start + offset;
      if (start < 0 || start >= duration) continue;
      const picked: DubbingCue[] = [];
      let end = start;
      for (let j = i; j < cues.length && end - start < 6.5; j++) {
        const c = cues[j];
        const ce = Math.min(duration, c.end + offset);
        if (j > i && c.start + offset - end > 1.5) break;
        picked.push(c);
        end = ce;
        const span = end - start;
        if (span >= 2.6 && span <= 8.5) {
          candidates.push({ start, duration: span, cues: [...picked], score: 1 - Math.abs(span - 4.2) / 6 });
          break;
        }
      }
    }
  }
  if (!candidates.length) {
    const fallback = selectVoiceReference(cues, offset, duration);
    const span = Math.min(5.2, Math.max(3.1, fallback.duration));
    const end = fallback.start + span;
    const refCues = cues.filter(c => c.end + offset > fallback.start && c.start + offset < end);
    return { start: fallback.start, duration: span, trailingPad: 0.25, cues: refCues.length ? refCues : [cues[0]] };
  }
  candidates.sort((a, b) => b.score - a.score);
  let best = candidates[0];
  if (dialoguePath && candidates.length > 1) {
    try {
      const info = await readWavInfo(dialoguePath);
      if (info.bitsPerSample === 16 && info.duration >= 3) {
        const handle = await fs.open(dialoguePath, 'r');
        try {
          const bytesPerSec = info.sampleRate * info.channels * 2;
          let bestCombined = -Infinity;
          for (const cand of candidates.slice(0, 12)) {
            const byteStart = (44 + Math.max(0, Math.floor(cand.start * bytesPerSec))) & ~1;
            const byteLen = Math.min(8 * bytesPerSec, Math.floor(cand.duration * bytesPerSec)) & ~1;
            if (byteLen < 3200) continue;
            const buf = Buffer.alloc(byteLen);
            const { bytesRead } = await handle.read(buf, 0, byteLen, byteStart);
            if (bytesRead < 3200) continue;
            const view = new DataView(buf.buffer, buf.byteOffset, bytesRead);
            const samples = Math.floor(bytesRead / 2);
            const hopSamples = Math.max(1, Math.floor(info.sampleRate * 0.05) * info.channels);
            const frameRms: number[] = [];
            let sumSq = 0;
            let clips = 0;
            let frameSq = 0;
            let frameCount = 0;
            for (let k = 0; k < samples; k++) {
              const s = view.getInt16(k * 2, true);
              sumSq += s * s;
              frameSq += s * s;
              if (++frameCount >= hopSamples) {
                frameRms.push(Math.sqrt(frameSq / frameCount));
                frameSq = 0;
                frameCount = 0;
              }
              if (Math.abs(s) >= 32500) clips++;
            }
            const rms = Math.sqrt(sumSq / samples);
            let contrastScore = 0.5;
            let bgPenalty = 0;
            if (frameRms.length >= 4) {
              frameRms.sort((a, b) => a - b);
              const p15 = frameRms[Math.floor(frameRms.length * 0.15)];
              const p90 = frameRms[Math.min(frameRms.length - 1, Math.floor(frameRms.length * 0.9))];
              const contrastDb = Math.max(0, 20 * Math.log10((p90 + 1) / (p15 + 60)));
              contrastScore = Math.min(1, contrastDb / 24);
              bgPenalty = p15 > 450 ? Math.min(0.45, (p15 - 450) / 3000) : 0;
            }
            const snrScore = rms > 200 ? Math.min(1, Math.log10(rms / 100) / 2) : 0;
            const clipPenalty = (clips / samples) > 0.005 ? 0.3 : 0;
            const combined = cand.score * 0.62 + snrScore * 0.18 + contrastScore * 0.20 - clipPenalty - bgPenalty;
            if (combined > bestCombined) {
              bestCombined = combined;
              best = cand;
            }
          }
        } finally {
          await handle.close();
        }
      }
    } catch { /* Keep text-scored candidate if WAV energy probing fails. */ }
  }
  const pad = Math.max(0.25, Math.min(0.65, 3.3 - best.duration));
  return { start: best.start, duration: best.duration, trailingPad: pad, cues: best.cues };
}

export function normalizeSpeechForLocalV5(text: string, textLang: string): string {
  let out = text
    .replace(/["“”‘’]/g, '')
    .replace(/——|—|–|--/g, ', ')
    .replace(/\.{2,}|…+/g, '.');
  if (textLang === 'en') {
    if (/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/u.test(out)) throw new Error('English dubbing text contains untranslated CJK characters. Correct the translation before generating speech.');
    // Model names commonly use Roman version suffixes. V5 otherwise reads VI as
    // separate V/I letters, which is a genuine pronunciation/content failure.
    const romanVersions: Record<string, string> = { II: 'two', III: 'three', IV: 'four', V: 'five', VI: 'six', VII: 'seven', VIII: 'eight', IX: 'nine', X: 'ten' };
    out = out.replace(/\b([A-Z][A-Z0-9]{1,7})\s+(VIII|VII|III|VI|IV|IX|II|V|X)\b/g, (_, name: string, version: string) => `${name} ${romanVersions[version]}`);
    const smallK: Record<string, string> = { '1': 'one', '2': 'two', '3': 'three', '4': 'four', '5': 'five', '6': 'six', '8': 'eight', '10': 'ten', '12': 'twelve', '16': 'sixteen' };
    out = out.replace(/\b([0-9]+)[Kk]\b/g, (_, n: string) => `${smallK[n] ?? n} K`);
    out = out.replace(/\b([0-9]+)(Hz|fps|ms|GB|TB|MB)\b/gi, '$1 $2');
    out = out
      .replace(/，/g, ', ')
      .replace(/。/g, '. ')
      .replace(/！/g, '! ')
      .replace(/？/g, '? ')
      .replace(/；/g, '; ')
      .replace(/：/g, ': ')
      .replace(/、/g, ', ')
      .replace(/[（）()【】\[\]《》<>]/g, ' ');
  }
  out = out.replace(/\s+([,.!?;:])/g, '$1').replace(/\s+/g, ' ').trim();
  if (out && !/[.!?。！？;；]$/.test(out)) {
    out += textLang === 'zh' || textLang === 'yue' || textLang === 'ja' ? '。' : '.';
  }
  return out;
}

function timestamp(value: number): string {
  const ms = Math.round(value * 1000);
  return `${String(Math.floor(ms / 3600000)).padStart(2, '0')}:${String(Math.floor(ms / 60000) % 60).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`;
}
export function dubbingSrt(cues: readonly DubbingCue[], offset: number): string {
  return cues.map((cue, index) => `${index + 1}\n${timestamp(cue.start + offset)} --> ${timestamp(cue.end + offset)}\n${cue.translated ?? cue.speechText ?? ''}\n${cue.text}\n`).join('\n');
}

export interface DubbingUtteranceGroup {
  cues: DubbingCue[];
  startIndex: number;
  endIndex: number;
  start: number;
  end: number;
  speechText: string;
}

/** Merges fragmented adjacent subtitle cues into Bilibili-style continuous breath-group utterances
 * when pause <= 0.35s and the preceding cue has no terminal sentence punctuation.
 */
export function groupDubbingUtterances(cues: readonly DubbingCue[], targetLanguage = 'en'): DubbingUtteranceGroup[] {
  const isChinese = /^(?:zh|chinese)/i.test(targetLanguage);
  const terminalRe = /[.!?。！？;；…—]$/;
  const groups: DubbingUtteranceGroup[] = [];

  for (let i = 0; i < cues.length; ) {
    const first = cues[i];
    const groupCues: DubbingCue[] = [first];
    let endIdx = i;

    while (endIdx + 1 < cues.length && groupCues.length < 3) {
      const prev = cues[endIdx];
      const next = cues[endIdx + 1];
      const gap = next.start - prev.end;
      const prevHasManualOverride = Boolean(prev.speechText && prev.translated && prev.speechText !== prev.translated);
      const nextHasManualOverride = Boolean(next.speechText && next.translated && next.speechText !== next.translated);
      const prevSpeech = (prev.speechText ?? prev.translated ?? '').trim();
      const nextSpeech = (next.speechText ?? next.translated ?? '').trim();
      const prevSource = prev.text.trim();
      const firstDuration = first.end - first.start;
      const nextDuration = next.end - next.start;
      const prevWords = prevSpeech.split(/\s+/).filter(Boolean).length;
      const nextWords = nextSpeech.split(/\s+/).filter(Boolean).length;
      const prevTiny = isChinese ? prevSpeech.replace(/[^\u4e00-\u9fffA-Za-z0-9]/g, '').length <= 3 : prevWords <= 2;
      const nextTiny = isChinese ? nextSpeech.replace(/[^\u4e00-\u9fffA-Za-z0-9]/g, '').length <= 3 : nextWords <= 2;
      const fillerRe = /^(?:uh+|um+|er+|ah+|oh+|hmm+|mm+|mhm|eh+|ooh+|ugh|phew)[.!?]*$/i;
      const fillerMerge = !isChinese && (fillerRe.test(prevSpeech) || fillerRe.test(nextSpeech)) && gap <= 0.9;
      const incompletePrev = !terminalRe.test(prevSource) && (!terminalRe.test(prevSpeech) || nextDuration < 0.8);
      const tinyFollowing = (nextDuration < 0.5 || nextTiny) && gap <= 0.55;
      const tinyLeading = groupCues.length === 1 && (firstDuration < 0.5 || prevTiny) && gap <= 0.55;
      if (
        (gap > 0.55 && !fillerMerge) ||
        (gap > 0.35 && !tinyFollowing && !tinyLeading && !fillerMerge) ||
        prevHasManualOverride ||
        nextHasManualOverride ||
        (!incompletePrev && !tinyFollowing && !tinyLeading && !fillerMerge) ||
        next.end - first.start > 12 ||
        prevSpeech.length + nextSpeech.length > 320
      ) {
        break;
      }
      groupCues.push(next);
      endIdx++;
    }

    const combinedText = groupCues
      .map(c => (c.speechText ?? c.translated ?? '').trim())
      .reduce((acc, part, idx) => {
        if (idx === 0) return part;
        if (isChinese) {
          return /[,，、—]$/.test(acc) ? `${acc}${part}` : `${acc}，${part}`;
        }
        return `${acc.replace(/[,，]+$/, '')} ${part}`;
      }, '');

    groups.push({
      cues: groupCues,
      startIndex: i,
      endIndex: endIdx,
      start: first.start,
      end: groupCues[groupCues.length - 1].end,
      speechText: combinedText,
    });
    i = endIdx + 1;
  }
  return groups;
}
async function digestFile(file: string, signal: AbortSignal): Promise<string> {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(file, { signal })) { signal.throwIfAborted(); digest.update(chunk); }
  return digest.digest('hex');
}
async function jsonFile(file: string): Promise<unknown> {
  try { const info = await fs.stat(file); if (info.size > 2_000_000) throw new Error('Dubbing metadata is too large.'); return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}
async function saveJson(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomUUID()}.tmp`;
  try { await fs.writeFile(temp, JSON.stringify(value), { flag: 'wx', mode: 0o600 }); await fs.rename(temp, file); }
  finally { await fs.rm(temp, { force: true }); }
}
interface ManagedVoice { voiceId: string; baseUrl: string; account: string; reference: string }
export interface DubbingDependencies {
  detect: typeof detectSeparationEnvironment;
  separate: typeof separateAudio;
  extract: typeof extractAudio;
  reference: typeof extractVoiceReference;
  localReference?: typeof extractLocalVoiceReference;
  align: typeof alignAudio;
  mix: typeof mixDubbedVideo;
  process: typeof runAudioProcess;
  client: (credentials: { baseUrl: string; apiKey: string }) => Pick<QwenDubbingClient, 'createVoice' | 'queryVoice' | 'synthesize' | 'deleteVoice'>;
}
interface DubbingServiceOptions {
  directory: string;
  ffmpegPath: string;
  helperPath: string;
  tts: Pick<TtsService, 'withDubbingContext'> & { dubbingContextInfo?: () => Promise<{ providerName: string; baseUrl: string; hasApiKey: boolean; model?: string; mode?: InferenceMode }> };
  translation: Pick<TranslationService, 'getConfig' | 'translate' | 'summarize'>;
  emit: (progress: DubbingProgress) => void;
  localPlugins?: LocalPluginManager;
}

function toV5Lang(lang: string, fallbackText = ''): 'zh' | 'en' | 'ja' | 'yue' | 'ko' {
  const norm = lang.trim().toLowerCase();
  if (norm === 'yue' || norm === 'cantonese') return 'yue';
  if (/^(zh|chinese)/.test(norm)) return 'zh';
  if (/^(en|english)/.test(norm)) return 'en';
  if (/^(ja|japanese)/.test(norm)) return 'ja';
  if (/^(ko|korean)/.test(norm)) return 'ko';
  if (/[\u3040-\u30ff]/.test(fallbackText)) return 'ja';
  if (/[\uac00-\ud7af]/.test(fallbackText)) return 'ko';
  if (/[\u4e00-\u9fff]/.test(fallbackText)) return 'zh';
  return 'en';
}

function estimateExpectedSpeechSec(text: string, textLang: string): number {
  const clean = text.trim();
  if (!clean) return 0;
  if (textLang === 'en') {
    const words = clean.match(/[A-Za-z0-9']+/g) ?? [];
    const punct = (clean.match(/[,.;:!?]/g) ?? []).length;
    return words.length * 0.36 + punct * 0.08;
  }
  const cjk = (clean.match(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g) ?? []).length;
  const latin = (clean.match(/[A-Za-z0-9]+/g) ?? []).length;
  return (cjk + latin * 2) * 0.22;
}

async function measureWavNoiseFloor(filePath: string): Promise<number> {
  try {
    const info = await readWavInfo(filePath);
    if (info.bitsPerSample !== 16 || info.duration < 0.2) return 0;
    const raw = await fs.readFile(filePath);
    if (raw.byteLength <= 44) return 0;
    const frameBytes = info.channels * 2;
    const totalFrames = Math.floor((raw.byteLength - 44) / frameBytes);
    const hop = Math.max(1, Math.floor(info.sampleRate * 0.05));
    const view = new DataView(raw.buffer, raw.byteOffset + 44, totalFrames * frameBytes);
    const rmsValues: number[] = [];
    for (let start = 0; start + hop <= totalFrames; start += hop) {
      let sumSq = 0;
      for (let f = 0; f < hop; f++) {
        const s = view.getInt16(((start + f) * info.channels) * 2, true) / 32768;
        sumSq += s * s;
      }
      rmsValues.push(Math.sqrt(sumSq / hop));
    }
    if (rmsValues.length < 4) return 0;
    // Exclude final 100ms in case trailing silence padding skews the percentile.
    const activeSlice = rmsValues.slice(0, Math.max(4, rmsValues.length - 2));
    activeSlice.sort((a, b) => a - b);
    return activeSlice[Math.floor(activeSlice.length * 0.15)];
  } catch {
    return 0;
  }
}

function splitForLocalV5(text: string, maxChars = 480): string[] {
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) return [trimmed];
  const parts: string[] = [];
  let rest = trimmed;
  while (rest.length > maxChars) {
    let split = rest.lastIndexOf(' ', maxChars);
    if (split < maxChars * 0.5) split = maxChars;
    parts.push(rest.slice(0, split).trim());
    rest = rest.slice(split).trim();
  }
  if (rest) parts.push(rest);
  return parts.filter(Boolean);
}

/** Keeps a small rolling sample of rejected audio outside the reusable speech cache. */
export async function preserveRejectedSpeech(file: string, metadata: Record<string, unknown>): Promise<void> {
  const dir = path.join(path.dirname(file), 'rejected-speech');
  await fs.mkdir(dir, { recursive: true });
  const id = `${Date.now()}-${randomUUID()}`;
  const wav = path.join(dir, `${id}.wav`);
  const info = await fs.stat(file);
  // Runaway audio may be very large; retain its diagnosis, not an unbounded WAV.
  if (info.size <= 10 * 1024 * 1024) await fs.rename(file, wav);
  else await fs.rm(file, { force: true });
  await fs.writeFile(path.join(dir, `${id}.json`), JSON.stringify({ ...metadata, audioBytes: info.size, audioRetained: info.size <= 10 * 1024 * 1024 }, null, 2));
  const records = (await fs.readdir(dir)).filter(name => name.endsWith('.json')).sort().reverse();
  let bytes = 0;
  for (let i = 0; i < records.length; i++) {
    const json = path.join(dir, records[i]), audio = json.replace(/\.json$/, '.wav');
    const size = await fs.stat(audio).then(s => s.size, () => 0);
    bytes += size;
    if (i >= 12 || bytes > 64 * 1024 * 1024) {
      await fs.rm(audio, { force: true });
      await fs.rm(json, { force: true });
    }
  }
}

/** One active job owns all input files, children, cloud calls and output publication. */
export class DubbingService {
  private active?: { id: string; controller: AbortController };
  private maintenance = false;
  private settings?: DubbingSettings;
  private pending: Promise<unknown> = Promise.resolve();
  private readonly deps: DubbingDependencies;
  constructor(private readonly options: DubbingServiceOptions, dependencies: Partial<DubbingDependencies> = {}) {
    this.deps = { detect: detectSeparationEnvironment, separate: separateAudio, extract: extractAudio, reference: extractVoiceReference,
      localReference: dependencies.localReference ?? (dependencies.reference ? undefined : extractLocalVoiceReference),
      align: alignAudio, mix: mixDubbedVideo, process: runAudioProcess, client: credentials => new QwenDubbingClient(credentials), ...dependencies };
  }
  get busy(): boolean { return !!this.active || this.maintenance; }
  cancel(jobId?: string): void { if (this.active && (jobId === undefined || this.active.id === jobId)) this.active.controller.abort(); }
  private get root(): string { return path.join(this.options.directory, 'cache'); }
  async getConfig(): Promise<DubbingConfig> {
    await this.pending;
    if (!this.settings) this.settings = validateDubbingSettings(await jsonFile(path.join(this.options.directory, 'settings.json')) ?? defaultDubbingSettings);
    let ttsInfo: { providerName?: string; baseUrl?: string; hasApiKey?: boolean; model?: string } = {};
    if (typeof this.options.tts.dubbingContextInfo === 'function') {
      try { ttsInfo = await this.options.tts.dubbingContextInfo(); } catch {}
    }
    const resolvedBaseUrl = this.settings.baseUrl || ttsInfo.baseUrl || 'https://dashscope.aliyuncs.com/api/v1';
    const resolvedModel = this.settings.model ?? (ttsInfo.model && (SUPPORTED_DUBBING_MODELS as readonly string[]).includes(ttsInfo.model) ? ttsInfo.model as DubbingModel : DEFAULT_DUBBING_MODEL);
    return {
      model: resolvedModel,
      settings: { ...this.settings, baseUrl: this.settings.baseUrl || resolvedBaseUrl, model: this.settings.model ?? resolvedModel },
      voices: (await this.voices()).map(({ voiceId, baseUrl }) => ({ voiceId, baseUrl })),
      ttsProviderName: ttsInfo.providerName,
      hasTtsApiKey: ttsInfo.hasApiKey,
    };
  }
  saveConfig(input: DubbingSettings): Promise<DubbingConfig> {
    if (this.busy) return Promise.reject(new Error('Stop dubbing before changing settings.'));
    const validated = validateDubbingSettings(input);
    const operation = this.pending.then(async () => {
      if (this.busy) throw new Error('Stop dubbing before changing settings.');
      await saveJson(path.join(this.options.directory, 'settings.json'), validated); this.settings = validated;
      return { model: validated.model ?? DEFAULT_DUBBING_MODEL, settings: { ...validated }, voices: (await this.voices()).map(({ voiceId, baseUrl }) => ({ voiceId, baseUrl })) };
    });
    this.pending = operation.then(() => {}, () => {});
    return operation;
  }
  private separation(settings: DubbingSettings, signal?: AbortSignal): SeparationOptions {
    return { ffmpegPath: this.options.ffmpegPath, helperPath: this.options.helperPath, pythonPath: settings.pythonPath, modelPath: settings.modelFile, device: 'auto', signal };
  }
  private async resolveBuiltinRoformer(signal?: AbortSignal): Promise<Omit<RoformerSeparationOptions, 'ffmpegPath' | 'signal'> | undefined> {
    if (this.options.ffmpegPath === 'offline-ffmpeg' || this.options.helperPath === 'offline-helper') return undefined;
    const pluginsDir = this.options.localPlugins?.pluginsDir ?? path.resolve(path.dirname(this.options.helperPath), '..', 'plugins');
    const pythonPath = process.platform === 'win32'
      ? path.join(pluginsDir, 'voice-clone', '.venv', 'Scripts', 'python.exe')
      : path.join(pluginsDir, 'voice-clone', '.venv', 'bin', 'python');
    const helperCandidates = [
      path.join(path.dirname(this.options.helperPath), 'roformer-separation.py'),
      path.resolve(pluginsDir, '..', 'scripts', 'roformer-separation.py'),
    ];
    let helperPath = '';
    for (const cand of helperCandidates) {
      try { if ((await fs.stat(cand)).isFile()) { helperPath = cand; break; } } catch {}
    }
    if (!helperPath) return undefined;
    const modelDir = path.join(pluginsDir, 'separation', 'models', 'karaoke-bs-roformer');
    const modelPath = path.join(modelDir, 'karaoke_bs_roformer_anvuew.ckpt');
    const configPath = path.join(modelDir, 'karaoke_bs_roformer_anvuew.yaml');
    const uvr5Dir = path.join(pluginsDir, 'voice-clone', 'upstream', 'tools', 'uvr5');
    try {
      const checks = await Promise.all([
        fs.stat(pythonPath),
        fs.stat(modelPath),
        fs.stat(configPath),
        fs.stat(path.join(uvr5Dir, 'bsroformer.py')),
      ]);
      if (checks.every(s => s.isFile())) {
        return { pythonPath, helperPath, modelPath, configPath, uvr5Dir, pluginsDir, device: 'auto' };
      }
    } catch {}
    void signal;
    return undefined;
  }
  async check(): Promise<DubbingEnvironment> {
    const { settings } = await this.getConfig();
    const effectiveBaseUrl = settings.baseUrl || 'https://dashscope.aliyuncs.com/api/v1';
    if (!settings.modelFile) {
      const builtin = await this.resolveBuiltinRoformer();
      if (builtin) {
        return {
          ready: false,
          builtinSeparationReady: true,
          message: 'Built-in Karaoke BS-RoFormer vocal separation is ready (removes spoken dialogue while preserving BGM & singing vocals).',
        };
      }
      return { ready: false, message: 'Configure an already downloaded local separation model. No automatic installation or download is performed.' };
    }
    const environment = await this.deps.detect(this.separation({ ...settings, baseUrl: effectiveBaseUrl }));
    return { ready: environment.ready, message: environment.diagnostics.join('\n') || 'Local separation environment is ready. Cloud permissions and voice quality still require an authorized test.' };
  }
  /** Prepares separation cache before ASR. A real model supplies isolated vocals;
   * without one, ASR/reference uses the source mix and dubbing uses a silent background.
   */
  async prepareVocals(filePath: string, signal?: AbortSignal): Promise<string | undefined> {
    if (this.busy) return undefined;
    try {
      const { settings } = await this.getConfig();
      const source = await localFile(filePath);
      const activeModel = settings.model ?? DEFAULT_DUBBING_MODEL;
      const abortSignal = signal ?? new AbortController().signal;
      let useUvr = false;
      if (settings.modelFile) {
        const environment = await this.deps.detect(this.separation(settings, signal));
        useUvr = environment.ready;
      }
      const roformerSpec = !useUvr && !settings.modelFile ? await this.resolveBuiltinRoformer(signal) : undefined;
      const modelDigest = useUvr && settings.modelFile
        ? await digestFile(settings.modelFile, abortSignal)
        : roformerSpec
          ? 'roformer-karaoke-bs-v1'
          : 'ffmpeg-silent-background-v1';
      const mediaKey = hash(['dubbing-v1', activeModel, await digestFile(source, abortSignal), modelDigest, false]);
      const mediaDir = path.join(this.root, mediaKey);
      await fs.mkdir(mediaDir, { recursive: true, mode: 0o700 });
      const audioOptions = { ffmpegPath: this.options.ffmpegPath, signal };
      const extracted = path.join(mediaDir, 'source.wav');
      let duration: number;
      try { duration = (await readWavInfo(extracted)).duration; }
      catch { await fs.rm(extracted, { force: true }); duration = (await this.deps.extract(source, extracted, audioOptions)).duration; }
      if (duration > 21600 || duration < 5) return undefined;
      const separationDir = path.join(mediaDir, 'stems');
      const dialogue = path.join(separationDir, 'dialogue.wav'), background = path.join(separationDir, 'background.wav');
      try {
        for (const file of [dialogue, background]) if (Math.abs((await readWavInfo(file)).duration - duration) > 0.05) throw new Error('Stale separation cache.');
        return dialogue;
      } catch {
        await fs.rm(separationDir, { recursive: true, force: true });
        if (useUvr) {
          return (await this.deps.separate(extracted, separationDir, this.separation(settings, signal))).dialoguePath;
        }
        if (roformerSpec) {
          if (this.options.localPlugins) await this.options.localPlugins.stop().catch(() => {});
          return (await separateAudioRoformer(extracted, separationDir, { ...audioOptions, ...roformerSpec })).dialoguePath;
        }
        return (await separateAudioFfmpegFallback(extracted, separationDir, audioOptions)).dialoguePath;
      }
    } catch {
      return undefined;
    }
  }
  async clearCache(): Promise<void> {
    if (this.busy) throw new Error('Stop dubbing before clearing its cache.');
    this.maintenance = true;
    try { await fs.rm(this.root, { recursive: true, force: true }); }
    finally { this.maintenance = false; }
  }
  private async voices(): Promise<ManagedVoice[]> {
    const value = await jsonFile(path.join(this.options.directory, 'voices.json'));
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.length > 1000 || value.some(item => !object(item) || !validString(item.voiceId) || !validString(item.baseUrl) || !validString(item.account) || !validString(item.reference))) throw new Error('Invalid saved dubbing voice registry.');
    return value as ManagedVoice[];
  }
  async deleteVoice(voiceId: string): Promise<void> {
    if (this.busy) throw new Error('Stop dubbing before deleting a voice.');
    if (!validString(voiceId, 256)) throw new Error('Invalid voice ID.');
    this.maintenance = true;
    try {
      const voices = await this.voices(), record = voices.find(item => item.voiceId === voiceId);
      if (!record) throw new Error('Only voices registered by this application can be deleted here.');
      await this.options.tts.withDubbingContext(async context => {
        if (hash(context.apiKey) !== record.account) throw new Error('Use the original TTS credentials to delete this voice.');
        await this.deps.client({ ...context, baseUrl: record.baseUrl }).deleteVoice(voiceId);
      });
      await saveJson(path.join(this.options.directory, 'voices.json'), voices.filter(item => item.voiceId !== voiceId));
    } finally { this.maintenance = false; }
  }
  async run(input: DubbingRequest): Promise<DubbingResult> {
    const request = validateDubbingRequest(input);
    if (this.busy) throw new Error('Dubbing is already in progress.');
    const job = { id: request.jobId, controller: new AbortController() };
    this.active = job;
    const signal = job.controller.signal;
    let timedOut = false;
    const deadline = setTimeout(() => { timedOut = true; job.controller.abort(); }, 12 * 60 * 60 * 1000);
    deadline.unref();
    const progress = (stage: DubbingProgress['stage'], completed: number, total: number, message: string) => {
      signal.throwIfAborted(); this.options.emit({ jobId: job.id, stage, completed, total, message });
    };
    let work = '';
    try {
      const { settings } = await this.getConfig();
      const ttsSelection = typeof this.options.tts.dubbingContextInfo === 'function'
        ? await this.options.tts.dubbingContextInfo()
        : undefined;
      const useLocalVoiceClone = ttsSelection?.mode === 'local';
      if (useLocalVoiceClone && !this.options.localPlugins) {
        throw new Error('当前后端未启用本地模型插件管理器。 / Local plugin manager is unavailable.');
      }
      let activeBaseUrl = useLocalVoiceClone ? 'http://127.0.0.1:9873' : normalizeQwenDubbingBaseUrl(settings.baseUrl || 'https://dashscope.aliyuncs.com/api/v1');
      let activeModel = settings.model ?? DEFAULT_DUBBING_MODEL;
      if (!useLocalVoiceClone) {
        if (request.useTtsConfig) {
          if (!ttsSelection) throw new Error('当前后端无法读取 TTS 配置，请更新并重启应用。 / Update the backend to use saved TTS settings.');
          if (!ttsSelection.hasApiKey) throw new Error('请先在「设置 → 视频配音服务」保存接口地址和 API Key。 / Save the TTS endpoint and API key before dubbing.');
          activeBaseUrl = normalizeQwenDubbingBaseUrl(ttsSelection.baseUrl);
          if (!ttsSelection.model || !(SUPPORTED_DUBBING_MODELS as readonly string[]).includes(ttsSelection.model)) throw new Error('请选择支持的配音模型；Token Plan 请按订阅权限选择 qwen-audio-3.0-tts-plus。 / Select a supported dubbing model in TTS settings.');
          activeModel = ttsSelection.model as DubbingModel;
        }
        new QwenDubbingClient({ baseUrl: activeBaseUrl, apiKey: 'configuration-check', model: activeModel });
      }
      progress('preparing', 0, 1, 'Checking local separation environment.');
      let useUvr = false;
      if (settings.modelFile) {
        const environment = await this.deps.detect(this.separation(settings, signal));
        if (!environment.ready) throw new Error(environment.diagnostics.join('\n'));
        useUvr = true;
      }
      const roformerSpec = !useUvr && !settings.modelFile ? await this.resolveBuiltinRoformer(signal) : undefined;
      const hasSeparation = useUvr || Boolean(roformerSpec);
      const source = await localFile(request.file);
      const config = await this.options.translation.getConfig(), fingerprint = JSON.stringify(config.settings);
      const targetLanguage = config.settings.targetLanguage;
      if (!/^(zh|en)(?:[-_].*)?$|^(chinese|english)$/i.test(targetLanguage)) throw new Error('The first dubbing version supports Chinese and English. Set the target language in translation settings.');
      const ensureTranslation = async () => {
        signal.throwIfAborted();
        if (JSON.stringify((await this.options.translation.getConfig()).settings) !== fingerprint) throw new Error('Translation settings changed. Restart dubbing to keep the output language consistent.');
      };
      const modelDigest = useUvr && settings.modelFile
        ? await digestFile(settings.modelFile, signal)
        : roformerSpec
          ? 'roformer-karaoke-bs-v1'
          : 'ffmpeg-silent-background-v1';
      const mediaKey = hash(['dubbing-v1', activeModel, await digestFile(source, signal), modelDigest, request.preview]);
      const mediaDir = path.join(this.root, mediaKey);
      await fs.mkdir(mediaDir, { recursive: true, mode: 0o700 });
      work = await fs.mkdtemp(path.join(mediaDir, '.job-'));
      const audioOptions = { ffmpegPath: this.options.ffmpegPath, signal };
      let video = source;
      if (request.preview) {
        video = path.join(work, 'preview.mkv');
        await this.deps.process(this.options.ffmpegPath, [...ffmpegBase, '-i', source, '-t', '30', '-map', '0:v:0', '-map', '0:a:0', '-c:v', 'copy', '-c:a', 'pcm_s16le', '-f', 'matroska', video], audioOptions);
      }
      const extracted = path.join(mediaDir, 'source.wav');
      let duration: number;
      try { duration = (await readWavInfo(extracted)).duration; }
      catch { await fs.rm(extracted, { force: true }); duration = (await this.deps.extract(video, extracted, audioOptions)).duration; }
      if (duration > 21600 || duration < 5) throw new Error('Choose a video between 5 seconds and 6 hours.');
      const disk = await fs.statfs(mediaDir, { bigint: true });
      const required = BigInt(Math.ceil(duration * 48000 * 4)) * 4n + 32n * 1024n * 1024n;
      if (disk.bavail * disk.bsize < required) throw new Error(`Insufficient working disk space. Dubbing needs approximately ${Math.ceil(Number(required) / 1024 ** 3)} GiB of free space for PCM stems and mixing. Clear old caches or use a shorter video.`);
      if (request.preview) duration = Math.min(duration, 30);
      let cues = request.cues.filter(cue => !request.preview || cue.end + request.offset <= duration).map(cue => ({ ...cue }));
      if (!cues.length || cues.some(cue => cue.end + request.offset > duration + 0.01)) throw new Error('Subtitle timing is outside the audio duration. Check subtitle delay. Preview requires at least one complete cue in the first 30 seconds.');
      const separationDir = path.join(mediaDir, 'stems');
      let dialogue = path.join(separationDir, 'dialogue.wav'), background = path.join(separationDir, 'background.wav');
      progress('separating', 0, 1, useUvr
        ? 'Separating dialogue and background locally; this can take several minutes.'
        : roformerSpec
          ? 'Separating dialogue from BGM with Karaoke BS-RoFormer (preserving singing BGM); this can take 1–2 minutes.'
          : 'No separation model available: muting original audio to prevent speech leakage. Original music is not preserved; source audio is retained for voice reference.');
      try {
        for (const file of [dialogue, background]) if (Math.abs((await readWavInfo(file)).duration - duration) > 0.05) throw new Error('Stale separation cache.');
      } catch {
        await fs.rm(separationDir, { recursive: true, force: true });
        if (useUvr) {
          const stems = await this.deps.separate(extracted, separationDir, this.separation(settings, signal));
          dialogue = stems.dialoguePath; background = stems.backgroundPath;
        } else if (roformerSpec) {
          if (this.options.localPlugins) await this.options.localPlugins.stop().catch(() => {});
          const stems = await separateAudioRoformer(extracted, separationDir, { ...audioOptions, ...roformerSpec });
          dialogue = stems.dialoguePath; background = stems.backgroundPath;
        } else {
          const stems = await separateAudioFfmpegFallback(extracted, separationDir, audioOptions);
          dialogue = stems.dialoguePath; background = stems.backgroundPath;
        }
      }
      if (roformerSpec) {
        background = await buildSmartBackground(extracted, background, path.join(work, 'smart-background.wav'), cues, request.offset, duration);
      }
      const cloudReference = useLocalVoiceClone ? undefined : await selectCleanestVoiceReference(cues, request.offset, duration, dialogue);
      progress('translating', 0, cues.length, 'Preparing spoken translations from the current subtitle snapshot.');
      let translationMemory: TranslationMemoryState = { memory: { summary: '', terms: [] }, through: 0 };
      for (let index = 0; index < cues.length; ) {
        if (cues[index].translated || cues[index].speechText) { index++; continue; }
        const start = index;
        let characters = 0;
        while (index < cues.length && !cues[index].translated && !cues[index].speechText && index - start < 30 && characters + cues[index].text.length <= 8000) {
          characters += cues[index].text.length;
          index++;
        }
        const batch = cues.slice(start, index);
        await ensureTranslation();
        translationMemory = await advanceTranslationMemory(cues, start, translationMemory, async request => {
          signal.throwIfAborted();
          progress('translating', start, cues.length, 'Summarizing earlier dialogue and updating terminology.');
          return this.options.translation.summarize(request, signal);
        });
        const { context, lookahead } = translationWindow(cues, start, index);
        const translations = await this.options.translation.translate({
          memory: translationMemory.memory,
          texts: batch.map(cue => cue.text),
          ...(context.length ? { context } : {}),
          ...(lookahead.length ? { lookahead } : {}),
        }, signal, batch.map(cue => cue.end - cue.start));
        if (translations.length !== batch.length || translations.some(text => !text?.trim())) throw new Error('Translation returned incomplete dubbing text.');
        batch.forEach((cue, n) => { cue.translated = translations[n]; });
      }
      cues = cues.map(cue => ({ ...cue, speechText: cue.speechText ?? cue.translated }));
      if (cues.some(cue => !validString(cue.speechText))) throw new Error('Every cue must have a nonempty spoken translation (maximum 4096 characters).');
      await ensureTranslation();
      if (useLocalVoiceClone) {
        const localPlugins = this.options.localPlugins!;
        const refsDir = localPlugins.referencesDir();
        await fs.mkdir(refsDir, { recursive: true });
        const refFilename = `lingvoice-ref-${job.id}.wav`;
        const localRefFile = path.join(refsDir, refFilename);
        const targetRefFilename = `lingvoice-target-ref-${job.id}.wav`;
        const targetRefFile = path.join(refsDir, targetRefFilename);
        const localRef = await selectLocalV5Reference(cues, request.offset, duration, dialogue);
        let promptText = (localRef.cues.map(c => c.text.trim()).filter(Boolean).join(' ') || cues[0]?.text || 'Reference speech')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 500)
          .replace(/[\ud800-\udbff]$/, '')
          .trim() || 'Reference speech';
        try {
          if (this.deps.localReference) {
            await this.deps.localReference(dialogue, localRefFile, localRef.start, localRef.duration, localRef.trailingPad, { ...audioOptions, denoise: !hasSeparation });
          } else {
            await this.deps.reference(dialogue, localRefFile, localRef.start, Math.max(5, localRef.duration), audioOptions);
          }
          const refDigest = await digestFile(localRefFile, signal);
          const promptLang = toV5Lang(config.settings.sourceLanguage, promptText);
          if (promptText && !/[.!?。！？;；]$/.test(promptText)) {
            promptText += promptLang === 'zh' || promptLang === 'yue' || promptLang === 'ja' ? '。' : '.';
          }
          let activeRefFilename = refFilename, activeRefDigest = refDigest;
          let activePromptText = promptText, activePromptLang = promptLang;
          const textLang = toV5Lang(targetLanguage, cues[0]?.speechText ?? '');
          progress('voice', 0, 1, 'Starting local GPT-SoVITS V5 voice cloning service.');
          await localPlugins.ensureRunning('voice-clone', signal);
          const segments: AudioSegment[] = [];
          const groups = groupDubbingUtterances(cues, targetLanguage);
          const synthesizeLocal = async (speech: string, speedFactor: number, seed: number, gIndex: number, tag: string): Promise<string> => {
            const key = hash(['local-v5turbo-v5-clean-v3', activeRefDigest, activePromptText, activePromptLang, speech, textLang, speedFactor, seed, 'wav']);
            const out = path.join(mediaDir, `speech-${key}.wav`);
            try {
              await readWavInfo(out);
              return out;
            } catch {}
            const chunks = splitForLocalV5(speech);
            const wavBuffers: Buffer[] = [];
            for (const chunkText of chunks) {
              if (!/[\p{L}\p{N}]/u.test(chunkText)) continue;
              const wavBuf = await localPlugins.requestAudio('voice-clone', '/tts', {
                text: chunkText,
                text_lang: textLang,
                ref_audio_path: activeRefFilename,
                prompt_text: activePromptText,
                prompt_lang: activePromptLang,
                consent: true,
                speed_factor: speedFactor,
                seed,
              }, signal);
              wavBuffers.push(wavBuf);
            }
            if (!wavBuffers.length) return '';
            if (wavBuffers.length === 1) {
              await fs.writeFile(out, wavBuffers[0]);
            } else {
              const listFile = path.join(work, `concat-${gIndex}-${tag}.txt`);
              const partFiles: string[] = [];
              for (let p = 0; p < wavBuffers.length; p++) {
                const pf = path.join(work, `part-${gIndex}-${tag}-${p}.wav`);
                await fs.writeFile(pf, wavBuffers[p]);
                partFiles.push(`file '${pf.replace(/'/g, "'\\''")}'`);
              }
              await fs.writeFile(listFile, partFiles.join('\n'), 'utf8');
              await this.deps.process(this.options.ffmpegPath, [...ffmpegBase, '-f', 'concat', '-safe', '0', '-i', listFile, '-c:a', 'pcm_s16le', out], audioOptions);
            }
            return out;
          };
          const measuredDurations = new Map<string, number | undefined>();
          const measureActiveDuration = async (filePath: string): Promise<number | undefined> => {
            if (measuredDurations.has(filePath)) return measuredDurations.get(filePath);
            try {
              const info = await readWavInfo(filePath);
              const trim = await detectWavTrimBounds(filePath, info);
              const result = trim ? trim.trimmedDuration : info.duration;
              measuredDurations.set(filePath, result);
              return result;
            } catch {
              measuredDurations.set(filePath, undefined);
              return undefined;
            }
          };
          const computeSlotWindow = (gIndex: number, prevEnd: number, activeDur: number | undefined): { slotStart: number; slotEnd: number } | undefined => {
            const group = groups[gIndex];
            const origStart = Math.max(prevEnd, group.start + request.offset);
            if (origStart >= duration - 0.01) return undefined;
            const origEnd = Math.min(duration, Math.max(origStart + 0.05, group.end + request.offset));
            if (origEnd <= origStart) return undefined;
            const nextStart = gIndex + 1 < groups.length ? Math.min(duration, Math.max(origEnd, groups[gIndex + 1].start + request.offset)) : duration;
            let slotStart = origStart;
            let slotEnd = origEnd;
            if (activeDur) {
              if (nextStart > slotEnd && activeDur > slotEnd - slotStart) {
                slotEnd = Math.min(nextStart, Math.max(slotEnd, slotStart + activeDur));
              }
              if (activeDur > slotEnd - slotStart && prevEnd < slotStart) {
                const needed = activeDur - (slotEnd - slotStart);
                slotStart = Math.max(prevEnd, slotStart - needed);
              }
              slotEnd = Math.min(duration, slotEnd);
              slotStart = Math.max(prevEnd, Math.min(slotStart, slotEnd - 0.01));
            }
            return { slotStart, slotEnd };
          };
          const maybeUpdateReferences = async (generated: string, normalizedSpeech: string, startIndex: number): Promise<void> => {
            const info = await readWavInfo(generated);
            if (info.duration < 2.5 || info.duration > 9.5 || normalizedSpeech.length > 500) return;
            if (activePromptLang !== textLang && activeRefFilename === refFilename && this.deps.localReference) {
              const noiseFloor = await measureWavNoiseFloor(generated);
              if (noiseFloor > 0.018) return;
              await this.deps.localReference(generated, targetRefFile, 0, info.duration, 0.25, audioOptions);
              activeRefFilename = targetRefFilename;
              activeRefDigest = await digestFile(targetRefFile, signal);
              activePromptText = normalizedSpeech;
              activePromptLang = textLang;
              progress('voice', startIndex, cues.length, 'Using target-language speech as the voice reference to avoid source-language continuation.');
            }
          };
          let prevAlignedEnd = 0;
          const alignGroup = async (gIndex: number, initialGenerated: string, normalizedSpeech: string): Promise<void> => {
            const group = groups[gIndex];
            const primaryCue = group.cues[0];
            const label = group.cues.length > 1 ? `cues ${primaryCue.id}–${group.cues[group.cues.length - 1].id}` : `cue ${primaryCue.id}`;
            let generated = initialGenerated;
            if (!generated) return;
            progress('aligning', group.startIndex, cues.length, `Aligning ${label} to its original time slot.`);
            const window = computeSlotWindow(gIndex, prevAlignedEnd, undefined);
            if (!window) return;
            let { slotStart, slotEnd } = window;
            const computeSlot = (dur: number | undefined) => {
              const nextWindow = computeSlotWindow(gIndex, prevAlignedEnd, dur);
              if (nextWindow) {
                slotStart = nextWindow.slotStart;
                slotEnd = nextWindow.slotEnd;
              }
            };
            let activeDur = await measureActiveDuration(generated);
            computeSlot(activeDur);
            if (activeDur && activeDur > (slotEnd - slotStart) * 1.18) {
              const slotLen = Math.max(0.2, slotEnd - slotStart);
              const retrySpeed = Math.min(1.25, Math.max(1.06, Number((activeDur / (slotLen * 1.08)).toFixed(2))));
              const faster = await synthesizeLocal(normalizedSpeech, retrySpeed, 42, gIndex, 'fast').catch(() => '');
              if (faster) {
                const fasterDur = await measureActiveDuration(faster);
                if (fasterDur && fasterDur < activeDur) {
                  generated = faster;
                  activeDur = fasterDur;
                  computeSlot(activeDur);
                }
              }
              // Guard against V5 autoregressive EOS runaway (e.g. > 6s and > 2.4x slot): retry with alternate seeds.
              for (const altSeed of [123, 7]) {
                if (!activeDur || activeDur <= Math.max(6, (slotEnd - slotStart) * 2.4)) break;
                const alt = await synthesizeLocal(normalizedSpeech, 1.25, altSeed, gIndex, `seed${altSeed}`).catch(() => '');
                if (alt) {
                  const altDur = await measureActiveDuration(alt);
                  if (altDur && altDur < activeDur) {
                    generated = alt;
                    activeDur = altDur;
                    computeSlot(activeDur);
                  }
                }
              }
            }
            const aligned = await this.deps.align({ filePath: generated, start: slotStart, end: slotEnd }, path.join(work, `aligned-${gIndex}.wav`), { ...audioOptions, maxTempo: 8 });
            prevAlignedEnd = aligned.end;
            segments.push(aligned);
          };

          // Phase 1: Bootstrap a clean target-language reference (normally just utterance 1)
          // before batch-synthesizing remaining utterances without per-line model swapping.
          let batchStart = 0;
          while (batchStart < groups.length && activePromptLang !== textLang && activeRefFilename === refFilename && this.deps.localReference) {
            await ensureTranslation();
            const gIndex = batchStart++;
            const group = groups[gIndex];
            const primaryCue = group.cues[0];
            const label = group.cues.length > 1 ? `cues ${primaryCue.id}–${group.cues[group.cues.length - 1].id}` : `cue ${primaryCue.id}`;
            const normalizedSpeech = normalizeSpeechForLocalV5(group.speechText, textLang);
            if (!/[\p{L}\p{N}]/u.test(normalizedSpeech)) continue;
            progress('synthesizing', group.startIndex, cues.length, `Generating ${label} locally with GPT-SoVITS V5.`);
            const generated = await synthesizeLocal(normalizedSpeech, 1.0, 42, gIndex, 'base');
            if (!generated) continue;
            await maybeUpdateReferences(generated, normalizedSpeech, group.startIndex);
            await alignGroup(gIndex, generated, normalizedSpeech);
          }

          // Phase 2: Batch-synthesize remaining utterances with GPT-SoVITS V5 kept resident in VRAM.
          interface BatchItem {
            gIndex: number;
            startIndex: number;
            normalizedSpeech: string;
            out: string;
          }
          const batchItems: BatchItem[] = [];
          const outputs = new Map<number, string>();
          for (let gIndex = batchStart; gIndex < groups.length; gIndex++) {
            await ensureTranslation();
            const group = groups[gIndex];
            const primaryCue = group.cues[0];
            const label = group.cues.length > 1 ? `cues ${primaryCue.id}–${group.cues[group.cues.length - 1].id}` : `cue ${primaryCue.id}`;
            const normalizedSpeech = normalizeSpeechForLocalV5(group.speechText, textLang);
            if (!/[\p{L}\p{N}]/u.test(normalizedSpeech)) continue;
            progress('synthesizing', group.startIndex, cues.length, `Generating ${label} locally with GPT-SoVITS V5.`);
            const slotDur = Math.max(0.4, group.end - group.start);
            const nextStart = gIndex + 1 < groups.length ? Math.min(duration, groups[gIndex + 1].start + request.offset) : duration;
            const gapSlack = Math.max(0, nextStart - (group.end + request.offset)) * 0.5;
            const estDur = estimateExpectedSpeechSec(normalizedSpeech, textLang);
            const initialSpeed = estDur > (slotDur + gapSlack) * 1.15
              ? Math.min(1.25, Math.max(1.06, Number((estDur / ((slotDur + gapSlack) * 1.05)).toFixed(2))))
              : 1.0;
            const out = await synthesizeLocal(normalizedSpeech, initialSpeed, 42, gIndex, 'base');
            batchItems.push({ gIndex, startIndex: group.startIndex, normalizedSpeech, out });
            if (out) {
              outputs.set(gIndex, out);
              await maybeUpdateReferences(out, normalizedSpeech, group.startIndex);
            }
          }

          // Phase 3: Pre-generate faster speech for any overflowing utterances while V5 stays resident in VRAM.
          if (batchItems.length > 0) {
            let estimatedPrevEnd = prevAlignedEnd;
            for (const item of batchItems) {
              const out = outputs.get(item.gIndex) ?? '';
              if (!out) continue;
              const activeDur = await measureActiveDuration(out);
              const win = computeSlotWindow(item.gIndex, estimatedPrevEnd, activeDur);
              if (!win) continue;
              estimatedPrevEnd = win.slotEnd;
              if (activeDur && activeDur > (win.slotEnd - win.slotStart) * 1.18) {
                const slotLen = Math.max(0.2, win.slotEnd - win.slotStart);
                const retrySpeed = Math.min(1.25, Math.max(1.06, Number((activeDur / (slotLen * 1.08)).toFixed(2))));
                const faster = await synthesizeLocal(item.normalizedSpeech, retrySpeed, 42, item.gIndex, 'fast-0').catch(() => '');
                if (faster) {
                  const fasterDur = await measureActiveDuration(faster);
                  if (fasterDur && fasterDur < activeDur) {
                    outputs.set(item.gIndex, faster);
                  }
                }
              }
            }
          }

          // Phase 4: Sequential alignment (CPU FFmpeg) and rare runaway seed retries.
          for (const item of batchItems) {
            await ensureTranslation();
            await alignGroup(item.gIndex, outputs.get(item.gIndex) ?? '', item.normalizedSpeech);
          }
          await ensureTranslation();
          progress('mixing', 0, 1, hasSeparation ? 'Mixing translated speech with the separated background and copying the original video stream.' : 'Mixing translated speech with silent background and copying the original video stream. Original music is not preserved.');
          const resultDir = path.join(work, 'result'); await fs.mkdir(resultDir);
          const output = path.join(resultDir, 'translated.mkv'), audio = path.join(resultDir, 'translated.wav'), subtitles = path.join(resultDir, 'bilingual.srt');
          await this.deps.mix({ videoPath: video, backgroundPath: background, segments, duration, outputPath: output, backgroundGain: request.backgroundVolume }, audioOptions);
          await this.deps.extract(output, audio, audioOptions);
          await fs.writeFile(subtitles, dubbingSrt(cues, request.offset), { mode: 0o600 });
          signal.throwIfAborted();
          const finalDir = path.join(mediaDir, `result-${randomUUID()}`);
          await fs.rename(resultDir, finalDir);
          progress('complete', cues.length, cues.length, hasSeparation
            ? 'Local dubbing complete. Listen for voice similarity, residual speech and background artifacts.'
            : 'Local dubbing complete (original BGM was muted because no local vocal separation model is configured).');
          return { jobId: job.id, video: path.join(finalDir, 'translated.mkv'), audio: path.join(finalDir, 'translated.wav'), subtitles: path.join(finalDir, 'bilingual.srt'), cues, preview: request.preview, targetLanguage, voiceId: 'local-gpt-sovits-v5' };
        } finally {
          await fs.rm(localRefFile, { force: true }).catch(() => {});
          await fs.rm(targetRefFile, { force: true }).catch(() => {});
        }
      }
      const reference = cloudReference!;
      const referenceFile = path.join(work, 'reference.wav');
      await this.deps.reference(dialogue, referenceFile, reference.start, reference.duration, audioOptions);
      return await this.options.tts.withDubbingContext(async context => {
        signal.throwIfAborted();
        if (request.useTtsConfig) {
          const current = await this.options.tts.dubbingContextInfo!();
          if (normalizeQwenDubbingBaseUrl(context.baseUrl) !== activeBaseUrl || current.model !== activeModel) throw new Error('TTS 接口或模型已变更，请重新开始配音。 / TTS endpoint or model changed; restart dubbing.');
        }
        const credentials = { ...context, baseUrl: activeBaseUrl, model: activeModel }, client = this.deps.client(credentials);
        const referenceKey = hash([await digestFile(referenceFile, signal), activeModel, activeBaseUrl]);
        const account = hash(context.apiKey), voices = await this.voices();
        let voice = voices.find(item => item.reference === referenceKey && item.account === account);
        progress('voice', 0, 1, 'Registering or verifying the model-bound voice. Reference audio is sent to Alibaba Cloud.');
        if (voice) {
          if ((await client.queryVoice(voice.voiceId, signal)).status !== 'OK') throw new Error('Saved voice is not ready. Delete or repair it before retrying.');
        } else {
          if (voices.length >= 1000) throw new Error('Delete unused application-managed voices before creating another one.');
          const persist = async (created: { voiceId: string }) => {
            voice = { voiceId: created.voiceId, baseUrl: activeBaseUrl, account, reference: referenceKey };
            if (!voices.some(item => item.voiceId === created.voiceId)) {
              voices.push(voice); await saveJson(path.join(this.options.directory, 'voices.json'), voices);
            }
          };
          const result = await client.createVoice(referenceFile, signal, persist);
          // Test/custom clients may not implement the optional early-registration callback.
          if (!voice) await persist(result);
        }
        if (!voice) throw new Error('Voice registration did not return a manageable voice.');
        const segments: AudioSegment[] = [];
        const groups = groupDubbingUtterances(cues, targetLanguage);
        let prevAlignedEnd = 0;
        for (let gIndex = 0; gIndex < groups.length; gIndex++) {
          await ensureTranslation();
          const group = groups[gIndex];
          const primaryCue = group.cues[0];
          const label = group.cues.length > 1 ? `cues ${primaryCue.id}–${group.cues[group.cues.length - 1].id}` : `cue ${primaryCue.id}`;
          progress('synthesizing', group.startIndex, cues.length, `Generating ${label}; completed clips are cached for retries.`);
          const key = hash([activeModel, account, voice.voiceId, group.speechText, 'wav', 24000]);
          const generated = path.join(mediaDir, `speech-${key}.wav`);
          let cached = false;
          try { await readWavInfo(generated); cached = true; } catch { /* Generate only absent or invalid audio. */ }
          if (!cached) await client.synthesize(group.speechText, voice.voiceId, generated, signal);
          progress('aligning', group.startIndex, cues.length, `Aligning ${label} to its original time slot.`);
          try {
            let slotStart = Math.max(prevAlignedEnd, group.start + request.offset);
            if (slotStart >= duration - 0.01) continue;
            let slotEnd = Math.min(duration, Math.max(slotStart + 0.05, group.end + request.offset));
            if (slotEnd <= slotStart) continue;
            const nextStart = gIndex + 1 < groups.length ? Math.min(duration, Math.max(slotEnd, groups[gIndex + 1].start + request.offset)) : duration;
            let activeGenerated = generated;
            try {
              const synthInfo = await readWavInfo(activeGenerated);
              const trim = await detectWavTrimBounds(activeGenerated, synthInfo);
              const activeDur = trim ? trim.trimmedDuration : synthInfo.duration;
              if (nextStart > slotEnd && activeDur > slotEnd - slotStart) {
                slotEnd = Math.min(nextStart, Math.max(slotEnd, slotStart + activeDur));
              }
              if (activeDur > slotEnd - slotStart && prevAlignedEnd < slotStart) {
                slotStart = Math.max(prevAlignedEnd, slotStart - (activeDur - (slotEnd - slotStart)));
              }
              slotEnd = Math.min(duration, slotEnd);
              slotStart = Math.max(prevAlignedEnd, Math.min(slotStart, slotEnd - 0.01));
              // Closed-loop Aliyun LLM + TTS API duration control: if synthesized speech still overflows 1.45x of the slot,
              // request a tighter spoken translation via Aliyun LLM API and re-synthesize via Aliyun TTS API with rate control.
              const hasManualOverride = group.cues.some(c => Boolean(c.speechText && c.translated && c.speechText !== c.translated));
              if (!hasManualOverride && activeDur > (slotEnd - slotStart) * 1.45) {
                await ensureTranslation();
                const slotLen = Math.max(0.5, slotEnd - slotStart);
                const tightBudget = Math.max(0.5, slotLen * 0.72);
                const tightened = await this.options.translation.translate(
                  { texts: [group.cues.map(c => c.text).join(' ')] },
                  signal,
                  [tightBudget],
                );
                const compactSpeech = tightened[0]?.trim() || group.speechText;
                const cloudRate = Math.min(1.35, Math.max(1.1, Number((activeDur / (slotLen * 1.2)).toFixed(2))));
                group.speechText = compactSpeech;
                if (group.cues.length === 1) group.cues[0].speechText = compactSpeech;
                const compactKey = hash([activeModel, account, voice.voiceId, compactSpeech, cloudRate, 'wav', 24000]);
                const compactPath = path.join(mediaDir, `speech-${compactKey}.wav`);
                let compactCached = false;
                try { await readWavInfo(compactPath); compactCached = true; } catch {}
                if (!compactCached) await client.synthesize(compactSpeech, voice.voiceId, compactPath, signal, { rate: cloudRate });
                activeGenerated = compactPath;
              }
            } catch { /* Fall back to original slot boundaries if WAV header or compression retry fails. */ }
            const aligned = await this.deps.align({ filePath: activeGenerated, start: slotStart, end: slotEnd }, path.join(work, `aligned-${gIndex}.wav`), { ...audioOptions, maxTempo: 8 });
            prevAlignedEnd = aligned.end;
            segments.push(aligned);
          } catch (error) { throw new Error(`Cue ${primaryCue.id}: ${error instanceof Error ? error.message : String(error)} Edit the spoken translation and retry; previously generated clips are retained.`); }
        }
        await ensureTranslation();
        progress('mixing', 0, 1, hasSeparation ? 'Mixing translated speech with the separated background and copying the original video stream.' : 'Mixing translated speech with silent background and copying the original video stream. Original music is not preserved.');
        const resultDir = path.join(work, 'result'); await fs.mkdir(resultDir);
        const output = path.join(resultDir, 'translated.mkv'), audio = path.join(resultDir, 'translated.wav'), subtitles = path.join(resultDir, 'bilingual.srt');
        await this.deps.mix({ videoPath: video, backgroundPath: background, segments, duration, outputPath: output, backgroundGain: request.backgroundVolume }, audioOptions);
        await this.deps.extract(output, audio, audioOptions);
        await fs.writeFile(subtitles, dubbingSrt(cues, request.offset), { mode: 0o600 });
        signal.throwIfAborted();
        const finalDir = path.join(mediaDir, `result-${randomUUID()}`);
        await fs.rename(resultDir, finalDir);
        progress('complete', cues.length, cues.length, 'Dubbing complete. Listen for voice similarity, residual speech and background artifacts.');
        return { jobId: job.id, video: path.join(finalDir, 'translated.mkv'), audio: path.join(finalDir, 'translated.wav'), subtitles: path.join(finalDir, 'bilingual.srt'), cues, preview: request.preview, targetLanguage, voiceId: voice.voiceId };
      });
    } catch (error) {
      if (signal.aborted) throw new Error(`${timedOut ? 'Dubbing exceeded its 12-hour deadline.' : 'Dubbing cancelled.'} Already submitted cloud requests may still be billed; completed clips are kept.`);
      throw error;
    } finally {
      clearTimeout(deadline);
      if (work) await fs.rm(work, { recursive: true, force: true }).catch(() => {});
      if (this.active === job) this.active = undefined;
    }
  }
}
