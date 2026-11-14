import { useEffect, useRef, useState } from 'react';
import { DEFAULT_DUBBING_MODEL, SUPPORTED_DUBBING_MODELS } from '../../shared/dubbing';
import { DEFAULT_TTS_BASE_URL, defaultTtsSettings, type TtsSettings } from '../../shared/tts';
import { useI18n } from '../i18n';
import { Select } from './Select';

const dubbingModelOptions = SUPPORTED_DUBBING_MODELS.map(value => ({ value, label: value }));

function dubbingModel(model: string): string {
  return (SUPPORTED_DUBBING_MODELS as readonly string[]).includes(model) ? model : DEFAULT_DUBBING_MODEL;
}

interface Props {
  disabled: boolean;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
}

export function TtsSettingsCard({ disabled, collapsed = false, onToggleCollapse }: Props) {
  const { locale } = useI18n();
  const zh = locale === 'zh-CN';
  const [settings, setSettings] = useState<TtsSettings>({ ...defaultTtsSettings, baseUrl: DEFAULT_TTS_BASE_URL });
  const [hasKey, setHasKey] = useState(false);
  const [key, setKey] = useState('');
  const [showKey, setShowKey] = useState(false);
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

  function applySettings(next: TtsSettings) {
    setSettings({
      ...next,
      providerId: '',
      model: dubbingModel(next.model),
      baseUrl: next.baseUrl || DEFAULT_TTS_BASE_URL,
    });
  }

  useEffect(() => {
    live.current = true;
    let active = true;
    void window.lingvoice.ttsConfig().then(result => {
      if (!active) return;
      if (!result.ok) throw new Error(result.error);
      applySettings(result.data.settings);
      setHasKey(result.data.hasApiKey);
      setLoaded(true);
    }).catch(error => { if (active) setFeedback({ error: true, text: String(error instanceof Error ? error.message : error) }); });
    return () => {
      active = false; live.current = false; requestVersion.current++;
      if (running.current) void window.lingvoice.cancelTts().catch(() => {});
    };
  }, []);
  useEffect(() => () => { if (audio) URL.revokeObjectURL(audio.url); }, [audio]);

  const blocked = disabled || !loaded || saving || generating;
  const canTest = !!settings.baseUrl.trim() && !!text.trim();
  const tokenPlan = /^https:\/\/token-plan\.cn-beijing\.maas\.aliyuncs\.com(?:\/|$)/i.test(settings.baseUrl.trim());

  async function save(explicitKey?: string) {
    const payload = {
      settings: { ...settings, providerId: '', baseUrl: settings.baseUrl.trim() || DEFAULT_TTS_BASE_URL, model: dubbingModel(settings.model) },
      ...(explicitKey !== undefined ? { apiKey: explicitKey } : key ? { apiKey: key } : {}),
    };
    const result = await window.lingvoice.saveTtsConfig(payload);
    if (!result.ok) throw new Error(result.error);
    if (live.current) {
      applySettings(result.data.settings);
      setHasKey(result.data.hasApiKey);
      setKey('');
    }
  }
  async function saveOnly() {
    setSaving(true); setFeedback(null);
    try { await save(); if (live.current) setFeedback({ error: false, text: zh ? '语音合成设置已保存' : 'Speech synthesis settings saved' }); }
    catch (error) { if (live.current) setFeedback({ error: true, text: error instanceof Error ? error.message : String(error) }); }
    finally { if (live.current) setSaving(false); }
  }
  async function clearKey() {
    setSaving(true); setFeedback(null);
    try {
      await save('');
      if (live.current) setFeedback({ error: false, text: zh ? '已清除密钥' : 'Key cleared' });
    } catch (error) { if (live.current) setFeedback({ error: true, text: error instanceof Error ? error.message : String(error) }); }
    finally { if (live.current) setSaving(false); }
  }
  async function generate() {
    if (running.current || blocked) return;
    const version = ++requestVersion.current;
    running.current = true; setGenerating(true); setFeedback(null);
    try {
      await save();
      if (version !== requestVersion.current) return;
      const result = await window.lingvoice.generateSpeech({ text });
      if (!live.current || version !== requestVersion.current) return;
      if (!result.ok) throw new Error(result.error);
      const bytes = Uint8Array.from(atob(result.data.audioBase64), char => char.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], { type: result.data.mimeType }));
      setAudio({ url, fileName: result.data.fileName });
      setFeedback({ error: false, text: zh ? '生成完成，可试听或下载 MP3。' : 'Ready to preview or download as MP3.' });
    } catch (error) {
      if (live.current && version === requestVersion.current) setFeedback({ error: true, text: error instanceof Error ? error.message : String(error) });
    } finally {
      if (version === requestVersion.current) {
        running.current = false;
        if (live.current) setGenerating(false);
      }
    }
  }
  async function cancel() {
    if (cancelling) return;
    requestVersion.current++; setCancelling(true);
    try {
      const result = await window.lingvoice.cancelTts();
      if (live.current) setFeedback({ error: !result.ok, text: result.ok ? (zh ? '已取消生成。已发送的请求可能仍会计费。' : 'Generation cancelled. Submitted requests may still be billed.') : result.error });
    } catch (error) {
      if (live.current) setFeedback({ error: true, text: error instanceof Error ? error.message : String(error) });
    } finally {
      running.current = false;
      if (live.current) { setGenerating(false); setCancelling(false); }
    }
  }

  return <section className={`settings-section tts-section${collapsed ? ' is-collapsed' : ''}`} aria-labelledby="tts-settings-title">
    <div className="settings-section-heading">
      <button
        type="button"
        className="settings-section-header"
        onClick={onToggleCollapse}
        aria-expanded={!collapsed}
        aria-controls="tts-section-body"
      >
        <div>
          <h3 id="tts-settings-title">{zh ? '视频配音服务 · TTS' : 'Video dubbing · TTS'}</h3>
        </div>
        <svg className="section-chevron" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
    </div>
    <div id="tts-section-body" className="settings-section-body">
      <fieldset className="translation-fields" disabled={blocked}>
        <div className="settings-form-grid">
          <label>{zh ? '接口地址 (Base URL)' : 'Base URL'}<input id="tts-base-url" aria-describedby={tokenPlan ? 'tts-token-plan-hint' : undefined} type="url" value={settings.baseUrl} placeholder={DEFAULT_TTS_BASE_URL} spellCheck={false} onChange={event => setSettings(previous => ({ ...previous, baseUrl: event.target.value }))} /></label>
          <label>{zh ? '配音模型' : 'Dubbing model'}<Select id="tts-model" value={dubbingModel(settings.model)} options={dubbingModelOptions} onChange={model => setSettings(previous => ({ ...previous, model }))} /></label>
          <label>{zh ? 'API Key（密钥）' : 'API Key'}
            <div className="secret-input">
              <input
                type={showKey ? 'text' : 'password'}
                value={key}
                autoComplete="off"
                placeholder={hasKey ? (zh ? '已配置密钥；留空保留' : 'Key saved; leave blank to keep') : (zh ? '输入服务商 API Key' : 'Enter provider API key')}
                onChange={event => setKey(event.target.value)}
                aria-label={zh ? 'API Key' : 'API Key'}
              />
              <button type="button" aria-pressed={showKey} onClick={() => setShowKey(value => !value)}>
                {zh ? (showKey ? '隐藏' : '显示') : (showKey ? 'Hide' : 'Show')}
              </button>
            </div>
          </label>
          <label className="checkbox-field"><input type="checkbox" checked={settings.fullUrl} onChange={event => setSettings(previous => ({ ...previous, fullUrl: event.target.checked }))} />{zh ? '接口地址是完整请求地址' : 'URL is a complete endpoint'}</label>
        </div>
        {tokenPlan && <p className="settings-hint" id="tts-token-plan-hint">{zh
          ? 'Token Plan：会自动使用同一域名的 /api/v1 语音接口。当前官方文档列出 qwen-audio-3.0-tts-plus；音色复刻还需账号开放 voice-enrollment 权限，普通合成连接测试成功不代表支持复刻。'
          : 'Token Plan uses the same host’s native /api/v1 speech API. Current documentation lists qwen-audio-3.0-tts-plus. Cloned dubbing additionally needs voice-enrollment access; a successful synthesis test does not verify cloning support.'}</p>}
        <label className="tts-text-field">{zh ? '测试连通性文本' : 'Connectivity test text'}<textarea aria-label={zh ? '合成文本' : 'Text to synthesize'} maxLength={4096} value={text} onChange={event => setText(event.target.value)} placeholder={zh ? '输入测试文字以验证配音服务商连通性…' : 'Enter test text to verify dubbing provider connectivity…'} /><span className="settings-hint">{text.length}/4096</span></label>
        <div className="settings-actions">
          <button className="primary tts-save" type="button" onClick={() => void saveOnly()}>{saving ? (zh ? '保存中…' : 'Saving…') : (zh ? '保存配音设置' : 'Save dubbing settings')}</button>
          <button className="choose-file-button tts-generate" type="button" disabled={!canTest} onClick={() => void generate()}>{generating ? (zh ? '测试中…' : 'Testing…') : (zh ? '测试配音连接' : 'Test dubbing connection')}</button>
          {hasKey && <button className="text-button" type="button" onClick={() => void clearKey()}>{zh ? '清除密钥' : 'Clear key'}</button>}
        </div>
      </fieldset>
      {generating && <button className="cancel-button tts-cancel" type="button" disabled={cancelling} onClick={() => void cancel()}>{cancelling ? (zh ? '取消中…' : 'Cancelling…') : (zh ? '取消测试' : 'Cancel test')}</button>}
      {feedback && <p className={`tts-feedback ${feedback.error ? 'settings-error' : 'settings-notice'}`} role={feedback.error ? 'alert' : 'status'}>{feedback.text}</p>}
      {audio && <div className="tts-audio-result"><audio controls src={audio.url} aria-label={zh ? '合成语音试听' : 'Generated speech preview'} /><a className="text-button tts-download" href={audio.url} download={audio.fileName}>{zh ? '下载测试音频' : 'Download test audio'}</a></div>}
    </div>
  </section>;
}
