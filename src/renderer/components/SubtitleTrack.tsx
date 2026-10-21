import { useEffect, useRef, useState } from 'react';
import { useI18n } from '../i18n';
import { activeSubtitles, exportSubtitles, parseSubtitles, subtitleBatches, type SubtitleCue } from '../utils/subtitles';
import { Select, type SelectOption } from './Select';
import { DubbingPanel } from './DubbingPanel';

function formatTimestamp(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '00:00';
  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const mins = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hours > 0) {
    return `${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

type Mode = 'bilingual' | 'original' | 'translated' | 'off';

export function useSubtitleTrack(videoSrc: string, embedSrc: string, currentTime: number, localPath: string, onSeek?: (time: number) => void) {
  const { locale } = useI18n();
  const zh = locale === 'zh-CN';
  const [cues, setCues] = useState<SubtitleCue[]>([]);
  const [mode, setMode] = useState<Mode>('bilingual');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState('');
  const [error, setError] = useState('');
  const [offset, setOffset] = useState(0);
  const [fontSize, setFontSize] = useState(22);
  const [search, setSearch] = useState('');
  const [autoScroll, setAutoScroll] = useState(true);
  const listRef = useRef<HTMLDivElement>(null);
  const generation = useRef(0);
  const running = useRef(false);
  const recognizing = useRef(false);
  const [confirmAsr, setConfirmAsr] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const effectiveTime = currentTime - offset;
  const activeCue = cues.find(cue => cue.start <= effectiveTime && effectiveTime < cue.end);
  const activeCueId = activeCue?.id;

  useEffect(() => {
    if (!autoScroll || !activeCueId || !listRef.current) return;
    const element = listRef.current.querySelector<HTMLElement>(`[data-cue-id="${activeCueId}"]`);
    if (element) {
      element.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }, [activeCueId, autoScroll]);

  const filteredCues = search.trim()
    ? cues.filter(cue =>
        cue.text.toLowerCase().includes(search.toLowerCase()) ||
        (cue.translated && cue.translated.toLowerCase().includes(search.toLowerCase()))
      )
    : cues;
  useEffect(() => {
    generation.current++; running.current = false;
    setCues([]); setName(''); setError(''); setProgress(''); setBusy(false); setOffset(0); setConfirmAsr(false);
    return () => {
      generation.current++; running.current = false;
      if (recognizing.current) { recognizing.current = false; void window.lingvoice.cancelAsr().catch(() => {}); }
    };
  }, [videoSrc, embedSrc]);
  useEffect(() => window.lingvoice.onAsrProgress(progress => {
    if (!recognizing.current) return;
    setProgress(progress.stage === 'extracting'
      ? (zh ? '正在从视频提取音频…' : 'Extracting audio from video…')
      : `${zh ? '正在识别音频' : 'Transcribing audio'} ${progress.completed}/${progress.total}`);
  }), [zh]);

  async function recognize() {
    if (running.current || !localPath) return;
    const token = ++generation.current;
    running.current = true; recognizing.current = true; setBusy(true); setError(''); setConfirmAsr(false);
    setProgress(zh ? '正在准备语音识别…' : 'Preparing speech recognition…');
    try {
      const config = await window.lingvoice.asrConfig();
      if (token !== generation.current) return;
      if (!config.ok) throw new Error(config.error);
      if (!config.data.settings.providerId && !config.data.settings.baseUrl) throw new Error(zh ? '请先在设置中填写语音识别 Base URL 或选择 Provider。' : 'Configure speech recognition Base URL or select a Provider in Settings first.');
      const result = await window.lingvoice.transcribe({ file: localPath });
      if (token !== generation.current) return;
      if (!result.ok) throw new Error(result.error);
      setCues(result.data); setName('transcription.srt'); setOffset(0);
      setProgress(zh ? '语音识别完成，可翻译字幕或直接导出。' : 'Transcription complete. Translate the subtitles or export them.');
    } catch (error) {
      if (token === generation.current) { setProgress(''); setError(error instanceof Error ? error.message : String(error)); }
    } finally { if (token === generation.current) { recognizing.current = false; running.current = false; setBusy(false); } }
  }

  async function importFile(file: File) {
    const token = ++generation.current;
    setError(''); setProgress('');
    try {
      if (file.size > 5 * 1024 * 1024) throw new Error(zh ? '字幕文件不能超过 5 MB' : 'Subtitle file must be under 5 MB');
      const parsed = parseSubtitles(await file.text());
      if (generation.current !== token) return;
      setCues(parsed); setName(file.name); setOffset(0);
    } catch (error) { if (generation.current === token) setError(error instanceof Error ? error.message : String(error)); }
  }

  async function translate() {
    if (running.current) return;
    const token = ++generation.current;
    running.current = true; setBusy(true); setError('');
    setCues(previous => previous.map(({ translated: _translated, ...cue }) => cue));
    setProgress(zh ? '正在读取翻译配置…' : 'Loading translation settings…');
    try {
      const config = await window.lingvoice.translationConfig();
      if (!config.ok) throw new Error(config.error);
      if (!config.data.settings.providerId) throw new Error(zh ? '请先在设置中选择并保存字幕翻译 Provider。' : 'Choose and save a subtitle translation provider in Settings first.');
      const fingerprint = JSON.stringify(config.data.settings);
      const batches = subtitleBatches(cues);
      let completed = 0;
      for (const batch of batches) {
        if (generation.current !== token) return;
        // Stop if another page changed the service or language while this task was running.
        const latest = await window.lingvoice.translationConfig();
        if (!latest.ok) throw new Error(latest.error);
        if (JSON.stringify(latest.data.settings) !== fingerprint) throw new Error(zh ? '翻译配置已变更，请重新翻译以保持语言一致。' : 'Translation settings changed. Restart translation for consistent output.');
        if (generation.current !== token) return;
        setProgress(`${zh ? '翻译中' : 'Translating'} ${completed}/${cues.length}`);
        const result = await window.lingvoice.translateSubtitles({ texts: batch.map(cue => cue.text) });
        if (generation.current !== token) return;
        if (!result.ok) throw new Error(result.error);
        const translated = new Map(batch.map((cue, i) => [cue.id, result.data[i]]));
        setCues(previous => previous.map(cue => translated.has(cue.id) ? { ...cue, translated: translated.get(cue.id) } : cue));
        completed += batch.length;
      }
      setProgress(`${zh ? '翻译完成' : 'Translated'} ${completed}/${cues.length}`);
    } catch (error) { if (generation.current === token) { setError(error instanceof Error ? error.message : String(error)); setProgress(''); } }
    finally { if (generation.current === token) { running.current = false; setBusy(false); } }
  }
  function stop() {
    if (recognizing.current) { recognizing.current = false; void window.lingvoice.cancelAsr().catch(() => {}); }
    generation.current++; running.current = false; setBusy(false);
    setProgress(zh ? '已停止，保留现有字幕；已发送的请求可能仍会计费。' : 'Stopped. Existing subtitles kept; requests already sent may still be billed.');
  }
  function download() {
    const url = URL.createObjectURL(new Blob([exportSubtitles(cues, mode === 'off' ? 'bilingual' : mode)], { type: 'text/plain;charset=utf-8' }));
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = `${name.replace(/\.(srt|vtt)$/i, '')}.${mode === 'off' ? 'bilingual' : mode}.srt`; anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  const modeOptions: SelectOption[] = [
    { value: 'bilingual', label: zh ? '双语字幕' : 'Bilingual' },
    { value: 'translated', label: zh ? '仅译文' : 'Translation only' },
    { value: 'original', label: zh ? '仅原文' : 'Original only' },
    { value: 'off', label: zh ? '关闭字幕' : 'Off' },
  ];
  const fontOptions: SelectOption[] = [18, 22, 26, 30].map(size => ({
    value: String(size),
    label: `${size}px`,
  }));

  const enabled = Boolean(videoSrc && !embedSrc);
  const active = mode === 'off' ? [] : activeSubtitles(cues, currentTime - offset);
  const toolbar = <div className="subtitle-workspace">
    <div className="subtitle-toolbar">
      <input ref={input} className="sr-only" type="file" accept=".srt,.vtt" aria-label={zh ? '导入字幕' : 'Import subtitles'} onChange={event => { const file = event.target.files?.[0]; if (file) void importFile(file); event.target.value = ''; }} disabled={!enabled || busy} />
      <button type="button" className="choose-file-button" disabled={!enabled || busy} onClick={() => input.current?.click()}>{zh ? '导入字幕' : 'Import subtitles'}</button>
      <button type="button" className="choose-file-button asr-start" disabled={!enabled || !localPath || busy} onClick={() => setConfirmAsr(value => !value)}>{zh ? '识别音频' : 'Transcribe audio'}</button>
      {busy && <button type="button" className="text-button subtitle-stop" onClick={stop}>{zh ? '停止' : 'Stop'}</button>}
      <Select
        value={mode}
        options={modeOptions}
        onChange={val => setMode(val as Mode)}
        className="subtitle-select"
        aria-label={zh ? '字幕显示模式' : 'Subtitle display mode'}
      />
      <DubbingPanel file={localPath} cues={cues} offset={offset} disabled={busy || !enabled} sourceKey={videoSrc} />
      {cues.length > 0 && <>
        <button type="button" className="primary" disabled={busy} onClick={() => void translate()}>{zh ? '翻译字幕' : 'Translate'}</button>
        <button type="button" className="text-button" onClick={download}>{zh ? '导出 SRT' : 'Export SRT'}</button>
        <label className="subtitle-offset">{zh ? '延迟' : 'Delay'}<input type="number" min={-60} max={60} step={0.1} value={offset} onChange={event => { const value = Number(event.target.value); setOffset(Number.isFinite(value) ? Math.max(-60, Math.min(60, value)) : 0); }} />s</label>
        <Select
          value={String(fontSize)}
          options={fontOptions}
          onChange={val => setFontSize(Number(val))}
          className="subtitle-select subtitle-size-select"
          aria-label={zh ? '字幕字号' : 'Subtitle font size'}
        />
      </>}
    </div>
    {confirmAsr && <div className="asr-consent" role="group" aria-label={zh ? '确认音频上传' : 'Confirm audio upload'}><span>{window.lingvoice.runtime === 'browser' ? (zh ? '当前视频将上传到本机 Web 后端，提取的音频再发送至 ASR Provider，可能产生费用。临时视频会在任务结束后删除，识别结果将替换当前字幕。继续吗？' : 'This video will be uploaded to the local Web backend, then extracted audio will be sent to your ASR provider and may incur charges. Temporary media is deleted after the task. The result replaces current subtitles. Continue?') : (zh ? '将提取并上传当前视频的音频到 ASR Provider，可能产生费用。完成后替换当前字幕，继续吗？' : 'Audio from this video will be uploaded to your ASR provider and may incur charges. The result will replace current subtitles. Continue?')}</span><button type="button" className="primary asr-confirm" disabled={busy} onClick={() => void recognize()}>{zh ? '确认并识别' : 'Confirm and transcribe'}</button><button type="button" className="text-button" onClick={() => setConfirmAsr(false)}>{zh ? '取消' : 'Cancel'}</button></div>}
    {name && <p className="subtitle-hint">{`${name} · ${cues.length} ${zh ? '条字幕' : 'cues'}`}</p>}
    {progress && <p className="subtitle-hint" role="status">{progress}</p>}{error && <p className="settings-error" role="alert">{error}</p>}
    <div className="subtitle-transcript-panel" aria-label={zh ? '翻译时间戳窗口' : 'Transcript window'}>
      {cues.length > 5 && (
        <div className="transcript-search-box">
          <svg className="search-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            type="text"
            placeholder={zh ? '搜索台词或译文…' : 'Search transcript…'}
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="transcript-search-input"
          />
          {search && (
            <button type="button" className="transcript-search-clear" onClick={() => setSearch('')} aria-label={zh ? '清空搜索' : 'Clear search'}>
              ×
            </button>
          )}
        </div>
      )}

      {cues.length === 0 ? (
        <div className="transcript-empty-state">
          <div className="transcript-empty-icon">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
              <path d="M8 9h8" />
              <path d="M8 13h5" />
            </svg>
          </div>
        </div>
      ) : filteredCues.length === 0 ? (
        <div className="transcript-empty-state">
          <div className="transcript-empty-icon">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
          </div>
        </div>
      ) : (
        <div className="transcript-list" ref={listRef} role="feed" aria-label={zh ? '台词列表' : 'Transcript list'}>
          {filteredCues.map(cue => {
            const isActive = cue.id === activeCueId;
            return (
              <div
                key={cue.id}
                data-cue-id={cue.id}
                className={`transcript-cue-item${isActive ? ' is-active' : ''}`}
                onClick={() => onSeek?.(cue.start + offset)}
                role="button"
                tabIndex={0}
                onKeyDown={e => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onSeek?.(cue.start + offset);
                  }
                }}
              >
                <div className="transcript-cue-top">
                  <span
                    className="transcript-time-badge"
                    title={zh ? '点击跳转到此时间点' : 'Click to seek to timestamp'}
                  >
                    <svg width="8" height="8" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                      <polygon points="5 3 19 12 5 21 5 3" />
                    </svg>
                    <span>{formatTimestamp(cue.start + offset)} - {formatTimestamp(cue.end + offset)}</span>
                  </span>
                  <span className="transcript-cue-num">#{cue.id}</span>
                </div>
                {mode !== 'original' && cue.translated && (
                  <div className="transcript-cue-translation">{cue.translated}</div>
                )}
                {(mode !== 'translated' || !cue.translated) && (
                  <div className={`transcript-cue-text${mode === 'bilingual' && cue.translated ? ' is-secondary' : ''}`}>
                    {cue.text}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  </div>;
  const overlay = active.length > 0 && <div className="subtitle-overlay" style={{ fontSize }}>
    {active.map(cue => <div className="subtitle-cue" key={cue.id}>
      {mode !== 'original' && cue.translated && <div className="subtitle-translation"><span>{cue.translated}</span></div>}
      {(mode !== 'translated' || !cue.translated) && <div className={mode === 'bilingual' && cue.translated ? 'subtitle-original secondary' : 'subtitle-original'}><span>{cue.text}</span></div>}
    </div>)}
  </div>;
  return { toolbar, overlay, cues, offset, snapshot: { cues, offset, file: localPath, sourceKey: videoSrc } };
}
