import logo from '../../../icon/lingvoice-logo.svg';
import { useI18n } from '../i18n';
import { Icon } from './Icon';

type Props = {
  collapsed: boolean;
  page: 'download' | 'settings';
  onNavigate: (page: 'download' | 'settings') => void;
};

export function Sidebar({ collapsed, page, onNavigate }: Props) {
  const { t } = useI18n();
  return (
    <aside className={`sidebar${collapsed ? ' collapsed' : ''}`}>
      <div className="sidebar-top" aria-hidden="true" />

      <div className="brand" aria-hidden={collapsed}>
        <img src={logo} alt={t('app.logoAlt')} />
        <div>
          <strong>{t('app.brand')}</strong>
          {t('app.brand') !== 'LingVoice' && <span>LingVoice</span>}
        </div>
      </div>
      <nav id="sidebar-navigation" aria-label={t('nav.navigation')}>
        <button type="button" className={`nav-item${page === 'download' ? ' active' : ''}`} onClick={() => onNavigate('download')} aria-label={t('nav.download')} aria-current={page === 'download' ? 'page' : undefined}>
          <Icon name="addTask" size={18} />
          <span className="nav-label">{t('nav.download')}</span>
          <span className="nav-dot" />
        </button>
      </nav>
      <button type="button" className={`icon-button sidebar-settings${page === 'settings' ? ' active' : ''}`} onClick={() => onNavigate('settings')} aria-label={t('nav.settings')} aria-current={page === 'settings' ? 'page' : undefined}>
        <Icon name="settings" />
      </button>
    </aside>
  );
}
