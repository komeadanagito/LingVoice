import type { DubbingResult } from './dubbing';

export interface SavedSubtitles {
  cues: { id: number; start: number; end: number; text: string; translated?: string }[];
  offset: number;
  fontSize: number;
  mode: 'bilingual' | 'original' | 'translated' | 'off';
  name: string;
  result: DubbingResult | null;
  translationFingerprint: string;
}

/** SQLite task metadata; video bytes live on disk, not in the task row. */
export interface HistoryTask {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  file: string;
  embed: string;
  sourceUrl?: string;
  subtitles?: SavedSubtitles;
}

export interface HistoryState { tasks: HistoryTask[]; activeId: string }
