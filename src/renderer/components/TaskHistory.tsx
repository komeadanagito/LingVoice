import { useI18n } from '../i18n';
import { taskStatus, type HistoryTask } from '../utils/task-history';
import { Icon } from './Icon';

interface Props {
  tasks: HistoryTask[];
  activeTaskId: string;
  ready: boolean;
  onOpenTask: (id: string) => void;
  onDeleteTask: (id: string) => void;
  onNewTask: () => void;
}

export function TaskHistory({ tasks, activeTaskId, ready, onOpenTask, onDeleteTask, onNewTask }: Props) {
  const { locale } = useI18n();
  const zh = locale === 'zh-CN';
  const statuses = zh
    ? { created: '已创建', recognized: '已识别', translated: '已翻译', dubbed: '配音完成' }
    : { created: 'Created', recognized: 'Transcribed', translated: 'Translated', dubbed: 'Dubbed' };
  const ordered = [...tasks].sort((a, b) => b.updatedAt - a.updatedAt);
  return <div className="task-history">
    <header className="task-history-heading">
      <div>
        <h2 id="task-history-heading">{zh ? '历史记录' : 'Task history'} <span>{tasks.length}</span></h2>
        <p>{zh ? '查看已创建的任务，继续识别、翻译或配音。' : 'Open a saved task to continue transcription, translation or dubbing.'}</p>
      </div>
      <button type="button" className="choose-file-button" onClick={onNewTask} disabled={!ready}><Icon name="addTask" size={16} />{zh ? '新建任务' : 'New task'}</button>
    </header>
    {!ready ? <p className="task-history-empty" role="status">{zh ? '正在读取任务…' : 'Loading tasks…'}</p>
      : !tasks.length ? <div className="task-history-empty-state">
        <Icon name="history" size={32} />
        <h3>{zh ? '还没有历史任务' : 'No saved tasks yet'}</h3>
        <p>{zh ? '打开视频或解析链接后，任务会自动保存在这里。' : 'Open a video or inspect a link to automatically save a task here.'}</p>
        <button type="button" className="choose-file-button" onClick={onNewTask}>{zh ? '创建第一个任务' : 'Create your first task'}</button>
      </div> : <div className="task-history-list" aria-label={zh ? '已保存的任务列表' : 'Saved tasks'}>
        {ordered.map(task => {
          const count = task.subtitles?.cues.length ?? 0;
          const translated = task.subtitles?.cues.filter(cue => cue.translated?.trim()).length ?? 0;
          return <div className={`task-history-row${activeTaskId === task.id ? ' is-active' : ''}`} key={task.id}>
            <button type="button" className="task-history-open" onClick={() => onOpenTask(task.id)} title={task.title}>
              <span className="task-history-title"><Icon name="video" size={19} /><span>{task.title || (zh ? '未命名任务' : 'Untitled task')}</span></span>
              <span className="task-history-meta">{statuses[taskStatus(task)]}{count > 0 ? ` · ${translated}/${count} ${zh ? '条已翻译' : 'translated'}` : ''}</span>
              <time dateTime={new Date(task.updatedAt).toISOString()}>{new Date(task.updatedAt).toLocaleString(locale, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</time>
            </button>
            <button type="button" className="task-history-delete" aria-label={`${zh ? '删除任务' : 'Delete task'} ${task.title}`} title={zh ? '删除历史记录' : 'Delete history entry'} onClick={() => {
              if (window.confirm(zh ? `删除任务「${task.title}」的历史、字幕和配音记录？磁盘上的视频与导出文件不会删除。` : `Delete the history, subtitles and dubbing record for “${task.title}”? Videos and exported files on disk will be kept.`)) onDeleteTask(task.id);
            }}>×</button>
          </div>;
        })}
      </div>}
    <p className="task-history-note">{window.lingvoice.runtime === 'browser'
      ? (zh ? '历史记录与字幕保存在服务端 SQLite 数据库，视频文件单独保存在磁盘；清除浏览器数据不会删除已保存任务。' : 'History and subtitles are stored in the server SQLite database; videos are stored on disk. Clearing browser data does not delete saved tasks.')
      : (zh ? '历史记录保存在本机 SQLite 数据库；请保留原视频文件，移动或删除后需重新打开。' : 'History is saved in SQLite on this device. Keep source videos at their original paths.')}</p>
  </div>;
}
