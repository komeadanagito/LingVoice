import { useCallback, useEffect, useRef, useState } from 'react';
import { registerTaskRuntime, taskQueue } from '../utils/task-queue';
import { useI18n } from '../i18n';
import { advanceTranslationMemory, translationWindow, type TranslationMemoryState } from '../../shared/translation';
import { activeSubtitles, exportSubtitles, subtitleBatches, type SubtitleCue } from '../utils/subtitles';
import type { DubbingResult } from '../../shared/dubbing';
import { filePathToMediaUrl } from '../utils/media';
import { Icon } from './Icon';
import type { SavedSubtitles } from '../utils/task-history';
import { Select, type SelectOption } from './Select';

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
type SubtitleStage = 'recognize' | 'translate' | 'dub';

export function useSubtitleTrack(videoSrc: string, embedSrc: string, currentTime: number, localPath: string, onSeek?: (time: number) => void, saved?: SavedSubtitles, onSave?: (snapshot: SavedSubtitles) => void, sourceKey?: string) {
  const { locale } = useI18n();
  const zh = locale === 'zh-CN';
  const [cues, setCueState] = useState<SubtitleCue[]>(saved?.cues ?? []);
  const cuesRef = useRef(cues);
  const setCues = useCallback((next: SubtitleCue[]) => { cuesRef.current = next; setCueState(next); }, []);
  const [mode, setMode] = useState<Mode>(saved?.mode ?? 'bilingual');
  const [name, setName] = useState(saved?.name ?? '');
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState<SubtitleStage | null>(null);
  const translationFingerprint = useRef(saved?.translationFingerprint ?? '');
  const mediaKey = sourceKey || `${videoSrc}|${embedSrc}`;
  const previousSource = useRef(mediaKey);
  const [progress, setProgress] = useState('');
  const [error, setError] = useState('');
  const [offset, setOffset] = useState(saved?.offset ?? 0);
  const [fontSize, setFontSize] = useState(saved?.fontSize ?? 22);
  const [search, setSearch] = useState('');
  const [autoScroll, setAutoScroll] = useState(true);
  const [result, setResult] = useState<DubbingResult | null>(saved?.result ?? null);
  const listRef = useRef<HTMLDivElement>(null);
  const generation = useRef(0);
  const running = useRef(false);
  const recognizing = useRef(false);
  const dubbingJob = useRef<string | null>(null);
  const lastSnapshot = useRef<SavedSubtitles>({ cues, mode, name, offset, fontSize, result, translationFingerprint: translationFingerprint.current });

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
    if (previousSource.current !== mediaKey) {
      previousSource.current = mediaKey;
      translationFingerprint.current = '';
      setCues([]); setName(''); setOffset(0); setResult(null);
    }
    setStage(null);
    setError(''); setProgress(''); setBusy(false);
    return () => {
      generation.current++; running.current = false;
      if (recognizing.current) { recognizing.current = false; void window.lingvoice.cancelAsr().catch(() => {}); }
      if (dubbingJob.current) {
        const id = dubbingJob.current;
        dubbingJob.current = null;
        void window.lingvoice.cancelDubbing?.(id).catch(() => {});
      }
    };
  }, [mediaKey]);

  useEffect(() => {
    const snapshot: SavedSubtitles = { cues, mode, name, offset, fontSize, result, translationFingerprint: translationFingerprint.current };
    const previous = lastSnapshot.current;
    if (previous.cues === cues && previous.mode === mode && previous.name === name && previous.offset === offset && previous.fontSize === fontSize && previous.result === result && previous.translationFingerprint === snapshot.translationFingerprint) return;
    lastSnapshot.current = snapshot;
    onSave?.(snapshot);
  }, [cues, mode, name, offset, fontSize, result, onSave]);

  useEffect(() => window.lingvoice.onAsrProgress?.(progress => {
    if (!recognizing.current) return;
    setProgress(progress.stage === 'extracting'
      ? (zh ? '正在从视频提取音频…' : 'Extracting audio from video…')
      : `${zh ? '正在识别音频' : 'Transcribing audio'} ${progress.completed}/${progress.total}`);
  }), [zh]);

  useEffect(() => window.lingvoice.onDubbingProgress?.(event => {
    if (!dubbingJob.current || event.jobId !== dubbingJob.current) return;
    const stageMap: Record<string, string> = {
      preparing: zh ? '正在准备配音环境…' : 'Preparing dubbing environment…',
      separating: zh ? '正在分离人声与背景音乐…' : 'Separating vocals and background…',
      translating: zh ? '正在校对配音台词…' : 'Preparing spoken text…',
      voice: zh ? '正在提取并复刻音色…' : 'Extracting and cloning voice…',
      synthesizing: `${zh ? '正在生成配音语音' : 'Generating speech'} ${event.completed}/${event.total}`,
      aligning: `${zh ? '正在对齐配音时间轴' : 'Aligning dubbing timeline'} ${event.completed}/${event.total}`,
      mixing: zh ? '正在混音渲染最终视频…' : 'Mixing and exporting final video…',
    };
    setProgress(stageMap[event.stage] || `${zh ? '配音处理中：' : 'Dubbing: '}${event.message}`);
  }), [zh]);

  const queueId = sourceKey || mediaKey;
  async function runStage(nextStage: SubtitleStage) {
    return taskQueue.enqueue(queueId, async signal => {
      const cancel = () => stop();
      signal.addEventListener('abort', cancel, { once: true });
      try { signal.throwIfAborted(); await executeStage(nextStage); signal.throwIfAborted(); }
      finally { signal.removeEventListener('abort', cancel); }
    });
  }
  const runtimeActionsRef = useRef({ executeStage, stop });
  runtimeActionsRef.current = { executeStage, stop };
  useEffect(() => registerTaskRuntime(queueId, {
    source: localPath,
    stop: () => runtimeActionsRef.current.stop(),
    pipeline: async signal => {
      const cancel = () => runtimeActionsRef.current.stop();
      signal.addEventListener('abort', cancel, { once: true });
      try {
        signal.throwIfAborted();
        if (!cuesRef.current.length) await runtimeActionsRef.current.executeStage('recognize');
        signal.throwIfAborted();
        if (cuesRef.current.some(cue => !cue.translated?.trim())) await runtimeActionsRef.current.executeStage('translate');
        signal.throwIfAborted();
        await runtimeActionsRef.current.executeStage('dub');
        signal.throwIfAborted();
      } finally { signal.removeEventListener('abort', cancel); }
    },
  }), [queueId, localPath]);
  useEffect(() => {
    if (busy) taskQueue.update(queueId, { state: 'running', stage: stage ?? '', progress });
  }, [busy, stage, progress, queueId]);

  async function executeStage(nextStage: SubtitleStage) {
    if (running.current || !localPath) throw new Error(zh ? '任务正在运行或视频尚未就绪。' : 'Task is running or video is not ready.');
    if (nextStage !== 'recognize' && !cuesRef.current.length) throw new Error(zh ? '请先识别字幕。' : 'Transcribe subtitles first.');
    if (nextStage === 'dub' && cuesRef.current.some(cue => !cue.translated?.trim())) throw new Error(zh ? '请先完成字幕翻译。' : 'Complete subtitle translation first.');
    const token = ++generation.current;
    running.current = true;
    setBusy(true);
    setStage(nextStage);
    setError('');
    setResult(null);

    try {
      let workingCues: SubtitleCue[] = cuesRef.current.map(cue => ({ ...cue }));
      if (nextStage === 'recognize') {
      setProgress(zh ? '正在准备音频识别…' : 'Preparing audio transcription…');
      const asrConfig = await window.lingvoice.asrConfig();
      if (token !== generation.current) return;
      if (!asrConfig.ok) throw new Error(asrConfig.error);
      if (asrConfig.data.settings.mode !== 'local' && !asrConfig.data.settings.providerId && !asrConfig.data.settings.baseUrl) {
        throw new Error(zh ? '请先在「设置 - 语音识别」中填写 Base URL 或选择 Provider。' : 'Configure speech recognition Base URL or select a Provider in Settings first.');
      }

      recognizing.current = true;
      const asrResult = await window.lingvoice.transcribe({ file: localPath });
      recognizing.current = false;
      if (token !== generation.current) return;
      if (!asrResult.ok) throw new Error(asrResult.error);
      if (!asrResult.data.length) throw new Error(zh ? '未在视频中识别到有效台词内容。' : 'No speech recognized from the video.');

      workingCues = asrResult.data.map(cue => ({ ...cue }));
      translationFingerprint.current = '';
      setCues(workingCues);
      setName('transcription.srt');
      setOffset(0);
      setProgress(zh ? `音频识别完成，共 ${workingCues.length} 条字幕。点击「翻译」继续。` : `Transcription complete: ${workingCues.length} cues. Click Translate to continue.`);
      return;
      }

      if (nextStage === 'translate') {
      setProgress(zh ? '正在准备字幕翻译…' : 'Preparing subtitle translation…');
      const transConfig = await window.lingvoice.translationConfig();
      if (token !== generation.current) return;
      if (!transConfig.ok) throw new Error(transConfig.error);
      if (transConfig.data.settings.mode !== 'local' && !transConfig.data.settings.providerId) {
        throw new Error(zh ? '请先在「设置 - 字幕翻译」中选择翻译 Provider。' : 'Choose a translation provider in Settings first.');
      }

      const fingerprint = JSON.stringify(transConfig.data.settings);
      if (translationFingerprint.current !== fingerprint) {
        workingCues = workingCues.map(({ translated: _translated, ...cue }) => cue);
        setCues(workingCues);
      }
      translationFingerprint.current = fingerprint;
      const batches = subtitleBatches(workingCues);
      let completed = 0;
      let batchOffset = 0;
      let memoryState: TranslationMemoryState = { memory: { summary: '', terms: [] }, through: 0 };

      for (const [batchIndex, batch] of batches.entries()) {
        if (token !== generation.current) return;
        if (batch.every(cue => cue.translated?.trim())) {
          batchOffset += batch.length;
          completed += batch.length;
          continue;
        }
        const latest = await window.lingvoice.translationConfig();
        if (!latest.ok) throw new Error(latest.error);
        if (JSON.stringify(latest.data.settings) !== fingerprint) {
          throw new Error(zh ? '翻译配置已变更，请重新开始以保持语言一致。' : 'Translation settings changed. Restart dubbing for consistent output.');
        }

        memoryState = await advanceTranslationMemory(workingCues, batchOffset, memoryState, async payload => {
          if (token !== generation.current) throw new Error('Translation cancelled.');
          setProgress(zh ? '正在压缩历史上下文并更新术语表…' : 'Summarizing earlier dialogue and updating terminology…');
          const response = await window.lingvoice.summarizeTranslation(payload);
          if (!response.ok) throw new Error(`${zh ? '历史摘要/术语更新失败' : 'History summary/terminology update failed'}: ${response.error}`);
          return response.data;
        });
        if (token !== generation.current) return;
        setProgress(`${zh ? '正在翻译字幕' : 'Translating subtitles'} ${completed}/${workingCues.length} · ${batchIndex + 1}/${batches.length}`);
        const end = batchOffset + batch.length;
        const { context, lookahead } = translationWindow(workingCues, batchOffset, end);
        const transResult = await window.lingvoice.translateSubtitles({
          memory: memoryState.memory,
          texts: batch.map(cue => cue.text),
          durations: batch.map(cue => Math.max(0.5, Number((cue.end - cue.start).toFixed(2)))),
          ...(context.length ? { context } : {}),
          ...(lookahead.length ? { lookahead } : {}),
        });

        if (token !== generation.current) return;
        if (!transResult.ok) throw new Error(`${zh ? '字幕翻译失败' : 'Subtitle translation failed'} (${batchIndex + 1}/${batches.length}): ${transResult.error}`);

        workingCues = workingCues.map((cue, index) => index >= batchOffset && index < end
          ? { ...cue, translated: transResult.data[index - batchOffset] }
          : { ...cue });
        setCues(workingCues);
        batchOffset = end;
        completed += batch.length;
      }

      // Review-patch loop
      const REVIEW_CHUNK = 60;
      const MAX_ROUNDS = 2;
      const MAX_PATCHES_PER_ROUND = 40;
      const isMachine = transConfig.data.settings.mode === 'local' || (transConfig.data.settings.engine === 'machine' && !transConfig.data.settings.providerId);

      if (!isMachine && workingCues.length > 0) {
        for (let round = 0; round < MAX_ROUNDS; round++) {
          if (token !== generation.current) return;
          setProgress(zh ? '正在审查并校对翻译一致性…' : 'Reviewing translation consistency…');

          const reviewable = workingCues.filter(c => c.text && c.translated);
          if (!reviewable.length) break;

          const allPatches: { id: number; text?: string; translated: string; bgm?: boolean }[] = [];
          for (let i = 0; i < reviewable.length; i += REVIEW_CHUNK - 10) {
            if (token !== generation.current) return;
            const chunk = reviewable.slice(i, i + REVIEW_CHUNK);
            const reviewResult = await window.lingvoice.reviewTranslation({
              memory: memoryState.memory,
              cues: chunk.map(c => ({
                id: c.id,
                text: c.text,
                translated: c.translated!,
                duration: Math.max(0.5, Number((c.end - c.start).toFixed(2))),
              })),
            });
            if (token !== generation.current) return;
            if (!reviewResult.ok) break;
            for (const patch of reviewResult.data) {
              if (!allPatches.some(p => p.id === patch.id)) allPatches.push(patch);
            }
          }

          const patches = allPatches.slice(0, MAX_PATCHES_PER_ROUND);
          if (!patches.length) break;

          const patchMap = new Map(patches.map(p => [p.id, p]));
          const bgmIds = new Set(patches.filter(p => p.bgm).map(p => p.id));
          if (bgmIds.size > 0 && workingCues.length > bgmIds.size) {
            workingCues = workingCues.filter(cue => !bgmIds.has(cue.id));
          }
          for (const cue of workingCues) {
            const fix = patchMap.get(cue.id);
            if (fix) {
              if (fix.text) cue.text = fix.text;
              if (fix.translated) cue.translated = fix.translated;
            }
          }
          workingCues = workingCues.map(cue => ({ ...cue }));
          setCues(workingCues);

          if (patches.length / reviewable.length < 0.03) break;
        }
      }

      setProgress(zh ? '翻译和校对完成。点击「配音」生成配音视频。' : 'Translation and review complete. Click Dub to generate the video.');
      return;
      }

      setProgress(zh ? '正在准备视频配音合成…' : 'Preparing video dubbing…');
      const dubbingId = crypto.randomUUID();
      dubbingJob.current = dubbingId;

      const dubbingResponse = await window.lingvoice.runDubbing({
        jobId: dubbingId,
        file: localPath,
        cues: workingCues.map(c => ({
          id: c.id,
          start: c.start,
          end: c.end,
          text: c.text,
          translated: c.translated,
          speechText: c.translated || c.text,
        })),
        offset,
        backgroundVolume: 1,
        preview: false,
        consent: true,
        useTtsConfig: true,
      });

      if (token !== generation.current || dubbingJob.current !== dubbingId) return;
      if (!dubbingResponse.ok) throw new Error(dubbingResponse.error);

      setResult(dubbingResponse.data);
      setProgress(zh ? '视频配音制作完成！可在播放器顶部切换原视频与配音视频。' : 'Dubbing complete! Switch between original and dubbed video in the player header.');
    } catch (err) {
      if (token === generation.current) {
        setProgress('');
        setError(err instanceof Error ? err.message : String(err));
      }
      throw err;
    } finally {
      if (token === generation.current) {
        recognizing.current = false;
        dubbingJob.current = null;
        running.current = false;
        setBusy(false);
        setStage(null);
      }
    }
  }

  function stop() {
    if (recognizing.current) { recognizing.current = false; void window.lingvoice.cancelAsr().catch(() => {}); }
    if (dubbingJob.current) {
      const id = dubbingJob.current;
      dubbingJob.current = null;
      void window.lingvoice.cancelDubbing?.(id).catch(() => {});
    }
    generation.current++; running.current = false; setBusy(false); setStage(null);
    setProgress(zh ? '已停止当前任务，保留已完成的字幕；已发送的请求可能仍会计费。' : 'Task stopped. Completed subtitles kept; requests already sent may still be billed.');
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
  const mediaUrl = (p: string) => window.lingvoice.runtime === 'browser' ? p : filePathToMediaUrl(p);

  const toolbar = <div className="subtitle-workspace">
    <div className="subtitle-toolbar">
      <div className="subtitle-stage-actions" role="group" aria-label={zh ? '字幕与配音步骤' : 'Subtitle and dubbing steps'}>
        <button
          type="button"
          className="choose-file-button asr-start"
          disabled={!enabled || !localPath || busy}
          onClick={() => void runStage('recognize')}
          title={zh ? '仅识别音频，生成原文字幕；重新识别将替换现有字幕' : 'Transcribe audio only; running again replaces existing subtitles'}
        >
          <Icon name="mic" size={13} />
          <span>{stage === 'recognize' ? (zh ? '识别中…' : 'Transcribing…') : (zh ? '音频识别' : 'Transcribe')}</span>
        </button>
        <button
          type="button"
          className="choose-file-button subtitle-translate"
          disabled={!enabled || !localPath || busy || !cues.length}
          onClick={() => void runStage('translate')}
          title={zh ? '翻译并校对已有字幕，失败后重试会保留已完成批次' : 'Translate and review existing subtitles; retry keeps completed batches'}
        >
          <span>{stage === 'translate' ? (zh ? '翻译中…' : 'Translating…') : (zh ? '翻译' : 'Translate')}</span>
        </button>
        <button
          type="button"
          className="choose-file-button primary dubbing-main-button"
          disabled={!enabled || !localPath || busy || !cues.length || cues.some(cue => !cue.translated?.trim())}
          onClick={() => void runStage('dub')}
          title={zh ? '使用已有译文生成配音，请先完成全部字幕翻译' : 'Dub using existing translations; translate all subtitles first'}
        >
          <span>{stage === 'dub' ? (zh ? '配音中…' : 'Dubbing…') : (zh ? '配音' : 'Dub')}</span>
        </button>
      </div>
      {busy && <button type="button" className="text-button subtitle-stop" onClick={() => { taskQueue.cancel(queueId); stop(); }}>{zh ? '停止' : 'Stop'}</button>}
      <Select
        value={mode}
        options={modeOptions}
        onChange={val => setMode(val as Mode)}
        className="subtitle-select"
        aria-label={zh ? '字幕显示模式' : 'Subtitle display mode'}
      />
      {cues.length > 0 && <>
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
    {result && (
      <div className="dubbing-result-card">
        <div className="dubbing-result-title">
          <Icon name="mic" size={14} />
          <span>{zh ? '配音制作完成' : 'Dubbing ready'} ({result.targetLanguage})</span>
        </div>
        <p className="subtitle-hint">{zh ? '在播放器顶部选择「配音视频」即可观看，画面与配音一起播放。' : 'Select Dubbed video above the player to watch with translated speech.'}</p>
        <div className="dubbing-result-actions">
          <a className="choose-file-button" href={mediaUrl(result.video)} download>{zh ? '下载配音视频' : 'Download video'}</a>
          <a className="choose-file-button" href={mediaUrl(result.audio)} download>{zh ? '下载配音音频' : 'Download audio'}</a>
          <a className="choose-file-button" href={mediaUrl(result.subtitles)} download>{zh ? '下载配音字幕' : 'Download subtitles'}</a>
        </div>
      </div>
    )}
    {name && <p className="subtitle-hint">{`${name} · ${cues.length} ${zh ? '条字幕' : 'cues'}`}</p>}
    {progress && <p className="subtitle-hint" role="status">{progress}</p>}
    {error && <p className="settings-error" role="alert">{error}</p>}
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

  return { toolbar, overlay, cues, offset, result, snapshot: { cues, offset, file: localPath, sourceKey: videoSrc } };
}
