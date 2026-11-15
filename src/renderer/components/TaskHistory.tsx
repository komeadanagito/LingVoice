import { useRef, useState } from 'react';
import { useI18n } from '../i18n';
import { taskStatus, type HistoryTask } from '../utils/task-history';
import { Icon } from './Icon';

export interface TaskExecution {
  state: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  stage?: string;
  progress?: string;
  error?: string;
}

interface Props {
  tasks: HistoryTask[];
  activeTaskId: string;
  ready: boolean;
  onOpenTask: (id: string) => void;
  onDeleteTask: (id: string) => void;
  onNewTask: () => void;
  onImportFiles?: (files: File[]) => void;
  onImportLinks?: (urls: string[]) => void;
  onRunTasks?: (ids: string[]) => void;
  onCancelTask?: (id: string) => void;
  executions?: Record<string, TaskExecution>;
}

export function TaskHistory({ tasks, activeTaskId, ready, onOpenTask, onDeleteTask, onNewTask, onImportFiles, onImportLinks, onRunTasks, onCancelTask, executions = {} }: Props) {
  const { t, locale } = useI18n();
  const fileInput = useRef<HTMLInputElement>(null);
  const selectAll = useRef<HTMLInputElement>(null);
  const linksInput = useRef<HTMLTextAreaElement>(null);
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const [links, setLinks] = useState('');
  const [invalidLinks, setInvalidLinks] = useState<string[]>([]);
  const [emptyLinks, setEmptyLinks] = useState(false);
  const selected = tasks.filter(task => selection.has(task.id));
  const allSelected = tasks.length > 0 && selected.length === tasks.length;
  const executing = (id: string) => executions[id]?.state === 'running' || executions[id]?.state === 'queued';
  const ordered = [...tasks].sort((a, b) => b.updatedAt - a.updatedAt);
  const statuses = {
    created: t('history.created'), recognized: t('history.recognized'),
    translated: t('history.translated'), dubbed: t('history.dubbed'),
  };
  const executionLabels = {
    queued: t('history.queued'), running: t('history.running'), completed: t('history.completed'),
    failed: t('history.failed'), cancelled: t('history.cancelled'),
  };
  const importLinks = () => {
    const entries = links.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    const invalid = entries.filter(entry => {
      try {
        const url = new URL(entry);
        return !/^https?:\/\//i.test(entry) || !['http:', 'https:'].includes(url.protocol) || !url.hostname
          || Boolean(url.username || url.password) || /\s/.test(entry);
      } catch { return true; }
    });
    setInvalidLinks(invalid);
    setEmptyLinks(entries.length === 0);
    if (!entries.length || invalid.length) {
      linksInput.current?.focus();
      return;
    }
    // URL normalization also deduplicates equivalent host names and trailing slashes.
    onImportLinks?.([...new Set(entries.map(entry => new URL(entry).href))]);
    setLinks('');
  };
  return <div className="task-history">
    <header className="task-history-heading">
      <div>
        <h2 id="task-history-heading">{t('nav.history')} <span>{tasks.length}</span></h2>
        <p>{t('history.description')}</p>
      </div>
      <button type="button" className="choose-file-button" onClick={onNewTask} disabled={!ready}><Icon name="addTask" size={16} />{t('history.new')}</button>
    </header>
    <section className="task-history-import" aria-label={t('history.importTitle')}>
      <div className="task-history-file-import">
        <input ref={fileInput} type="file" multiple accept="video/*,.mkv,.avi,.mov,.webm,.mp4" className="sr-only" tabIndex={-1} aria-label={t('history.importFiles')} disabled={!ready || !onImportFiles} onChange={event => {
          const files = Array.from(event.currentTarget.files ?? []);
          if (files.length) onImportFiles?.(files);
          event.currentTarget.value = '';
        }} />
        <button type="button" className="choose-file-button" disabled={!ready || !onImportFiles} onClick={() => fileInput.current?.click()}>{t('history.importFiles')}</button>
        <p>{t('history.fileHint')}</p>
      </div>
      <div className="task-history-link-import">
        <label htmlFor="task-history-links">{t('history.linksLabel')}</label>
        <textarea ref={linksInput} id="task-history-links" rows={3} value={links} placeholder="https://example.com/video" disabled={!ready || !onImportLinks} aria-invalid={invalidLinks.length > 0 || emptyLinks} aria-describedby={`task-history-links-hint${invalidLinks.length || emptyLinks ? ' task-history-links-error' : ''}`} onChange={event => {
          setLinks(event.target.value); setInvalidLinks([]); setEmptyLinks(false);
        }} />
        <p id="task-history-links-hint">{t('history.linksHint')}</p>
        {(invalidLinks.length > 0 || emptyLinks) && <div id="task-history-links-error" className="task-history-import-error" role="alert">
          <p>{emptyLinks ? t('history.linksEmpty') : t('history.linksInvalid')}</p>
          {invalidLinks.length > 0 && <ul>{invalidLinks.map((entry, index) => <li key={index}>{entry}</li>)}</ul>}
        </div>}
        <button type="button" className="choose-file-button" onClick={importLinks} disabled={!ready || !onImportLinks || !links.trim()}>{t('history.importLinks')}</button>
      </div>
    </section>
    <div className="task-history-batch">
      <label className="task-history-select-all">
        <input ref={node => { selectAll.current = node; if (node) node.indeterminate = selected.length > 0 && !allSelected; }} type="checkbox" checked={allSelected} disabled={!ready || !tasks.length} onChange={event => setSelection(event.target.checked ? new Set(tasks.map(task => task.id)) : new Set())} />
        {t('history.selectAll')}
      </label>
      <span className="task-history-selected-count" role="status">{t('history.selectedCount', { count: selected.length })}</span>
      <button type="button" className="choose-file-button task-history-run" disabled={!ready || !onRunTasks || !selected.length || selected.some(task => executing(task.id))} onClick={() => {
        if (window.confirm(t('history.runConsent', { count: selected.length }))) onRunTasks?.(selected.map(task => task.id));
      }}>{t('history.run')}</button>
    </div>
    {!ready ? <p className="task-history-empty" role="status">{t('history.loading')}</p>
      : !tasks.length ? <div className="task-history-empty-state">
        <Icon name="history" size={32} />
        <h3>{t('history.empty')}</h3>
        <p>{t('history.emptyHint')}</p>
        <button type="button" className="choose-file-button" onClick={onNewTask}>{t('history.first')}</button>
      </div> : <div className="task-history-list" aria-label={t('history.listLabel')}>
        {ordered.map(task => {
          const count = task.subtitles?.cues.length ?? 0;
          const translated = task.subtitles?.cues.filter(cue => cue.translated?.trim()).length ?? 0;
          const execution = executions[task.id];
          const busy = executing(task.id);
          const title = task.title || t('history.untitled');
          return <div className={`task-history-row${activeTaskId === task.id ? ' is-active' : ''}${selection.has(task.id) ? ' is-selected' : ''}`} key={task.id}>
            <label className="task-history-select"><input type="checkbox" checked={selection.has(task.id)} aria-label={t('history.selectTask', { title })} onChange={event => {
              const checked = event.target.checked;
              setSelection(previous => { const next = new Set(previous); if (checked) next.add(task.id); else next.delete(task.id); return next; });
            }} /></label>
            <div className="task-history-row-content">
              <button type="button" className="task-history-open" onClick={() => onOpenTask(task.id)} title={title}>
                <span className="task-history-title"><Icon name="video" size={19} /><span>{title}</span></span>
                <span className="task-history-meta">{statuses[taskStatus(task)]}{count > 0 ? ` · ${t('history.translatedCount', { translated, count })}` : ''}</span>
                <time dateTime={new Date(task.updatedAt).toISOString()}>{new Date(task.updatedAt).toLocaleString(locale, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</time>
              </button>
              {execution && <div className="task-history-execution" role="status" aria-live="polite">
                <span className={`task-history-badge is-${execution.state}`}>{executionLabels[execution.state]}</span>
                {execution.stage && <span>{execution.stage}</span>}
                {execution.progress && <span>{execution.progress}</span>}
                {execution.error && <span className="task-history-execution-error">{execution.error}</span>}
              </div>}
            </div>
            {busy && onCancelTask && <button type="button" className="task-history-cancel" aria-label={t('history.cancelTask', { title })} onClick={() => onCancelTask(task.id)}>{t('history.cancel')}</button>}
            <button type="button" className="task-history-delete" disabled={busy} aria-label={t('history.deleteTask', { title })} title={busy ? t('history.deleteBusy') : t('history.delete')} onClick={() => {
              if (window.confirm(t('history.deleteConsent', { title }))) onDeleteTask(task.id);
            }}>×</button>
          </div>;
        })}
      </div>}
  </div>;
}
