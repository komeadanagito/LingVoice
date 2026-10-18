import { useState, useEffect } from 'react';
import { Sidebar } from './components/Sidebar';
import { DownloadCard } from './components/DownloadCard';
import { VideoPlayer } from './components/VideoPlayer';
import { LanguageSwitcher } from './components/LanguageSwitcher';
import { ServicesSettings } from './components/ServicesSettings';
import { Icon } from './components/Icon';
import { videoEmbedUrl } from './utils/embed';
import { useDownloader } from './hooks/useDownloader';
import { useI18n } from './i18n';
import '../styles.css';
import './i18n.css';

export function App() {
  const controller = useDownloader();
  const { t, locale } = useI18n();
  const [openSidebar, setOpenSidebar] = useState<'left' | 'right' | null>('left');
  const sidebarCollapsed = openSidebar !== 'left';
  const rightSidebarOpen = openSidebar === 'right';
  const [page, setPage] = useState<'download' | 'settings'>('download');
  const [playerFile, setPlayerFile] = useState('');
  const [playerTitle, setPlayerTitle] = useState('');

  useEffect(() => {
    document.documentElement.lang = locale;
    document.title = t('app.title');
  }, [locale, t]);

  useEffect(() => {
    if (controller.completed && controller.lastDownloadedFile) {
      setPlayerFile(controller.lastDownloadedFile);
      const title = controller.video
        ? (controller.video.titleKey ? t(controller.video.titleKey) : controller.video.title)
        : controller.lastDownloadedFile.split(/[/\\]/).pop() || '';
      setPlayerTitle(title);
    } else if (controller.video) {
      const title = controller.video.titleKey ? t(controller.video.titleKey) : controller.video.title;
      setPlayerTitle(title);
      setPlayerFile('');
    }
  }, [controller.completed, controller.lastDownloadedFile, controller.video, t]);

  const videoTitle = controller.video
    ? (controller.video.titleKey ? t(controller.video.titleKey) : controller.video.title)
    : '';

  return (
    <div className={`app-container${sidebarCollapsed ? ' is-sidebar-collapsed' : ''}${rightSidebarOpen ? ' is-right-sidebar-open' : ''}`}>
      <button
        type="button"
        className="icon-button app-sidebar-toggle"
        onClick={() => setOpenSidebar(value => value === 'left' ? null : 'left')}
        aria-label={t(sidebarCollapsed ? 'nav.expandSidebar' : 'nav.collapseSidebar')}
        aria-expanded={!sidebarCollapsed}
        aria-controls="sidebar-navigation"
      >
        <Icon name="sidebar" size={17} />
      </button>
      <button
        type="button"
        className={`icon-button app-right-sidebar-toggle${rightSidebarOpen ? ' active' : ''}`}
        onClick={() => setOpenSidebar(value => value === 'right' ? null : 'right')}
        aria-label={t(rightSidebarOpen ? 'nav.collapseRightSidebar' : 'nav.expandRightSidebar')}
        title={t(rightSidebarOpen ? 'nav.collapseRightSidebar' : 'nav.expandRightSidebar')}
        aria-expanded={rightSidebarOpen}
        aria-controls="right-sidebar"
      >
        <Icon name="message" size={17} />
      </button>
      <Sidebar collapsed={sidebarCollapsed} page={page} onNavigate={setPage} />

      <div className="app-main-area">
        <header className="top-navbar" />

        <main>
          <h1 className="sr-only">{t('heading.title')}</h1>
          <section className="settings-page" hidden={page !== 'settings'} aria-labelledby="settings-title">
            <div className="settings-page-heading"><h2 id="settings-title">{t('nav.settings')}</h2><p>{locale === 'zh-CN' ? '管理通用偏好、Provider 与翻译 / 语音识别' : 'Manage preferences, providers, translation and speech recognition'}</p></div>
            <div className="card settings-language-card settings-section">
              <div className="settings-section-heading"><h3>{locale === 'zh-CN' ? '通用' : 'General'}</h3></div>
              <LanguageSwitcher {...controller} />
            </div>
            <ServicesSettings />
          </section>

          <div className="main-content" hidden={page !== 'download'}>
            <VideoPlayer
              initialFile={playerFile}
              initialEmbed={controller.video && !playerFile ? videoEmbedUrl(controller.url, controller.video.id) : ''}
              initialTitle={playerTitle || videoTitle}
              recentDownloadedFile={controller.lastDownloadedFile}
              recentDownloadedTitle={videoTitle}
            />

            <DownloadCard
              {...controller}
              onPlayVideo={(file, title) => {
                setPlayerFile(file);
                setPlayerTitle(title || '');
              }}
            />
          </div>

          <footer className="sr-only">
            <span>◇ {t('footer.legal')}</span>
            <span>{t('footer.tagline')}</span>
          </footer>
        </main>
      </div>
      <aside
        id="right-sidebar"
        className={`right-sidebar${rightSidebarOpen ? '' : ' collapsed'}`}
        aria-label={t('nav.rightSidebar')}
        aria-hidden={!rightSidebarOpen}
        inert={!rightSidebarOpen}
      />
    </div>
  );
}
