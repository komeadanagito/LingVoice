import { useEffect, useRef, useState } from 'react';
import { defaultDubbingSettings, type DubbingSettings } from '../../shared/dubbing';
import { DEFAULT_TTS_BASE_URL, defaultTtsSettings, type TtsSettings } from '../../shared/tts';
import { useI18n } from '../i18n';

interface Props {
  disabled: boolean;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
  builtinSeparationReady?: boolean;
}

export function TtsSettingsCard({ disabled, collapsed = false, onToggleCollapse, builtinSeparationReady }: Props) {
  const { locale } = useI18n();
  const zh = locale === 'zh-CN';
  const [settings, setSettings] = useState<TtsSettings>({ ...defaultTtsSettings, mode: 'local', baseUrl: DEFAULT_TTS_BASE_URL });
  const [dubbing, setDubbing] = useState<DubbingSettings>({ ...defaultDubbingSettings });
  const [separationNote, setSeparationNote] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [feedback, setFeedback] = useState<{ error: boolean; text: string } | null>(null);
  const [audio, setAudio] = useState<{ url: string; fileName: string } | null>(null);
  const requestVersion = useRef(0);
  const running = useRef(false);
  const live = useRef(false);

  useEffect(() => {
    live.current = true;
    let active = true;
    void Promise.all([
      window.lingvoice.ttsConfig(),
      window.lingvoice.dubbingConfig?.() ?? Promise.resolve(null),
      window.lingvoice.checkDubbing?.() ?? Promise.resolve(null),
    ]).then(([ttsRes, dubRes, checkRes]) => {
      if (!active) return;
      if (!ttsRes.ok) throw new Error(ttsRes.error);
      setSettings({
        ...ttsRes.data.settings,
        mode: 'local',
        providerId: '',
        baseUrl: ttsRes.data.settings.baseUrl || DEFAULT_TTS_BASE_URL,
      });
      if (dubRes && dubRes.ok) {
        setDubbing(dubRes.data.settings);
      }
      if (checkRes && checkRes.ok) {
        if (checkRes.data.ready) {
          setSeparationNote(zh ? '已启用自定义本地人声分离模型。' : 'Custom local separation model is ready.');
        } else if (checkRes.data.builtinSeparationReady) {
          setSeparationNote(zh
            ? '内置 Karaoke BS-RoFormer 已就绪：自动去除原视频说话人声，保留 BGM 与唱歌人声。'
            : 'Built-in Karaoke BS-RoFormer is ready: removes spoken dialogue while keeping BGM & singing vocals.');
        } else {
          setSeparationNote(zh
            ? '未检测到人声分离模型：配音时将静音原视频背景音以防止原声串音。'
            : 'No separation model detected: original background audio will be muted.');
        }
      }
      setLoaded(true);
    }).catch(error => {
      if (active) setFeedback({ error: true, text: String(error instanceof Error ? error.message : error) });
    });
    return () => {
      active = false;
      live.current = false;
      requestVersion.current++;
      if (running.current) void window.lingvoice.cancelTts().catch(() => {});
    };
  }, [zh]);

  useEffect(() => () => { if (audio) URL.revokeObjectURL(audio.url); }, [audio]);

  const blocked = disabled || !loaded || saving || generating;
  const canTest = !!text.trim();

  async function saveAll() {
    const nextSettings: TtsSettings = {
      ...settings,
      mode: 'local',
      providerId: '',
      baseUrl: settings.baseUrl.trim() || DEFAULT_TTS_BASE_URL,
    };
    const result = await window.lingvoice.saveTtsConfig({ settings: nextSettings });
    if (!result.ok) throw new Error(result.error);
    if (typeof window.lingvoice.saveDubbingConfig === 'function') {
      const dubSave = await window.lingvoice.saveDubbingConfig(dubbing);
      if (!dubSave.ok) throw new Error(dubSave.error);
      if (live.current) setDubbing(dubSave.data.settings);
      if (typeof window.lingvoice.checkDubbing === 'function') {
        const checked = await window.lingvoice.checkDubbing();
        if (checked.ok && live.current) {
          if (checked.data.ready) {
            setSeparationNote(zh ? '已启用自定义本地人声分离模型。' : 'Custom local separation model is ready.');
          } else if (checked.data.builtinSeparationReady) {
            setSeparationNote(zh
              ? '内置 Karaoke BS-RoFormer 已就绪：自动去除原视频说话人声，保留 BGM 与唱歌人声。'
              : 'Built-in Karaoke BS-RoFormer is ready: removes spoken dialogue while keeping BGM & singing vocals.');
          }
        }
      }
    }
    if (live.current) {
      setSettings({ ...result.data.settings, mode: 'local', providerId: '' });
      window.dispatchEvent(new CustomEvent('lingvoice:tts-mode-changed', { detail: { ...result.data.settings, mode: 'local' } }));
    }
  }

  async function saveOnly() {
    setSaving(true);
    setFeedback(null);
    try {
      await saveAll();
      if (live.current) setFeedback({ error: false, text: zh ? '配音与分离设置已保存' : 'Dubbing & separation settings saved' });
    } catch (error) {
      if (live.current) setFeedback({ error: true, text: error instanceof Error ? error.message : String(error) });
    } finally {
      if (live.current) setSaving(false);
    }
  }

  async function generate() {
    if (running.current || blocked) return;
    const version = ++requestVersion.current;
    running.current = true;
    setGenerating(true);
    setFeedback(null);
    try {
      await saveAll();
      if (version !== requestVersion.current) return;
      const result = await window.lingvoice.generateSpeech({ text });
      if (!live.current || version !== requestVersion.current) return;
      if (!result.ok) throw new Error(result.error);
      const bytes = Uint8Array.from(atob(result.data.audioBase64), char => char.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], { type: result.data.mimeType }));
      setAudio({ url, fileName: result.data.fileName });
      setFeedback({ error: false, text: zh ? '本地配音测试成功，可试听或下载音频。' : 'Local voice test succeeded.' });
    } catch (error) {
      if (live.current && version === requestVersion.current) {
        setFeedback({ error: true, text: error instanceof Error ? error.message : String(error) });
      }
    } finally {
      if (version === requestVersion.current) {
        running.current = false;
        if (live.current) setGenerating(false);
      }
    }
  }

  async function cancel() {
    if (cancelling) return;
    requestVersion.current++;
    setCancelling(true);
    try {
      const result = await window.lingvoice.cancelTts();
      if (live.current) setFeedback({ error: !result.ok, text: result.ok ? (zh ? '已取消测试。' : 'Test cancelled.') : result.error });
    } catch (error) {
      if (live.current) setFeedback({ error: true, text: error instanceof Error ? error.message : String(error) });
    } finally {
      running.current = false;
      if (live.current) {
        setGenerating(false);
        setCancelling(false);
      }
    }
  }

  return (
    <section className={`settings-section tts-section${collapsed ? ' is-collapsed' : ''}`} aria-labelledby="tts-settings-title">
      <div className="settings-section-heading">
        <button
          type="button"
          className="settings-section-header"
          onClick={onToggleCollapse}
          aria-expanded={!collapsed}
          aria-controls="tts-section-body"
        >
          <div className="settings-section-title-row">
            <h3 id="tts-settings-title">{zh ? '视频配音与人声分离' : 'Dubbing & Vocal Separation'}</h3>
            <span className="local-pill is-ready">GPT-SoVITS V5</span>
          </div>
          <svg className="section-chevron" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="m6 9 6 6 6-6" />
          </svg>
        </button>
      </div>
      <div id="tts-section-body" className="settings-section-body">
        <fieldset className="translation-fields" disabled={blocked}>
          <div className="settings-summary-list">
            <div className="settings-summary-item">
              <strong>{zh ? '声音克隆引擎' : 'Voice cloning engine'}</strong>
              <span>{zh
                ? '本地 GPT-SoVITS V5 (v5turbo)：自动从分离后的原声干声提取参考音色进行配音克隆，无需手动上传样本。'
                : 'Local GPT-SoVITS V5 (v5turbo): automatically clones timbre from separated original speech.'}</span>
            </div>
            <div className="settings-summary-item">
              <strong>{zh ? '人声分离与 BGM 保留' : 'Vocal separation & BGM'}</strong>
              <span>{separationNote || (builtinSeparationReady
                ? (zh ? '内置 Karaoke BS-RoFormer 已就绪：自动去除原视频说话人声，保留 BGM 与唱歌人声。' : 'Built-in Karaoke BS-RoFormer is ready.')
                : (zh ? '正在检测分离环境…' : 'Checking separation environment…'))}</span>
            </div>
          </div>

          <details className="settings-advanced-details">
            <summary>{zh ? '高级选项：自定义本地 UVR 人声分离模型（可选，留空即使用内置模型）' : 'Advanced: custom local UVR separation model (optional)'}</summary>
            <div className="settings-form-grid" style={{ marginTop: 12 }}>
              <label>
                {zh ? 'Python 可执行文件路径' : 'Python path'}
                <input
                  value={dubbing.pythonPath}
                  onChange={event => setDubbing(prev => ({ ...prev, pythonPath: event.target.value }))}
                  spellCheck={false}
                  placeholder="python"
                />
              </label>
              <label>
                {zh ? '自定义分离模型权重绝对路径' : 'Custom separation model path'}
                <input
                  value={dubbing.modelFile}
                  onChange={event => setDubbing(prev => ({ ...prev, modelFile: event.target.value }))}
                  spellCheck={false}
                  placeholder={zh ? '留空默认使用内置 Karaoke BS-RoFormer' : 'Leave empty to use built-in Karaoke BS-RoFormer'}
                />
              </label>
            </div>
          </details>

          <label className="tts-text-field" style={{ marginTop: 14 }}>
            {zh ? '测试本地配音（可选）' : 'Test local voice service (optional)'}
            <textarea
              aria-label={zh ? '测试配音文本' : 'Text to synthesize'}
              maxLength={4096}
              value={text}
              onChange={event => setText(event.target.value)}
              placeholder={zh ? '输入一句英文或中文测试本地 GPT-SoVITS V5 是否正常发声（需 references 目录有参考 WAV）…' : 'Enter sample text to test local GPT-SoVITS V5…'}
            />
            <span className="settings-hint" style={{ margin: '6px 0 0' }}>{text.length}/4096</span>
          </label>
          <div className="settings-actions">
            <button className="primary tts-save" type="button" onClick={() => void saveOnly()}>
              {saving ? (zh ? '保存中…' : 'Saving…') : (zh ? '保存配音设置' : 'Save dubbing settings')}
            </button>
            <button className="choose-file-button tts-generate" type="button" disabled={!canTest} onClick={() => void generate()}>
              {generating ? (zh ? '测试中…' : 'Testing…') : (zh ? '测试本地配音' : 'Test local dubbing')}
            </button>
          </div>
        </fieldset>
        {generating && (
          <button className="cancel-button tts-cancel" type="button" disabled={cancelling} onClick={() => void cancel()}>
            {cancelling ? (zh ? '取消中…' : 'Cancelling…') : (zh ? '取消测试' : 'Cancel test')}
          </button>
        )}
        {feedback && (
          <p className={`tts-feedback ${feedback.error ? 'settings-error' : 'settings-notice'}`} role={feedback.error ? 'alert' : 'status'}>
            {feedback.text}
          </p>
        )}
        {audio && (
          <div className="tts-audio-result">
            <audio controls src={audio.url} aria-label={zh ? '合成语音试听' : 'Generated speech preview'} />
            <a className="text-button tts-download" href={audio.url} download={audio.fileName}>
              {zh ? '下载测试音频' : 'Download test audio'}
            </a>
          </div>
        )}
      </div>
    </section>
  );
}
