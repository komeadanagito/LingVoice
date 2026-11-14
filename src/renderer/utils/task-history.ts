import type { IpcResult } from '../../shared/contracts';
import type { HistoryTask as StoredTask, HistoryState, SavedSubtitles } from '../../shared/history';
export type { SavedSubtitles } from '../../shared/history';

/** mediaFile exists only while opening a browser file or migrating legacy IndexedDB data. */
export interface HistoryTask extends StoredTask { mediaFile?: File }

async function unwrap<T>(operation: Promise<IpcResult<T>>): Promise<T> {
  const result = await operation;
  if (!result.ok) throw new Error(result.error);
  return result.data;
}

const uploads = new Map<string, Promise<string>>();
async function persistMedia(task: HistoryTask): Promise<string> {
  if (!task.mediaFile) return task.file;
  let upload = uploads.get(task.id);
  if (!upload) {
    upload = (async () => {
      const response = await fetch(`/api/lingvoice/history-media/${encodeURIComponent(task.id)}`, {
        method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: task.mediaFile,
      });
      let result: IpcResult<{ file: string }>;
      try { result = await response.json(); }
      catch { throw new Error(`Unable to persist task video (HTTP ${response.status}). The original browser copy is retained.`); }
      if (!result.ok) throw new Error(result.error);
      if (!response.ok || typeof result.data?.file !== 'string') throw new Error('Unable to persist task video.');
      return result.data.file;
    })();
    uploads.set(task.id, upload);
    void upload.catch(() => { if (uploads.get(task.id) === upload) uploads.delete(task.id); });
  }
  return upload;
}

export async function saveTask(task: HistoryTask): Promise<void> {
  const { mediaFile: _file, ...stored } = task;
  const file = await persistMedia(task);
  await unwrap(window.lingvoice.saveHistoryTask({ ...stored, file }));
}

export async function deleteTask(id: string): Promise<void> {
  await unwrap(window.lingvoice.deleteHistoryTask(id));
  uploads.delete(id);
}

export async function selectTask(id: string): Promise<void> {
  await unwrap(window.lingvoice.selectHistoryTask(id));
}

// IndexedDB is used only to migrate older installations, never for new history writes.
const LEGACY_DATABASE = 'lingvoice-tasks';
let legacyDatabase: Promise<IDBDatabase> | undefined;
function openLegacy(): Promise<IDBDatabase> {
  if (!legacyDatabase) legacyDatabase = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(LEGACY_DATABASE, 2);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains('tasks')) request.result.createObjectStore('tasks', { keyPath: 'id' });
      if (!request.result.objectStoreNames.contains('migrated-tasks')) request.result.createObjectStore('migrated-tasks', { keyPath: 'id' });
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => { db.close(); legacyDatabase = undefined; };
      resolve(db);
    };
    request.onerror = () => reject(request.error ?? new Error('Unable to read legacy history.'));
    request.onblocked = () => reject(new Error('Close other LingVoice tabs to migrate older history.'));
  }).catch(error => { legacyDatabase = undefined; throw error; });
  return legacyDatabase;
}

async function legacyTasks(): Promise<HistoryTask[]> {
  const db = await openLegacy();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('tasks', 'readonly');
    const request = tx.objectStore('tasks').getAll();
    tx.oncomplete = () => resolve(request.result);
    tx.onabort = () => reject(tx.error ?? new Error('Unable to read legacy history.'));
  });
}

async function archiveLegacy(task: HistoryTask): Promise<void> {
  const db = await openLegacy();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['tasks', 'migrated-tasks'], 'readwrite');
    tx.objectStore('migrated-tasks').put(task);
    tx.objectStore('tasks').delete(task.id);
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error('Unable to archive migrated history.'));
  });
}

export async function loadHistory(): Promise<HistoryState & { migrationError?: string }> {
  const state = await unwrap(window.lingvoice.history());
  if (typeof indexedDB === 'undefined') return state;
  try {
    const legacy = await legacyTasks();
    if (!legacy.length) return state;
    const existing = new Set(state.tasks.map(task => task.id));
    for (const task of legacy) {
      // SQLite is authoritative if an earlier migration already committed this ID.
      if (!existing.has(task.id)) await saveTask(task);
      await archiveLegacy(task); // Keep the full original backup, only after SQLite commit.
    }
    if (!state.activeId) {
      let id = '';
      try { id = localStorage.getItem('lingvoice.active-task') ?? ''; } catch { /* Optional legacy preference. */ }
      if (id && (existing.has(id) || legacy.some(task => task.id === id))) await selectTask(id);
    }
    return await unwrap(window.lingvoice.history());
  } catch (error) {
    const current = await unwrap(window.lingvoice.history());
    return { ...current, migrationError: `旧历史迁移尚未完成，浏览器中的原始备份仍保留。 / Legacy migration is incomplete; original browser data is retained. ${error instanceof Error ? error.message : String(error)}` };
  }
}

export function taskStatus(task: HistoryTask): 'created' | 'recognized' | 'translated' | 'dubbed' {
  const saved: SavedSubtitles | undefined = task.subtitles;
  if (saved?.result) return 'dubbed';
  if (saved?.cues.length && saved.cues.every(cue => cue.translated?.trim())) return 'translated';
  if (saved?.cues.length) return 'recognized';
  return 'created';
}
