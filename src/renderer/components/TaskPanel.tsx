import type { DownloadController } from '../hooks/useDownloader';
import { bytes, duration } from '../utils/format';
import { useI18n } from '../i18n';

type Props = Pick<DownloadController, 'status' | 'progress' | 'phase' | 'completed' | 'busy' | 'cancelling' | 'video' | 'download' | 'cancel' | 'reveal'>;

export function TaskPanel({ status, progress, phase, completed, busy, cancelling, video, download, cancel, reveal }: Props) {
  const { t, locale, message } = useI18n();
  const showProgress = phase === 'download' || completed;
  const percent = completed ? 100 : progress?.percent ?? undefined;
  const transfer = completed ? t('task.processed') : progress
    ? `${bytes(progress.downloaded, locale)}${progress.total ? ` / ${bytes(progress.total, locale)}` : ''} · ${t('task.speed', { speed: bytes(progress.speed, locale) })}${progress.eta ? ` · ${t('task.eta', { time: duration(progress.eta) })}` : ''}`
    : t('task.connecting');
  const percentage = percent === undefined ? t('task.unknownSize') : new Intl.NumberFormat(locale, { style: 'percent', minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(percent / 100);
  return <section className="task-panel" aria-live="polite">
    <div className="task-line"><div className="status-icon" id="status-icon">↓</div>
      <div className="task-copy"><strong id="status-title">{t(status.title)}</strong><p id="status-message">{message(status.message)}</p></div>
      {completed && <button className="text-button" id="reveal" onClick={() => void reveal()}>{t('task.reveal')} ↗</button>}
      {busy && <button className="cancel-button" id="cancel" disabled={cancelling} onClick={() => void cancel()}>{cancelling ? t('task.cancelling') : t('task.cancel')}</button>}
      <button className="primary download-button" id="download" disabled={busy || !video} onClick={() => void download()}>↓ {t('task.download')}</button>
    </div>
    {showProgress && <>
      <div className="progress-track" id="progress-track"><progress id="progress" max={100} value={percent} aria-label={t('task.progressLabel')} /></div>
      <div className="progress-meta" id="progress-meta"><span id="transfer">{transfer}</span><span id="percentage">{completed ? t('task.completed') : percentage}</span></div>
    </>}
  </section>;
}
