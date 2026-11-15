import type { InferenceMode } from './local-models';

export interface TranslationSettings {
  mode?: InferenceMode;
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
export interface TranslationContextPair {
  source: string;
  translated: string;
}
/** Fixed translations are appended once and cannot be silently renamed by later batches. */
export interface TranslationTerm { source: string; translated: string }
export interface TranslationMemory { summary: string; terms: TranslationTerm[] }
export interface TranslationMemoryRequest {
  memory: TranslationMemory;
  pairs: TranslationContextPair[];
}

export interface TranslationRequest {
  texts: string[];
  memory?: TranslationMemory;
  /** Preceding already-translated cues; LLM context only, never re-emitted. */
  context?: TranslationContextPair[];
  /** Upcoming originals; LLM context only, never translated in this response. */
  lookahead?: string[];
  /** Optional speaking slot durations in seconds for isochronous dubbing translation. */
  durations?: number[];
  settings?: never;
}

export interface TranslationReviewRequest {
  memory?: TranslationMemory;
  /** Each cue must include id, original text, current draft translation, and optional slot duration (seconds). */
  cues: Array<{ id: number; text: string; translated: string; duration?: number }>;
}

export interface TranslationPatch {
  id: number;
  /** Optional LLM-corrected original ASR text (e.g. fixing ASR homophone typos). */
  text?: string;
  translated: string;
  /** True when the LLM identifies this cue as non-dialogue BGM lyrics/noise to exclude from dubbing. */
  bgm?: boolean;
}

export const TRANSLATION_CONTEXT_LIMIT = 12;
export const TRANSLATION_LOOKAHEAD_LIMIT = 4;

type MemoryCue = { text: string; translated?: string; speechText?: string };

/** Keep the recent window within the backend's 8000-character pair budget. */
export function translationContextStart(cues: MemoryCue[], start: number): number {
  let from = start;
  let characters = 0;
  while (from > Math.max(0, start - TRANSLATION_CONTEXT_LIMIT)) {
    const cue = cues[from - 1];
    const translated = (cue.speechText ?? cue.translated)?.trim();
    if (translated) {
      if (cue.text.length > 4096 || translated.length > 4096 || characters + cue.text.length + translated.length > 8000) break;
      characters += cue.text.length + translated.length;
    }
    from--;
  }
  return from;
}

export interface TranslationMemoryState { memory: TranslationMemory; through: number }

/** Fold only newly expired pairs into memory; a failed update never advances its cursor. */
export async function advanceTranslationMemory(
  cues: MemoryCue[], start: number, state: TranslationMemoryState,
  summarize: (request: TranslationMemoryRequest) => Promise<TranslationMemory>,
): Promise<TranslationMemoryState> {
  const end = translationContextStart(cues, start);
  let next = state;
  while (next.through < end) {
    const pairs: TranslationContextPair[] = [];
    let through = next.through;
    let characters = 0;
    while (through < end && pairs.length < 40) {
      const cue = cues[through];
      const translated = (cue.speechText ?? cue.translated)?.trim();
      if (translated && cue.text.trim()) {
        const size = cue.text.length + translated.length;
        if (size > 20000) throw new Error('A subtitle pair exceeds the translation memory limit.');
        if (characters + size > 20000) break;
        pairs.push({ source: cue.text, translated });
        characters += size;
      }
      through++;
    }
    next = { memory: pairs.length ? await summarize({ memory: next.memory, pairs }) : next.memory, through };
  }
  return next;
}

/** Rolling window around the current subtitle slice [start, end). */
export function translationWindow(
  cues: { text: string; translated?: string; speechText?: string }[],
  start: number,
  end: number,
): { context: TranslationContextPair[]; lookahead: string[] } {
  const from = translationContextStart(cues, start);
  const context: TranslationContextPair[] = [];
  for (let index = from; index < start; index++) {
    const translated = (cues[index].speechText ?? cues[index].translated)?.trim();
    if (translated) context.push({ source: cues[index].text, translated });
  }
  const lookahead: string[] = [];
  let lookaheadCharacters = 0;
  for (const cue of cues.slice(end, end + TRANSLATION_LOOKAHEAD_LIMIT)) {
    if (!cue.text.trim()) continue;
    if (lookaheadCharacters + cue.text.length > 4000) break;
    lookahead.push(cue.text);
    lookaheadCharacters += cue.text.length;
  }
  return { context, lookahead };
}
