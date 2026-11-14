import logo from '../../../icon/lingvoice-logo.svg';
import { useI18n } from '../i18n';
import { Icon } from './Icon';

type Props = {
  collapsed: boolean;
  page: 'download' | 'settings' | 'history';
  onNavigate: (page: 'download' | 'settings' | 'history') => void;
  taskCount: number;
  historyReady: boolean;
  saving: boolean;
  storageError: string;
  onNewTask: () => void;
};

export function Sidebar({ collapsed, page, onNavigate, taskCount, historyReady, saving, storageError, onNewTask }: Props) {
  const { t, locale } = useI18n();
  const zh = locale === 'zh-CN';
  return (
    <aside className={`sidebar${collapsed ? ' collapsed' : ''}`} inert={collapsed}>
      <div className="sidebar-top" aria-hidden="true" />
      <div className="brand" aria-hidden={collapsed}>
        <img src={logo} alt={t('app.logoAlt')} />
        <div>
          <strong>{t('app.brand')}</strong>
          {t('app.brand') !== 'LingVoice' && <span>LingVoice</span>}
        </div>
      </div>
      <nav id="sidebar-navigation" aria-label={t('nav.navigation')}>
        <button type="button" className={`nav-item${page === 'download' ? ' active' : ''}`} disabled={!historyReady} onClick={onNewTask} aria-label={t('nav.download')} aria-current={page === 'download' ? 'page' : undefined}>
          <Icon name="addTask" size={18} />
          <span className="nav-label">{t('nav.download')}</span>
        </button>
        <button type="button" className={`nav-item nav-history${page === 'history' ? ' active' : ''}`} onClick={() => onNavigate('history')} aria-current={page === 'history' ? 'page' : undefined}>
          <Icon name="history" size={18} />
          <span className="nav-label">{zh ? '历史记录' : 'History'}</span>
          <span className="nav-count">{taskCount}</span>
        </button>
      </nav>
      <div className="sidebar-save-status" data-save-state={storageError ? 'error' : !historyReady ? 'loading' : saving ? 'saving' : 'saved'}>
        {(storageError || !historyReady || saving) && <p className={`task-history-save${storageError ? ' has-error' : ''}`} role={storageError ? 'alert' : 'status'}>
          {storageError
            ? (zh ? '保存失败，刷新可能丢失内容。请检查本地服务与磁盘空间。' : 'Save failed. Refreshing may lose changes. Check the local service and disk space.')
            : !historyReady ? (zh ? '正在读取任务…' : 'Loading tasks…')
            : (zh ? '正在保存…' : 'Saving…')}
        </p>}
        {storageError && <p className="task-history-error-detail">{storageError}</p>}
      </div>
      <button type="button" className={`icon-button sidebar-settings${page === 'settings' ? ' active' : ''}`} onClick={() => onNavigate('settings')} aria-label={t('nav.settings')} aria-current={page === 'settings' ? 'page' : undefined}>
        <Icon name="settings" />
      </button>
    </aside>
  );
}
