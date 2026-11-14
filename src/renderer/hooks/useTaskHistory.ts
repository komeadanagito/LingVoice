import { useCallback, useEffect, useRef, useState } from 'react';
import { deleteTask, loadHistory, saveTask, selectTask, type HistoryTask, type SavedSubtitles } from '../utils/task-history';

export function useTaskHistory() {
  const [tasks, setTasks] = useState<HistoryTask[]>([]);
  const [activeId, setActiveId] = useState('');
  const [ready, setReady] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const records = useRef<HistoryTask[]>([]);
  const queue = useRef(Promise.resolve());
  const pending = useRef(0);
  const removing = useRef(new Set<string>());

  useEffect(() => {
    let mounted = true;
    void loadHistory().then(state => {
      if (!mounted) return;
      records.current = state.tasks;
      setTasks(state.tasks);
      setActiveId(state.activeId);
      if (state.migrationError) setError(state.migrationError);
    }).catch(reason => {
      if (mounted) setError(reason instanceof Error ? reason.message : String(reason));
    }).finally(() => { if (mounted) setReady(true); });
    return () => { mounted = false; };
  }, []);

  const enqueue = useCallback((operation: () => Promise<void>) => {
    pending.current++;
    setSaving(true);
    queue.current = queue.current.then(async () => {
      await operation();
      setError('');
    }).catch(reason => {
      setError(reason instanceof Error ? reason.message : String(reason));
    }).finally(() => {
      pending.current--;
      if (!pending.current) setSaving(false);
    });
  }, []);

  const select = useCallback((id: string) => {
    setActiveId(id);
    enqueue(() => selectTask(id));
  }, [enqueue]);

  const create = useCallback((source: Pick<HistoryTask, 'title' | 'file' | 'embed' | 'mediaFile'>) => {
    const now = Date.now();
    const task: HistoryTask = { ...source, id: crypto.randomUUID(), createdAt: now, updatedAt: now };
    records.current = [task, ...records.current];
    setTasks(records.current);
    setActiveId(task.id);
    setError('');
    enqueue(async () => {
      await saveTask(task);
      await selectTask(task.id);
    });
    return task.id;
  }, [enqueue, select]);

  const replaceSource = useCallback((id: string, source: Pick<HistoryTask, 'title' | 'file' | 'embed'>) => {
    const existing = records.current.find(task => task.id === id);
    if (!existing || removing.current.has(id)) return false;
    const task: HistoryTask = { ...existing, ...source, updatedAt: Date.now() };
    records.current = records.current.map(record => record.id === id ? task : record);
    setTasks(records.current);
    setActiveId(id);
    enqueue(async () => { await saveTask(task); await selectTask(id); });
    return true;
  }, [enqueue, select]);

  const update = useCallback((id: string, subtitles: SavedSubtitles) => {
    const existing = records.current.find(task => task.id === id);
    if (!existing || removing.current.has(id)) return;
    const next = { ...existing, subtitles, updatedAt: Date.now() };
    records.current = records.current.map(task => task.id === id ? next : task);
    setTasks(records.current);
    enqueue(() => saveTask(next));
  }, [enqueue]);

  const remove = useCallback((id: string) => {
    if (removing.current.has(id)) return;
    removing.current.add(id);
    enqueue(async () => {
      try { await deleteTask(id); }
      catch (reason) { removing.current.delete(id); throw reason; }
      records.current = records.current.filter(task => task.id !== id);
      setTasks(records.current);
      setActiveId(current => {
        if (current !== id) return current;
        return '';
      });
    });
  }, [enqueue]);

  // Warn while writes are pending rather than claiming a task is already saved.
  useEffect(() => {
    if (!saving) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [saving]);

  return { tasks, activeId, activeTask: tasks.find(task => task.id === activeId), ready, saving, error, create, replaceSource, select, update, remove };
}
