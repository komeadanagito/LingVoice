import { useEffect, useRef, useState } from 'react';
import { useI18n } from '../i18n';
import { activeSubtitles, exportSubtitles, parseSubtitles, subtitleBatches, type SubtitleCue } from '../utils/subtitles';

type Mode = 'bilingual' | 'original' | 'translated' | 'off';

export function useSubtitleTrack(videoSrc: string, embedSrc: string, currentTime: number, localPath: string) {
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
  const generation = useRef(0);
  const running = useRef(false);
  const recognizing = useRef(false);
  const [confirmAsr, setConfirmAsr] = useState(false);
  const input = useRef<HTMLInputElement>(null);
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
      if (!config.data.settings.providerId) throw new Error(zh ? '请先在设置中添加 Provider，并保存语音识别绑定。' : 'Add a provider in Settings and save the speech recognition binding first.');
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
  const enabled = Boolean(videoSrc && !embedSrc);
  const active = mode === 'off' ? [] : activeSubtitles(cues, currentTime - offset);
  const toolbar = <div className="subtitle-workspace">
    <div className="subtitle-toolbar">
      <input ref={input} className="sr-only" type="file" accept=".srt,.vtt" aria-label={zh ? '导入字幕' : 'Import subtitles'} onChange={event => { const file = event.target.files?.[0]; if (file) void importFile(file); event.target.value = ''; }} disabled={!enabled || busy} />
      <button type="button" className="choose-file-button" disabled={!enabled || busy} onClick={() => input.current?.click()}>{zh ? '导入字幕' : 'Import subtitles'}</button>
      <button type="button" className="choose-file-button asr-start" disabled={!enabled || !localPath || busy} onClick={() => setConfirmAsr(value => !value)}>{zh ? '识别音频' : 'Transcribe audio'}</button>
      {busy && <button type="button" className="text-button subtitle-stop" onClick={stop}>{zh ? '停止' : 'Stop'}</button>}
      <select aria-label={zh ? '字幕显示模式' : 'Subtitle display mode'} value={mode} onChange={event => setMode(event.target.value as Mode)}><option value="bilingual">{zh ? '双语字幕' : 'Bilingual'}</option><option value="translated">{zh ? '仅译文' : 'Translation only'}</option><option value="original">{zh ? '仅原文' : 'Original only'}</option><option value="off">{zh ? '关闭字幕' : 'Off'}</option></select>
      {cues.length > 0 && <>
        <button type="button" className="primary" disabled={busy} onClick={() => void translate()}>{zh ? '翻译字幕' : 'Translate'}</button>
        <button type="button" className="text-button" onClick={download}>{zh ? '导出 SRT' : 'Export SRT'}</button>
        <label className="subtitle-offset">{zh ? '延迟' : 'Delay'}<input type="number" min={-60} max={60} step={0.1} value={offset} onChange={event => { const value = Number(event.target.value); setOffset(Number.isFinite(value) ? Math.max(-60, Math.min(60, value)) : 0); }} />s</label>
        <select aria-label={zh ? '字幕字号' : 'Subtitle font size'} value={fontSize} onChange={event => setFontSize(Number(event.target.value))}>{[18, 22, 26, 30].map(size => <option key={size} value={size}>{size}px</option>)}</select>
      </>}
    </div>
    {confirmAsr && <div className="asr-consent" role="group" aria-label={zh ? '确认音频上传' : 'Confirm audio upload'}><span>{zh ? '将提取并上传当前视频的音频到 ASR Provider，可能产生费用。完成后替换当前字幕，继续吗？' : 'Audio from this video will be uploaded to your ASR provider and may incur charges. The result will replace current subtitles. Continue?'}</span><button type="button" className="primary asr-confirm" disabled={busy} onClick={() => void recognize()}>{zh ? '确认并识别' : 'Confirm and transcribe'}</button><button type="button" className="text-button" onClick={() => setConfirmAsr(false)}>{zh ? '取消' : 'Cancel'}</button></div>}
    <p className="subtitle-hint">{embedSrc ? (zh ? '在线内嵌播放暂不支持字幕同步，请下载后播放。' : 'Embedded online playback cannot sync subtitles. Download and play locally.') : name ? `${name} · ${cues.length} ${zh ? '条字幕' : 'cues'}` : (zh ? 'SRT / VTT · 导入字幕或识别本地视频音频；在设置中配置 Provider、翻译和 ASR。' : 'SRT / VTT · Import subtitles or transcribe local video audio. Configure providers, translation and ASR in Settings.')}</p>
    {progress && <p className="subtitle-hint" role="status">{progress}</p>}{error && <p className="settings-error" role="alert">{error}</p>}
  </div>;
  const overlay = active.length > 0 && <div className="subtitle-overlay" style={{ fontSize }}>
    {active.map(cue => <div className="subtitle-cue" key={cue.id}>
      {mode !== 'original' && cue.translated && <div className="subtitle-translation"><span>{cue.translated}</span></div>}
      {(mode !== 'translated' || !cue.translated) && <div className={mode === 'bilingual' && cue.translated ? 'subtitle-original secondary' : 'subtitle-original'}><span>{cue.text}</span></div>}
    </div>)}
  </div>;
  return { toolbar, overlay };
}
