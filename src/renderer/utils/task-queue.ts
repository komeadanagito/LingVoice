export type TaskExecution = { state: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'; stage?: string; progress?: string; error?: string };
export class TaskQueue {
  private entries = new Map<string, { controller: AbortController; started: boolean }>();
  private listeners = new Set<() => void>();
  private tail: Promise<void> = Promise.resolve();
  private snapshot: Record<string, TaskExecution> = {};
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getSnapshot = () => this.snapshot;
  update(id: string, patch: Partial<TaskExecution>) {
    this.snapshot = { ...this.snapshot, [id]: { ...this.snapshot[id], ...patch } };
    for (const listener of this.listeners) listener();
  }
  enqueue(id: string, action: (signal: AbortSignal) => Promise<void>): Promise<void> {
    if (this.entries.has(id)) return Promise.resolve();
    const entry = { controller: new AbortController(), started: false };
    this.entries.set(id, entry);
    this.update(id, { state: 'queued', progress: '', error: '' });
    const run = this.tail.then(async () => {
      const signal = entry.controller.signal;
      try {
        signal.throwIfAborted(); entry.started = true;
        this.update(id, { state: 'running' });
        await action(signal);
        signal.throwIfAborted();
        this.update(id, { state: 'completed', stage: '', progress: '', error: '' });
      } catch (error) {
        this.update(id, { state: signal.aborted ? 'cancelled' : 'failed', error: signal.aborted ? '' : error instanceof Error ? error.message : String(error) });
      } finally { this.entries.delete(id); }
    });
    this.tail = run.catch(() => {});
    return run;
  }
  cancel(id: string) {
    const entry = this.entries.get(id);
    if (!entry) return;
    entry.controller.abort();
    if (!entry.started) this.update(id, { state: 'cancelled', progress: '', error: '' });
  }
}
export const taskQueue = new TaskQueue();
export type TaskRuntime = { source: string; pipeline: (signal: AbortSignal) => Promise<void>; stop: () => void };
const runtimes = new Map<string, TaskRuntime>();
const runtimeListeners = new Set<() => void>();
export function registerTaskRuntime(id: string, runtime: TaskRuntime) {
  runtimes.set(id, runtime); for (const notify of runtimeListeners) notify();
  return () => { if (runtimes.get(id) === runtime) runtimes.delete(id); };
}
export function waitForTaskRuntime(id: string, signal: AbortSignal, source?: string): Promise<TaskRuntime> {
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); runtimeListeners.delete(check); signal.removeEventListener('abort', aborted); };
    const aborted = () => { cleanup(); reject(signal.reason); };
    const check = () => { const runtime = runtimes.get(id); if (runtime && (!source || runtime.source === source)) { cleanup(); resolve(runtime); } };
    const timer = setTimeout(() => { cleanup(); reject(new Error('Task workspace could not be loaded. Open the task and retry.')); }, 30000);
    runtimeListeners.add(check); signal.addEventListener('abort', aborted, { once: true });
    if (signal.aborted) aborted(); else check();
  });
}
