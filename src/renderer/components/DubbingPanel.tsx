import { useEffect, useRef, useState } from 'react';
import { defaultDubbingSettings, SUPPORTED_DUBBING_MODELS, type DubbingCue, type DubbingModel, type DubbingProgress, type DubbingResult, type DubbingSettings } from '../../shared/dubbing';
import { useI18n } from '../i18n';
import { filePathToMediaUrl } from '../utils/media';
import { Icon } from './Icon';

interface Props { file: string; cues: DubbingCue[]; offset: number; disabled: boolean; sourceKey: string }

export function DubbingPanel({ file, cues, offset, disabled, sourceKey }: Props) {
  const { locale } = useI18n();
  const zh = locale === 'zh-CN';
  const [settings, setSettings] = useState<DubbingSettings>({ ...defaultDubbingSettings });
  const [loaded, setLoaded] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [working, setWorking] = useState(false);
  const [running, setRunning] = useState(false);
  const [consent, setConsent] = useState(false);
  const [volume, setVolume] = useState(1);
  const [edits, setEdits] = useState<Record<number, string>>({});
  const [result, setResult] = useState<DubbingResult | null>(null);
  const [voices, setVoices] = useState<{ voiceId: string; baseUrl: string }[]>([]);
  const [voicesError, setVoicesError] = useState('');
  const [ttsProvider, setTtsProvider] = useState<string>('');
  const [hasTtsKey, setHasTtsKey] = useState<boolean>(false);
  const voicesVersion = useRef(0);
  const cueFingerprint = JSON.stringify(cues);
  const [progress, setProgress] = useState<DubbingProgress | null>(null);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const job = useRef<string | null>(null);
  const version = useRef(0);
  const alive = useRef(false);
  const lock = useRef(false);
  const available = ['dubbingConfig', 'saveDubbingConfig', 'checkDubbing', 'runDubbing', 'cancelDubbing', 'onDubbingProgress'].every(key => typeof window.lingvoice[key as keyof typeof window.lingvoice] === 'function');

  async function refreshConfig(loadSettings = false) {
    if (typeof window.lingvoice.dubbingConfig !== 'function') return;
    const request = ++voicesVersion.current;
    try {
      const response = await window.lingvoice.dubbingConfig();
      if (!alive.current || request !== voicesVersion.current) return;
      if (!response.ok) throw new Error(response.error);
      // Only retain the public registry fields; credentials never enter this list.
      setVoices([...new Map((response.data.voices ?? []).map(({ voiceId, baseUrl }) => [voiceId, { voiceId, baseUrl }])).values()]);
      setVoicesError('');
      if (response.data.ttsProviderName) setTtsProvider(response.data.ttsProviderName);
      if (response.data.hasTtsApiKey !== undefined) setHasTtsKey(response.data.hasTtsApiKey);
      if (loadSettings) { setSettings(response.data.settings); setLoaded(true); }
    } catch (reason) {
      if (alive.current && request === voicesVersion.current) setVoicesError(reason instanceof Error ? reason.message : String(reason));
    }
  }

  useEffect(() => {
    alive.current = true;
    if (available) void refreshConfig(true);
    return () => { alive.current = false; voicesVersion.current++; };
  }, [available]);

  useEffect(() => {
    version.current++;
    setEdits({}); setConsent(false); setResult(null); setProgress(null); setNotice(''); setError(''); setRunning(false);
    return () => {
      version.current++;
      const id = job.current;
      job.current = null;
      if (id) void window.lingvoice.cancelDubbing?.(id).catch(() => {}).finally(() => { if (alive.current) void refreshConfig(); });
    };
  }, [sourceKey, file, cueFingerprint, offset]);

  useEffect(() => window.lingvoice.onDubbingProgress?.(event => {
    if (alive.current && event.jobId === job.current) setProgress(event);
  }), []);

  function change(key: keyof DubbingSettings, value: string) {
    setSettings(previous => ({ ...previous, [key]: value })); setDirty(true); setNotice('');
  }
  async function configure(check: boolean) {
    if (lock.current || job.current || !available) return;
    lock.current = true; setWorking(true); setError(''); setNotice('');
    try {
      const saved = await window.lingvoice.saveDubbingConfig(settings);
      if (!saved.ok) throw new Error(saved.error);
      if (!alive.current) return;
      setSettings(saved.data.settings); setDirty(false);
      if (check) {
        const checked = await window.lingvoice.checkDubbing();
        if (!checked.ok) throw new Error(checked.error);
        if (!alive.current) return;
        if (!checked.data.ready) throw new Error(checked.data.message);
        setNotice(checked.data.message);
      } else setNotice(zh ? '配音配置已保存。' : 'Dubbing settings saved.');
    } catch (reason) { if (alive.current) setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { lock.current = false; if (alive.current) setWorking(false); }
  }
  async function run(preview: boolean) {
    if (job.current || lock.current || disabled || !file || !cues.length || !consent || dirty || !loaded || !available) return;
    const id = crypto.randomUUID();
    const token = version.current;
    job.current = id; setRunning(true); setError(''); setNotice(''); setProgress(null); setResult(null);
    try {
      const response = await window.lingvoice.runDubbing({ jobId: id, file, cues: cues.map(cue => ({ ...cue, ...(Object.hasOwn(edits, cue.id) ? { speechText: edits[cue.id].trim() || undefined } : {}) })), offset, backgroundVolume: volume, preview, consent: true });
      if (!alive.current || token !== version.current || job.current !== id) return;
      if (!response.ok) throw new Error(response.error);
      if (response.data.jobId !== id) throw new Error(zh ? '配音结果任务 ID 不匹配。' : 'Dubbing result job ID does not match.');
      setResult(response.data);
      setEdits(previous => ({ ...previous, ...Object.fromEntries(response.data.cues.filter(cue => cue.speechText !== undefined).map(cue => [cue.id, cue.speechText!])) }));
      setNotice(zh ? '配音已完成，可试听或下载。' : 'Dubbing complete. Preview or download the results.');
    } catch (reason) {
      if (alive.current && token === version.current && job.current === id) setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (job.current === id) { job.current = null; if (alive.current) setRunning(false); }
      if (alive.current) void refreshConfig();
    }
  }
  async function stop() {
    const id = job.current;
    if (!id || lock.current) return;
    job.current = null; lock.current = true; setWorking(true); setProgress(null);
    try {
      const response = await window.lingvoice.cancelDubbing?.(id);
      if (response && !response.ok) throw new Error(response.error);
      if (alive.current) setNotice(zh ? '已停止；已发送的云端请求可能仍会计费。' : 'Stopped; cloud requests already submitted may still be billed.');
    } catch (reason) { if (alive.current) setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { lock.current = false; if (alive.current) { setRunning(false); setWorking(false); void refreshConfig(); } }
  }
  async function cleanup(voiceId?: string) {
    if (job.current || lock.current) return;
    if (voiceId && !window.confirm(zh ? `确认删除远端音色 ${voiceId}？删除后无法再使用此音色。` : `Delete remote voice ${voiceId}? This voice can no longer be used after deletion.`)) return;
    if (!voiceId && !window.confirm(zh ? '确认清理本地配音缓存？此操作会永久删除本地导出的视频、音频和字幕文件，现有结果链接将失效；远端音色会保留。' : 'Clear the local dubbing cache? This permanently deletes exported video, audio and subtitle files and invalidates result links. Remote voices will remain.')) return;
    lock.current = true; setWorking(true); setError('');
    try {
      const response = voiceId ? await window.lingvoice.deleteDubbingVoice?.(voiceId) : await window.lingvoice.clearDubbingCache?.();
      if (!response) throw new Error(zh ? '当前后端不支持此操作。' : 'This backend does not support this action.');
      if (!response.ok) throw new Error(response.error);
      if (!alive.current) return;
      if (voiceId) setResult(previous => previous?.voiceId === voiceId ? { ...previous, voiceId: '' } : previous);
      else setResult(null);
      setNotice(voiceId ? (zh ? '远端音色已删除。' : 'Remote voice deleted.') : (zh ? '本地缓存已清理，结果链接已移除；远端音色不会自动删除。' : 'Local cache cleared and result links removed. Remote voices are not automatically deleted.'));
    } catch (reason) { if (alive.current) setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { lock.current = false; if (alive.current) { setWorking(false); void refreshConfig(); } }
  }
  const blocked = disabled || !available || !loaded || working || running;
  const displayedVoices = [...new Set([...voices.map(voice => voice.voiceId), ...(result?.voiceId ? [result.voiceId] : [])])];
  const mediaUrl = (path: string) => window.lingvoice.runtime === 'browser' ? path : filePathToMediaUrl(path);

  const currentModel = settings.model ?? 'qwen-audio-3.1-tts-plus';
  const [open, setOpen] = useState(false);

  return <>
    <button
      type="button"
      className="choose-file-button dubbing-open-button"
      disabled={disabled}
      onClick={() => setOpen(true)}
      title={zh ? '使用 AI 音色复刻为当前视频生成翻译配音' : 'Dub video with AI voice cloning'}
    >
      <Icon name="mic" size={13} />
      <span>{zh ? '视频配音' : 'Dub video'}</span>
    </button>
    {open && (
      <div className="dubbing-modal-backdrop" onClick={e => { if (e.target === e.currentTarget && !running) setOpen(false); }}>
        <div className="dubbing-modal" role="dialog" aria-modal="true" aria-labelledby="dubbing-dialog-title">
          <div className="dubbing-modal-header">
            <h3 id="dubbing-dialog-title">
              <Icon name="mic" size={16} />
              <span>{zh ? '视频配音 · 音色复刻' : 'Video dubbing · Voice cloning'}</span>
            </h3>
            <button
              type="button"
              className="dubbing-modal-close"
              onClick={() => setOpen(false)}
              disabled={running}
              aria-label={zh ? '关闭' : 'Close'}
            >
              ×
            </button>
          </div>
          <div className="dubbing-modal-body">
            {ttsProvider && (
              <div className="dubbing-provider-status" style={{ padding: '8px 12px', background: '#f0f9f5', border: '1px solid #b7e4d2', borderRadius: '8px', marginBottom: '12px', fontSize: '12px', color: '#166534', display: 'flex', alignItems: 'center', gap: '8px' }}>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>
                <span>
                  {zh
                    ? `已关联「设置 - 文字转语音」服务商：${ttsProvider}${hasTtsKey ? '（API Key 已就绪）' : ''}，当前复刻模型：${currentModel}`
                    : `Linked to Settings -> TTS provider: ${ttsProvider}${hasTtsKey ? ' (API Key ready)' : ''}, model: ${currentModel}`}
                </span>
              </div>
            )}
            <p className="settings-hint">{zh ? `配音使用专属复刻模型（当前：${currentModel}），复用「设置 - 文字转语音」中保存的 Provider 和 API Key，不影响普通 TTS。` : `Dubbing uses a dedicated voice-cloning model (current: ${currentModel}) with the provider and API key saved in Settings -> Text to speech, leaving ordinary TTS unaffected.`}</p>
            {!available && <p className="settings-notice" role="status">{zh ? '当前后端尚未提供配音接口。' : 'Dubbing is unavailable on this backend.'}</p>}
            <fieldset className="translation-fields" disabled={blocked}>
              <legend className="sr-only">{zh ? '本地配音配置' : 'Local dubbing configuration'}</legend>
              <div className="settings-form-grid dubbing-config">
                <label>{zh ? '配音合成模型' : 'Dubbing model'}
                  <select value={currentModel} onChange={event => change('model', event.target.value as DubbingModel)}>
                    {SUPPORTED_DUBBING_MODELS.map(m => <option key={m} value={m}>{m}</option>)}
                  </select>
                </label>
                <label>{zh ? 'Python 路径' : 'Python path'}<input value={settings.pythonPath} onChange={event => change('pythonPath', event.target.value)} spellCheck={false} /></label>
                <label>{zh ? '已下载的本地权重文件' : 'Downloaded local model file'}<input value={settings.modelFile} onChange={event => change('modelFile', event.target.value)} spellCheck={false} placeholder={zh ? '本地权重绝对路径' : 'Absolute path to local weights'} /></label>
                <label>{zh ? '阿里云 workspace API root（/api/v1）' : 'Alibaba workspace API root (/api/v1)'}<input type="url" value={settings.baseUrl} onChange={event => change('baseUrl', event.target.value)} spellCheck={false} placeholder="https://dashscope.aliyuncs.com/api/v1" /></label>
              </div>
              <p className="settings-hint">{zh ? '请自行安装 Python 环境并下载权重。API Root 留空将默认使用百炼官方地址（https://dashscope.aliyuncs.com/api/v1）。' : 'Install Python dependencies and download weights. Leaving API Root blank defaults to https://dashscope.aliyuncs.com/api/v1.'} <a href="https://help.aliyun.com/zh/model-studio/" target="_blank" rel="noreferrer">{zh ? '阿里云官方文档' : 'Official Alibaba Cloud documentation'}</a></p>
              <div className="settings-actions"><button type="button" className="choose-file-button" onClick={() => void configure(false)}>{zh ? '保存配置' : 'Save settings'}</button><button type="button" className="choose-file-button" onClick={() => void configure(true)}>{zh ? '保存并检查环境' : 'Save and check environment'}</button></div>
            </fieldset>
            {!cues.length ? <p className="settings-notice">{zh ? '请先导入字幕，或主动点击「识别音频」并确认上传。本面板不会自动调用语音识别。' : 'Import subtitles first, or choose Transcribe audio and confirm the upload. This panel never starts transcription automatically.'}</p> : <>
              <p className="settings-hint">{zh ? '目标语言取决于当前翻译设置。未翻译的字幕可由后端翻译；下面的配音文本可逐句修改，不会改动字幕译文。留空使用已有译文或由后端翻译。' : 'The target language follows your current translation settings. The backend can translate missing translations. Edit spoken text below independently of subtitle translations; leave blank to use the translation or let the backend translate.'}</p>
              <fieldset className="translation-fields" disabled={blocked}>
                <legend className="sr-only">{zh ? '逐句配音文本' : 'Spoken text per cue'}</legend>
                <div className="dubbing-cues">{cues.map(cue => <label key={cue.id} className="dubbing-cue"><span>#{cue.id} · {cue.start.toFixed(1)}–{cue.end.toFixed(1)}s</span><span>{cue.text}</span><textarea rows={2} aria-label={`${zh ? '配音文本' : 'Spoken text'} #${cue.id}`} value={edits[cue.id] ?? cue.speechText ?? cue.translated ?? ''} onChange={event => setEdits(previous => ({ ...previous, [cue.id]: event.target.value }))} placeholder={zh ? '留空由后端翻译' : 'Leave blank for backend translation'} /></label>)}</div>
                <label className="dubbing-volume">{zh ? '背景音量' : 'Background volume'}<input type="range" min={0} max={2} step={0.05} value={volume} onChange={event => setVolume(Math.max(0, Math.min(2, Number(event.target.value))))} /><output>{Math.round(volume * 100)}%</output></label>
                <p className="settings-hint">{zh ? '整段视频仅发送至本机后端处理。音色复刻会向云端上传 5–20 秒参考音频（推荐 10–20 秒），并发送配音文本；复刻、翻译与合成可能计费。音色相似度与背景分离效果取决于素材和服务，不保证完全保留。' : 'The full video is sent only to the local backend. Voice cloning uploads a 5–20 second reference clip (10–20 seconds recommended) to the cloud and sends dubbing text. Cloning, translation and synthesis may incur charges. Voice similarity and background separation depend on the source and service; exact preservation is not guaranteed.'}</p>
                <label className="checkbox-field dubbing-consent"><input type="checkbox" checked={consent} onChange={event => setConsent(event.target.checked)} />{zh ? '我已获得参考声音的使用与复刻授权，同意上传 5–20 秒参考音频（推荐 10–20 秒）、发送文本并承担可能的费用。' : 'I am authorized to use and clone the reference voice and consent to uploading a 5–20 second reference clip (10–20 seconds recommended), text processing and possible charges.'}</label>
                <div className="settings-actions"><button type="button" className="choose-file-button" disabled={!consent || !file || dirty} onClick={() => void run(true)}>{zh ? '前 30 秒内短片试听' : 'Preview first ≤30 seconds'}</button><button type="button" className="primary" disabled={!consent || !file || dirty} onClick={() => void run(false)}>{zh ? '生成完整配音' : 'Generate full dub'}</button></div>
                {dirty && <p className="settings-notice">{zh ? '请先保存修改后的配音配置。' : 'Save your changed dubbing settings first.'}</p>}
              </fieldset>
            </>}
            {running && <button type="button" className="cancel-button" disabled={working} onClick={() => void stop()}>{zh ? '停止配音' : 'Stop dubbing'}</button>}
            <div role="status" aria-live="polite">{progress && <p className="settings-notice">{progress.message} ({progress.completed}/{progress.total})</p>}{notice && <p className="settings-notice">{notice}</p>}</div>
            {error && <p className="settings-error" role="alert">{error}</p>}
            {result && <div className="dubbing-result">
              <p>{result.preview ? (zh ? '短片试听' : 'Short preview') : (zh ? '完整配音' : 'Full dub')} · {result.targetLanguage}</p>
              <audio controls src={mediaUrl(result.audio)} aria-label={zh ? '配音音频试听' : 'Dubbed audio preview'} />
              <div className="settings-actions"><a className="text-button" href={mediaUrl(result.video)} download>{zh ? '下载视频' : 'Download video'}</a><a className="text-button" href={mediaUrl(result.audio)} download>{zh ? '下载音频' : 'Download audio'}</a><a className="text-button" href={mediaUrl(result.subtitles)} download>{zh ? '下载字幕' : 'Download subtitles'}</a></div>
            </div>}
            <section aria-label={zh ? '已注册远端音色' : 'Registered remote voices'}>
              <h4>{zh ? '已注册远端音色' : 'Registered remote voices'}</h4>
              <p className="settings-hint">{zh ? '包含失败任务中创建的音色；重启应用或清理本地缓存后仍可删除。清单仅显示音色 ID。' : 'Includes voices created by failed tasks. Voices remain deletable after restarting the app or clearing local cache. Only voice IDs are displayed.'}</p>
              {displayedVoices.length ? <ul>{displayedVoices.map(voiceId => <li key={voiceId}><p>{voiceId}</p><button type="button" className="text-button" disabled={blocked || !window.lingvoice.deleteDubbingVoice} aria-label={`${zh ? '删除远端音色' : 'Delete remote voice'} ${voiceId}`} onClick={() => void cleanup(voiceId)}>{zh ? '删除远端音色…' : 'Delete remote voice…'}</button></li>)}</ul> : <p className="settings-hint">{zh ? '暂无已注册音色。' : 'No registered voices.'}</p>}
              {voicesError && <p className="settings-error" role="alert">{zh ? '读取音色清单失败：' : 'Could not load voice list: '}{voicesError}</p>}
              <button type="button" className="text-button" disabled={!available || working || running} onClick={() => void refreshConfig(!loaded)}>{zh ? '刷新音色清单' : 'Refresh voice list'}</button>
            </section>
            <button type="button" className="text-button" disabled={blocked || !window.lingvoice.clearDubbingCache} onClick={() => void cleanup()}>{zh ? '清理本地缓存（删除导出文件）…' : 'Clear local cache (deletes exports)…'}</button>
          </div>
        </div>
      </div>
    )}
  </>;
}
