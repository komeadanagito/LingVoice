import type { DownloadController } from '../hooks/useDownloader';
import { Select, type SelectOption } from './Select';
import { useI18n } from '../i18n';

type Props = Pick<DownloadController, 'busy' | 'quality' | 'setQuality' | 'video' | 'folder' | 'cookieFile' | 'chooseFolder' | 'chooseCookies' | 'clearCookies'>;

export function Preferences({ busy, quality, setQuality, video, folder, cookieFile, chooseFolder, chooseCookies, clearCookies }: Props) {
  const { t } = useI18n();

  const qualityOptions: SelectOption[] = [
    { value: 'best', label: t('preferences.best') },
    ...(video?.heights.map(height => ({
      value: String(height),
      label: t('preferences.resolution', { height }),
    })) ?? []),
  ];

  return <section className="card settings-card">
    <div className="section-title"><span className="step">02</span><h2>{t('preferences.title')}</h2><span className="subtle">{t('preferences.description')}</span></div>
    <div className="settings-grid">
      <div><label htmlFor="quality">{t('preferences.quality')}</label>
        <Select
          id="quality"
          value={quality}
          options={qualityOptions}
          onChange={val => setQuality(val)}
          disabled={busy}
        />
        <p className="field-hint">{t('preferences.qualityHint')}</p>
      </div>
      <div><label>{t('preferences.folder')}</label><div className="folder-box"><span>▤</span><span id="folder" title={folder}>{folder}</span><button id="choose-folder" type="button" disabled={busy} onClick={() => void chooseFolder()}>{t('preferences.change')}</button></div><p className="field-hint">{t('preferences.resumeHint')}</p></div>
    </div>
    <details id="advanced"><summary>{t('cookies.title')} <span>{t('cookies.optional')}</span></summary>
      <div className="cookie-row"><p id="cookie-label">{cookieFile ? t('cookies.selected', { file: cookieFile }) : t('cookies.none')}</p><button className="text-button" id="choose-cookies" disabled={busy} onClick={() => void chooseCookies()}>{t('cookies.choose')}</button>{cookieFile && <button className="text-button" id="clear-cookies" disabled={busy} onClick={() => void clearCookies()}>{t('cookies.clear')}</button>}</div>
      <p className="field-hint">{t('cookies.privacy')}</p>
    </details>
  </section>;
}
