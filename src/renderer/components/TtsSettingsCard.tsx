import { useEffect, useRef, useState } from 'react';
import type { ProviderCatalog } from '../../shared/providers';
import { defaultTtsSettings, type TtsSettings } from '../../shared/tts';
import { useI18n } from '../i18n';
import type { useProviderModels } from '../hooks/useProviderModels';
import { ModelPicker } from './ModelPicker';
import { Select } from './Select';

type Models = ReturnType<typeof useProviderModels>;
const voices = ['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer', 'verse'];

interface Props {
  catalog: ProviderCatalog;
  models: Models;
  disabled: boolean;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
}

export function TtsSettingsCard({ catalog, models, disabled, collapsed = false, onToggleCollapse }: Props) {
  const { locale } = useI18n();
  const zh = locale === 'zh-CN';
  const [settings, setSettings] = useState<TtsSettings>({ ...defaultTtsSettings });
  const [hasKey, setHasKey] = useState(false);
  const [key, setKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [text, setText] = useState('');
  const [customVoice, setCustomVoice] = useState(false);
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
    void window.lingvoice.ttsConfig().then(result => {
      if (!active) return;
      if (!result.ok) throw new Error(result.error);
      setSettings(result.data.settings);
      setHasKey(result.data.hasApiKey);
      setCustomVoice(!voices.includes(result.data.settings.voice));
      setLoaded(true);
    }).catch(error => { if (active) setFeedback({ error: true, text: String(error instanceof Error ? error.message : error) }); });
    return () => {
      active = false; live.current = false; requestVersion.current++;
      if (running.current) void window.lingvoice.cancelTts().catch(() => {});
    };
  }, []);
  useEffect(() => () => { if (audio) URL.revokeObjectURL(audio.url); }, [audio]);

  const provider = catalog.providers.find(item => item.id === settings.providerId);
  const adapter = catalog.adapters.find(item => item.id === provider?.adapter);
  const options = catalog.providers.filter(item => catalog.adapters.find(a => a.id === item.adapter)?.capabilities.includes('tts'))
    .map(item => ({ value: item.id, label: item.name }));
  if (settings.providerId && !options.some(item => item.value === settings.providerId)) options.unshift({ value: settings.providerId, label: zh ? '原 Provider 不可用' : 'Provider unavailable' });
  const blocked = disabled || !loaded || saving || generating;

  async function save(explicitKey?: string) {
    const payload = { settings, ...(explicitKey !== undefined ? { apiKey: explicitKey } : key ? { apiKey: key } : {}) };
    const result = await window.lingvoice.saveTtsConfig(payload);
    if (!result.ok) throw new Error(result.error);
    if (live.current) {
      setSettings(result.data.settings);
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
      if (live.current) setFeedback({ error: false, text: zh ? '已清除独立密钥，已恢复使用 Provider 默认密钥' : 'Custom key cleared; reverted to Provider default key' });
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
          <h3 id="tts-settings-title">{zh ? '文字转语音 · TTS' : 'Text to speech · TTS'}</h3>
          <p>{zh ? '使用 OpenAI 兼容语音接口；可用模型、音色与费用以服务商为准。' : 'Uses the OpenAI-compatible speech API. Models, voices and pricing depend on your provider.'}</p>
        </div>
        <svg className="section-chevron" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
    </div>
    <div id="tts-section-body" className="settings-section-body">
      <p className="settings-hint">{zh ? '视频配音复用此处保存的 Provider 和 API Key，可选择 qwen-audio-3.1-tts-plus 或 qwen-audio-3.0-tts-plus；此处模型仍只用于普通文字转语音。' : 'Video dubbing reuses the provider and API key saved here (supporting qwen-audio-3.1-tts-plus or qwen-audio-3.0-tts-plus). The model selected here remains for ordinary text to speech only.'}</p>
      <fieldset className="translation-fields" disabled={blocked}>
        <div className="settings-form-grid">
          <label>Provider<Select id="tts-provider" value={settings.providerId} options={[{ value: '', label: zh ? '请选择 Provider' : 'Choose a provider' }, ...options]} onChange={providerId => { setSettings(previous => ({ ...previous, providerId })); setFeedback(null); }} /></label>
          <label>{zh ? '合成模型' : 'Speech model'}<ModelPicker id="tts-model" providerId={settings.providerId} value={settings.model} onChange={model => setSettings(previous => ({ ...previous, model }))} entry={models.entries[settings.providerId]} onFetch={() => void models.fetchModels(settings.providerId)} supportsModels={!!adapter?.capabilities.includes('models')} placeholder="tts-1" zh={zh} disabled={blocked} /></label>
          <label>
            {zh ? '音色' : 'Voice'}
            {customVoice ? (
              <div className="model-input">
                <input
                  aria-label={zh ? '克隆 / 自定义音色 ID' : 'Cloned / Custom voice ID'}
                  value={settings.voice}
                  onChange={event => setSettings(previous => ({ ...previous, voice: event.target.value }))}
                  placeholder={zh ? '输入克隆音色 ID 或服务商音色' : 'Enter cloned voice ID or provider voice'}
                  autoFocus
                />
                <button
                  type="button"
                  className="choose-file-button"
                  onClick={() => {
                    setCustomVoice(false);
                    if (!voices.includes(settings.voice)) setSettings(previous => ({ ...previous, voice: 'alloy' }));
                  }}
                >
                  {zh ? '预设音色' : 'Preset voices'}
                </button>
              </div>
            ) : (
              <Select
                id="tts-voice"
                value={settings.voice}
                options={[
                  { value: '__custom__', label: zh ? '克隆 / 自定义音色…' : 'Cloned / Custom voice…' },
                  ...voices.map(value => ({ value, label: value })),
                ]}
                onChange={voice => {
                  if (voice === '__custom__') {
                    setCustomVoice(true);
                  } else {
                    setSettings(previous => ({ ...previous, voice }));
                  }
                }}
              />
            )}
          </label>
          <label>{zh ? '语速' : 'Speed'}<input aria-label={zh ? '语速' : 'Speed'} type="number" min="0.25" max="4" step="0.05" value={settings.speed} onChange={event => setSettings(previous => ({ ...previous, speed: Number(event.target.value) }))} /></label>
          <label>{zh ? '独立 API Key（可选）' : 'Custom API Key (optional)'}
            <div className="secret-input">
              <input
                type={showKey ? 'text' : 'password'}
                value={key}
                autoComplete="off"
                placeholder={hasKey ? (zh ? '已配置独立密钥；留空保留' : 'Custom key saved; leave blank to keep') : (zh ? '留空使用 Provider 默认密钥' : 'Leave blank to use Provider key')}
                onChange={event => setKey(event.target.value)}
                aria-label={zh ? '独立 API Key' : 'Custom API Key'}
              />
              <button type="button" aria-pressed={showKey} onClick={() => setShowKey(value => !value)}>
                {zh ? (showKey ? '隐藏' : '显示') : (showKey ? 'Hide' : 'Show')}
              </button>
            </div>
          </label>
          <label className="checkbox-field"><input type="checkbox" checked={settings.fullUrl} onChange={event => setSettings(previous => ({ ...previous, fullUrl: event.target.checked }))} />{zh ? 'Provider 地址是完整请求地址' : 'Provider URL is a complete endpoint'}</label>
        </div>
        <label className="tts-text-field">{zh ? '合成文本' : 'Text to synthesize'}<textarea aria-label={zh ? '合成文本' : 'Text to synthesize'} maxLength={4096} value={text} onChange={event => setText(event.target.value)} placeholder={zh ? '输入要转换为语音的文字…' : 'Enter text to convert to speech…'} /><span className="settings-hint">{text.length}/4096</span></label>
        <div className="settings-actions">
          <button className="primary tts-save" type="button" onClick={() => void saveOnly()}>{saving ? (zh ? '保存中…' : 'Saving…') : (zh ? '保存语音合成设置' : 'Save speech settings')}</button>
          <button className="choose-file-button tts-generate" type="button" disabled={!settings.providerId || !text.trim()} onClick={() => void generate()}>{generating ? (zh ? '生成中…' : 'Generating…') : (zh ? '生成语音（使用额度）' : 'Generate speech (uses quota)')}</button>
          {hasKey && <button className="text-button" type="button" onClick={() => void clearKey()}>{zh ? '清除独立密钥' : 'Clear custom key'}</button>}
        </div>
      </fieldset>
      {generating && <button className="cancel-button tts-cancel" type="button" disabled={cancelling} onClick={() => void cancel()}>{cancelling ? (zh ? '取消中…' : 'Cancelling…') : (zh ? '取消生成' : 'Cancel generation')}</button>}
      {feedback && <p className={`tts-feedback ${feedback.error ? 'settings-error' : 'settings-notice'}`} role={feedback.error ? 'alert' : 'status'}>{feedback.text}</p>}
      {audio && <div className="tts-audio-result"><audio controls src={audio.url} aria-label={zh ? '合成语音试听' : 'Generated speech preview'} /><a className="text-button tts-download" href={audio.url} download={audio.fileName}>{zh ? '下载 MP3' : 'Download MP3'}</a></div>}
    </div>
  </section>;
}
