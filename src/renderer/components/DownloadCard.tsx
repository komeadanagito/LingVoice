import type { DownloadController } from '../hooks/useDownloader';
import { bytes, duration } from '../utils/format';
import { useI18n } from '../i18n';
import { Icon } from './Icon';

interface Props extends DownloadController {
  onPlayVideo?: (file: string, title?: string) => void;
}

export function DownloadCard({
  url,
  busy,
  phase,
  video,
  quality,
  folder,
  cookieFile,
  status,
  progress,
  completed,
  cancelling,
  error,
  lastDownloadedFile,
  changeUrl,
  inspect,
  download,
  cancel,
  reveal,
  setQuality,
  chooseFolder,
  chooseCookies,
  clearCookies,
  onPlayVideo,
}: Props) {
  const { t, locale, message } = useI18n();

  const showProgress = phase === 'download' || completed;
  const percent = completed ? 100 : progress?.percent ?? undefined;
  const transfer = completed
    ? t('task.processed')
    : progress
    ? `${bytes(progress.downloaded, locale)}${progress.total ? ` / ${bytes(progress.total, locale)}` : ''} · ${t('task.speed', { speed: bytes(progress.speed, locale) })}${progress.eta ? ` · ${t('task.eta', { time: duration(progress.eta) })}` : ''}`
    : t('task.connecting');
  const percentage =
    percent === undefined
      ? t('task.unknownSize')
      : new Intl.NumberFormat(locale, { style: 'percent', minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(
          percent / 100,
        );

  const videoTitle = video ? (video.titleKey ? t(video.titleKey) : video.title) : '';

  return (
    <section className="card download-card">
      <div className="section-title sr-only">
        <h2>{t('link.title')}</h2>
      </div>

      <form
        id="link-form"
        onSubmit={event => {
          event.preventDefault();
          if (video) void download();
          else void inspect();
        }}
      >
        <label className="sr-only" htmlFor="url">{t('link.label')}</label>
        <div className="url-box">
          <span className="link-icon"><Icon name="link" size={18} /></span>
          <input
            id="url"
            type="text"
            placeholder={t('link.placeholder')}
            autoComplete="off"
            spellCheck={false}
            maxLength={4096}
            value={url}
            onChange={event => changeUrl(event.target.value)}
            disabled={busy}
          />
          <button
            className="text-button inspect-button"
            id="inspect"
            type="button"
            disabled={busy || !url.trim()}
            onClick={() => void inspect()}
          >
            {phase === 'inspect' ? t('link.inspecting') : t('link.inspect')}
          </button>
          <button
            className="primary download-button"
            id="download"
            type="button"
            disabled={busy || !video}
            onClick={() => void download()}
          >
            <Icon name="download" size={15} /> {t('task.download')}
          </button>
        </div>
      </form>

      <div className="input-foot">
        <span className="bili-tag">bilibili</span>
        <span className="yt-tag">YouTube</span>
      </div>


      {/* Hidden preferences and cookies: quality defaults to 'best', no manual choice or login clutter needed */}
      <div className="settings-grid" style={{ display: 'none' }}>
        <div>
          <label htmlFor="quality">{t('preferences.quality')}</label>
          <select id="quality" value={quality} onChange={event => setQuality(event.target.value)} disabled={busy}>
            <option value="best">{t('preferences.best')}</option>
            {video?.heights.map(height => (
              <option key={height} value={String(height)}>{t('preferences.resolution', { height })}</option>
            ))}
          </select>
          <p className="field-hint">{t('preferences.qualityHint')}</p>
        </div>
        <div>
          <label>{t('preferences.folder')}</label>
          <div className="folder-box">
            <span>▤</span>
            <span id="folder" title={folder}>{folder}</span>
            <button id="choose-folder" type="button" disabled={busy} onClick={() => void chooseFolder()}>
              {t('preferences.change')}
            </button>
          </div>
          <p className="field-hint">{t('preferences.resumeHint')}</p>
        </div>
      </div>

      <details id="advanced" style={{ display: 'none' }}>
        <summary>{t('cookies.title')} <span>{t('cookies.optional')}</span></summary>
        <div className="cookie-row">
          <p id="cookie-label">{cookieFile ? t('cookies.selected', { file: cookieFile }) : t('cookies.none')}</p>
          <button className="text-button" id="choose-cookies" disabled={busy} onClick={() => void chooseCookies()}>
            {t('cookies.choose')}
          </button>
          {cookieFile && (
            <button className="text-button" id="clear-cookies" disabled={busy} onClick={() => void clearCookies()}>
              {t('cookies.clear')}
            </button>
          )}
        </div>
        <p className="field-hint">{t('cookies.privacy')}</p>
      </details>

      <div className={`task-panel liquid-task${showProgress ? ' has-progress' : ''}${completed ? ' is-complete' : ''}${showProgress && percent === undefined ? ' is-indeterminate' : ''}${error ? ' has-error' : ''}`} aria-live="polite">
        {showProgress && <div className="liquid-fill" aria-hidden="true" style={{ width: `${percent === undefined ? 28 : Math.max(0, Math.min(100, percent))}%` }}><span className="liquid-wave" /></div>}
        <div className="task-line">
          <div className="status-icon" id="status-icon"><Icon name={error ? 'external' : 'download'} size={18} /></div>
          <div className="task-copy sr-only">
            <strong id="status-title">{t(status.title)}</strong>
            <p id="status-message">{message(status.message)}</p>
          </div>
          {error && <span className="task-inline-error" id="error" role="alert">{message(error)}</span>}
          {completed && (
            <div className="completed-actions">
              <button
                className="primary play-btn-task"
                id="play-video"
                type="button"
                onClick={() => onPlayVideo?.(lastDownloadedFile, videoTitle)}
              >
                <Icon name="play" size={14} /> {t('player.play')}
              </button>
              <button className="text-button" id="reveal" type="button" onClick={() => void reveal()}>
                {t('task.reveal')} <Icon name="external" size={13} />
              </button>
            </div>
          )}
          {busy && (
            <button className="cancel-button" id="cancel" type="button" disabled={cancelling} onClick={() => void cancel()}>
              {cancelling ? t('task.cancelling') : t('task.cancel')}
            </button>
          )}
        </div>
        {showProgress && (
          <>
            <progress className="sr-only" id="progress" max={100} value={percent} aria-label={t('task.progressLabel')} />
            <div className="progress-meta sr-only" id="progress-meta">
              <span id="transfer">{transfer}</span>
              <span id="percentage">{completed ? t('task.completed') : percentage}</span>
            </div>
          </>
        )}
      </div>
    </section>
  );
}
