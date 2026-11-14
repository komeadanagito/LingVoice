import { useState, useEffect, useRef } from 'react';
import { Sidebar } from './components/Sidebar';
import { TaskHistory } from './components/TaskHistory';
import { DownloadCard } from './components/DownloadCard';
import { VideoPlayer } from './components/VideoPlayer';
import { LanguageSwitcher } from './components/LanguageSwitcher';
import { ServicesSettings } from './components/ServicesSettings';
import { Icon } from './components/Icon';
import { videoEmbedUrl } from './utils/embed';
import { useDownloader } from './hooks/useDownloader';
import { useRightSidebarAnimation } from './hooks/useRightSidebarAnimation';
import { useI18n } from './i18n';
import { useTaskHistory } from './hooks/useTaskHistory';
import '../styles.css';
import './i18n.css';

export function App() {
  const controller = useDownloader();
  const { t, locale } = useI18n();
  const [openSidebar, setOpenSidebar] = useState<'left' | 'right' | null>('left');
  const sidebarCollapsed = openSidebar !== 'left';
  const rightSidebarOpen = openSidebar === 'right';
  const rightSidebarRef = useRef<HTMLElement>(null);
  useRightSidebarAnimation(rightSidebarRef, rightSidebarOpen);
  const [page, setPage] = useState<'download' | 'settings' | 'history'>('download');
  const history = useTaskHistory();
  const sourceSignature = useRef('');
  const inspectedTask = useRef('');
  const [subtitleToolsHost, setSubtitleToolsHost] = useState<HTMLDivElement | null>(null);

  useEffect(() => {
    document.documentElement.lang = locale;
    document.title = t('app.title');
  }, [locale, t]);

  useEffect(() => {
    if (!history.ready) return;
    const file = controller.completed ? controller.lastDownloadedFile : '';
    const embed = controller.video && !file ? videoEmbedUrl(controller.url, controller.video.id) : '';
    if (!file && !embed) { sourceSignature.current = ''; inspectedTask.current = ''; return; }
    const signature = file || embed;
    if (sourceSignature.current === signature) return;
    sourceSignature.current = signature;
    const title = controller.video
      ? (controller.video.titleKey ? t(controller.video.titleKey) : controller.video.title)
      : file.split(/[/\\]/).pop() || '';
    if (file && inspectedTask.current && history.replaceSource(inspectedTask.current, { title, file, embed: '' })) {
      inspectedTask.current = '';
    } else {
      const id = history.create({ title, file, embed });
      inspectedTask.current = embed ? id : '';
    }
  }, [controller.completed, controller.lastDownloadedFile, controller.video, controller.url, history.ready, history.create, history.replaceSource, t]);

  function openVideo(file: string, title: string) {
    history.create({ file, title: title || file.split(/[/\\]/).pop() || 'Video', embed: '' });
    setPage('download');
  }

  function openLocalVideo(file: File) {
    history.create(window.lingvoice.runtime === 'browser'
      ? { title: file.name, mediaFile: file, file: '', embed: '' }
      : { title: file.name, file: window.lingvoice.localFilePath(file), embed: '' });
  }

  function newTask() {
    history.select('');
    controller.changeUrl('');
    setPage('download');
  }

  function openTask(id: string) {
    history.select(id);
    setPage('download');
  }

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
        disabled={page !== 'download'}
        onClick={() => setOpenSidebar(value => value === 'right' ? null : 'right')}
        aria-label={t(rightSidebarOpen ? 'nav.collapseRightSidebar' : 'nav.expandRightSidebar')}
        title={t(rightSidebarOpen ? 'nav.collapseRightSidebar' : 'nav.expandRightSidebar')}
        aria-expanded={rightSidebarOpen}
        aria-controls="right-sidebar"
      >
        <Icon name="message" size={17} />
      </button>
      <Sidebar
        collapsed={sidebarCollapsed} page={page} onNavigate={setPage}
        taskCount={history.tasks.length} historyReady={history.ready}
        saving={history.saving} storageError={history.error}
        onNewTask={newTask}
      />

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

          <section className="history-page" hidden={page !== 'history'} aria-labelledby="task-history-heading">
            <TaskHistory tasks={history.tasks} activeTaskId={history.activeId} ready={history.ready} onOpenTask={openTask} onDeleteTask={history.remove} onNewTask={newTask} />
          </section>

          <div className="main-content" hidden={page !== 'download'}>
            {history.ready && <VideoPlayer
              key={`${history.activeId || 'new-task'}:${history.activeTask?.file || history.activeTask?.embed || ''}`}
              taskId={history.activeId}
              mediaFile={history.activeTask?.mediaFile}
              savedSubtitles={history.activeTask?.subtitles}
              onSaveSubtitles={history.update}
              onOpenFile={openLocalVideo}
              onOpenRecent={openVideo}
              subtitleToolsHost={subtitleToolsHost}
              initialFile={history.activeTask?.file || ''}
              initialEmbed={history.activeTask?.embed || ''}
              initialTitle={history.activeTask?.title || ''}
              recentDownloadedFile={controller.lastDownloadedFile}
              recentDownloadedTitle={videoTitle}
            />}

            <DownloadCard
              {...controller}
              onPlayVideo={(file, title) => openVideo(file, title || '')}
            />
          </div>

          <footer className="sr-only">
            <span>◇ {t('footer.legal')}</span>
            <span>{t('footer.tagline')}</span>
          </footer>
        </main>
      </div>
      <aside
        ref={rightSidebarRef}
        id="right-sidebar"
        className={`right-sidebar${rightSidebarOpen ? '' : ' collapsed'}`}
        aria-label={t('nav.rightSidebar')}
        aria-hidden={!rightSidebarOpen}
        inert={!rightSidebarOpen}
      >
        <div className="right-sidebar-tools" ref={setSubtitleToolsHost} hidden={page !== 'download'} />
      </aside>
    </div>
  );
}
