import type { DownloadController } from '../hooks/useDownloader';
import { useI18n } from '../i18n';

type Props = Pick<DownloadController, 'url' | 'busy' | 'phase' | 'changeUrl' | 'inspect'>;

export function LinkForm({ url, busy, phase, changeUrl, inspect }: Props) {
  const { t } = useI18n();
  return <section className="card input-card">
    <div className="section-title"><span className="step">01</span><h2>{t('link.title')}</h2><span className="subtle">{t('link.support')}</span></div>
    <form id="link-form" onSubmit={event => { event.preventDefault(); void inspect(); }}>
      <label className="sr-only" htmlFor="url">{t('link.label')}</label>
      <div className="url-box"><span className="link-icon">↗</span>
        <input id="url" type="text" placeholder={t('link.placeholder')} autoComplete="off" spellCheck={false} maxLength={4096} value={url} onChange={event => changeUrl(event.target.value)} disabled={busy} />
        <button className="primary" id="inspect" type="submit" disabled={busy}>{phase === 'inspect' ? t('link.inspecting') : <>{t('link.inspect')} <span>→</span></>}</button>
      </div>
    </form>
    <div className="input-foot"><span className="bili-tag">bilibili</span><span>{t('link.shareHint')}</span></div>
  </section>;
}
