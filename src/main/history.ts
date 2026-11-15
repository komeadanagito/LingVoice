import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import type { HistoryState, HistoryTask } from '../shared/history';

export const MAX_HISTORY_BYTES = 16 * 1024 * 1024;
const invalid = (): never => { throw new Error('Invalid task history data.'); };
function object(value: unknown, keys: string[]): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) invalid();
  return value as Record<string, any>;
}
function text(value: unknown, max = 4096): asserts value is string {
  if (typeof value !== 'string' || value.length > max || value.includes('\0')) invalid();
}
function number(value: unknown): asserts value is number { if (typeof value !== 'number' || !Number.isFinite(value)) invalid(); }
export function validateHistoryId(value: unknown, empty = false): asserts value is string {
  if (typeof value !== 'string' || (!value && !empty) || value.length > 128 || (value && !/^[a-zA-Z0-9_-]+$/.test(value))) invalid();
}
function cues(value: unknown, speech = false) {
  if (!Array.isArray(value) || value.length > 20000) return invalid();
  for (const entry of value) {
    const cue = object(entry, ['id', 'start', 'end', 'text', 'translated', ...(speech ? ['speechText'] : [])]);
    if (!Number.isSafeInteger(cue.id)) invalid();
    number(cue.start); number(cue.end);
    if (cue.start < 0 || cue.end < cue.start) invalid();
    text(cue.text, 100000);
    if (cue.translated !== undefined) text(cue.translated, 100000);
    if (cue.speechText !== undefined) text(cue.speechText, 100000);
  }
}
export function validateHistoryTask(value: unknown): HistoryTask {
  try { if (Buffer.byteLength(JSON.stringify(value) ?? '') > MAX_HISTORY_BYTES) invalid(); } catch { invalid(); }
  const task = object(value, ['id', 'title', 'createdAt', 'updatedAt', 'file', 'embed', 'sourceUrl', 'subtitles']);
  validateHistoryId(task.id); text(task.title); text(task.file, 16384); text(task.embed);
  number(task.createdAt); number(task.updatedAt);
  if (task.sourceUrl !== undefined) {
    text(task.sourceUrl, 16384);
    let url: URL;
    try { url = new URL(task.sourceUrl); } catch { return invalid(); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) invalid();
  }
  if (task.createdAt < 0 || task.updatedAt < 0) invalid();
  if (task.embed) {
    let url: URL;
    try { url = new URL(task.embed); } catch { return invalid(); }
    if (url.protocol !== 'https:' || url.username || url.password || url.port || !(
      (url.hostname === 'player.bilibili.com' && url.pathname === '/player.html') ||
      (url.hostname === 'www.youtube.com' && /^\/embed\/[a-zA-Z0-9_-]{11}$/.test(url.pathname))
    )) invalid();
  }
  if (task.subtitles !== undefined) {
    const sub = object(task.subtitles, ['cues', 'offset', 'fontSize', 'mode', 'name', 'result', 'translationFingerprint']);
    cues(sub.cues); number(sub.offset); number(sub.fontSize);
    if (sub.fontSize <= 0 || sub.fontSize > 1000 || !['bilingual', 'original', 'translated', 'off'].includes(sub.mode)) invalid();
    text(sub.name); text(sub.translationFingerprint, MAX_HISTORY_BYTES);
    if (sub.result !== null) {
      const result = object(sub.result, ['jobId', 'video', 'audio', 'subtitles', 'cues', 'preview', 'targetLanguage', 'voiceId']);
      for (const key of ['jobId', 'video', 'audio', 'subtitles', 'targetLanguage', 'voiceId']) text(result[key], 16384);
      if (typeof result.preview !== 'boolean') invalid();
      cues(result.cues, true);
    }
  }
  // Clone so callers cannot mutate records after validation.
  return JSON.parse(JSON.stringify(task)) as HistoryTask;
}

/** Local-only SQLite metadata. Deletion intentionally retains media/exported files. */
export class HistoryService {
  private db: DatabaseSync;
  constructor(file: string) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.chmodSync(path.dirname(file), 0o700);
    const fd = fs.openSync(file, 'a', 0o600); fs.closeSync(fd); fs.chmodSync(file, 0o600);
    this.db = new DatabaseSync(file);
    try {
      this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
        CREATE TABLE IF NOT EXISTS history_tasks (id TEXT PRIMARY KEY, updated_at REAL NOT NULL, payload TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS history_state (singleton INTEGER PRIMARY KEY CHECK(singleton=1), active_id TEXT NOT NULL);
        INSERT OR IGNORE INTO history_state VALUES (1, ''); PRAGMA user_version=1;`);
      for (const suffix of ['-wal', '-shm']) if (fs.existsSync(file + suffix)) fs.chmodSync(file + suffix, 0o600);
    } catch (error) {
      // Initialization failures must not leave a connection (and its WAL handles) open.
      this.db.close();
      throw error;
    }
  }
  private transaction(action: () => void) {
    this.db.exec('BEGIN IMMEDIATE');
    try { action(); this.db.exec('COMMIT'); } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  list(): HistoryState {
    const tasks = this.db.prepare('SELECT payload FROM history_tasks ORDER BY updated_at DESC, id').all()
      .map(row => validateHistoryTask(JSON.parse(row.payload as string)));
    const row = this.db.prepare('SELECT active_id FROM history_state WHERE singleton=1').get();
    return { tasks, activeId: row?.active_id as string ?? '' };
  }
  save(value: unknown): void {
    const task = validateHistoryTask(value);
    this.transaction(() => { this.db.prepare('INSERT INTO history_tasks VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET updated_at=excluded.updated_at, payload=excluded.payload').run(task.id, task.updatedAt, JSON.stringify(task)); });
  }
  delete(id: string): void {
    validateHistoryId(id);
    this.transaction(() => {
      this.db.prepare('DELETE FROM history_tasks WHERE id=?').run(id);
      this.db.prepare("UPDATE history_state SET active_id='' WHERE active_id=?").run(id);
    });
  }
  select(id: string): void {
    validateHistoryId(id, true);
    this.transaction(() => {
      if (id && !this.db.prepare('SELECT id FROM history_tasks WHERE id=?').get(id)) throw new Error('History task does not exist.');
      this.db.prepare('UPDATE history_state SET active_id=? WHERE singleton=1').run(id);
    });
  }
  close(): void { this.db.close(); }
}
