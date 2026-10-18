import { useEffect, useState, type ReactNode } from 'react';
import { defaultTranslationSettings, type TranslationSettings } from '../../shared/translation';
import { defaultAsrSettings, type AsrSettings } from '../../shared/asr';
import type { ProviderCatalog, ProviderUpdate } from '../../shared/providers';
import { useI18n } from '../i18n';

const emptyProvider: ProviderUpdate = { name: '', adapter: 'openai-compatible', baseUrl: 'https://api.openai.com/v1' };
function Field({ title, children }: { title: string; children: ReactNode }) {
  return <label>{title}{children}</label>;
}

/** Provider connection data is separate from task/model choices. */
export function ServicesSettings() {
  const { locale } = useI18n();
  const zh = locale === 'zh-CN';
  const [catalog, setCatalog] = useState<ProviderCatalog>({ providers: [], adapters: [] });
  const [draft, setDraft] = useState<ProviderUpdate>({ ...emptyProvider });
  const [key, setKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [translation, setTranslation] = useState<TranslationSettings>({ ...defaultTranslationSettings });
  const [asr, setAsr] = useState<AsrSettings>({ ...defaultAsrSettings });
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [models, setModels] = useState<string[]>([]);
  useEffect(() => {
    let live = true;
    void Promise.all([window.lingvoice.providers(), window.lingvoice.translationConfig(), window.lingvoice.asrConfig()]).then(([providers, trans, speech]) => {
      if (!live) return;
      if (!providers.ok) throw new Error(providers.error);
      if (!trans.ok) throw new Error(trans.error);
      if (!speech.ok) throw new Error(speech.error);
      setCatalog(providers.data); setTranslation(trans.data.settings); setAsr(speech.data.settings); setLoaded(true);
      const first = providers.data.adapters[0];
      if (first) setDraft({ name: '', adapter: first.id, baseUrl: first.defaultBaseUrl });
    }).catch(error => { if (live) setError(error instanceof Error ? error.message : String(error)); });
    return () => { live = false; };
  }, []);
  async function act(operation: () => Promise<void>) {
    setBusy(true); setError(''); setNotice('');
    try { await operation(); }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }
  async function refresh() {
    const result = await window.lingvoice.providers();
    if (!result.ok) throw new Error(result.error);
    setCatalog(result.data);
  }
  const success = () => setNotice(zh ? '设置已保存' : 'Settings saved');
  const edited = catalog.providers.find(provider => provider.id === draft.id);
  const taskProviders = (capability: 'translation' | 'asr') => catalog.providers.filter(provider => catalog.adapters.find(adapter => adapter.id === provider.adapter)?.capabilities.includes(capability));
  const translationProvider = catalog.providers.find(provider => provider.id === translation.providerId);
  const translationAdapter = catalog.adapters.find(adapter => adapter.id === translationProvider?.adapter);
  const modelEnabled = translationAdapter?.translationOptions?.model ?? false;
  const protocols = translationAdapter?.translationOptions?.protocols ?? [];
  function chooseTranslationProvider(id: string) {
    const provider = catalog.providers.find(provider => provider.id === id);
    const choices = catalog.adapters.find(adapter => adapter.id === provider?.adapter)?.translationOptions?.protocols;
    setTranslation(previous => ({ ...previous, providerId: id, protocol: choices?.length && !choices.includes(previous.protocol) ? choices[0] : previous.protocol })); setModels([]);
  }
  const providerChoices = (capability: 'translation' | 'asr', current?: string) => <>
    <option value="">{zh ? '请选择 Provider' : 'Choose a provider'}</option>
    {current && !taskProviders(capability).some(provider => provider.id === current) && <option value={current} disabled>{zh ? '原 Provider 不可用，请重新选择' : 'Provider unavailable; choose another'}</option>}
    {taskProviders(capability).map(provider => <option key={provider.id} value={provider.id}>{provider.name}</option>)}
  </>;
  async function saveTranslation() {
    const result = await window.lingvoice.saveTranslationConfig({ settings: translation });
    if (!result.ok) throw new Error(result.error);
    setTranslation(result.data.settings);
  }
  return <>
    <section className="settings-section provider-section" aria-labelledby="provider-title">
      <div className="settings-section-heading"><h3 id="provider-title">{zh ? '服务提供商 · Providers' : 'Providers'}</h3><p>{zh ? '统一管理连接地址和密钥。翻译与语音识别可以共用同一个 Provider，也可以分别选择。' : 'Manage connections and credentials once. Translation and speech recognition can share a provider or use different ones.'}</p></div>
      <fieldset disabled={!loaded || busy} className="translation-fields">
        <div className="provider-list">{catalog.providers.map(provider => <button type="button" key={provider.id} className={`provider-list-item${draft.id === provider.id ? ' selected' : ''}`} onClick={() => { setDraft({ id: provider.id, name: provider.name, adapter: provider.adapter, baseUrl: provider.baseUrl }); setKey(''); setShowKey(false); }}><strong>{provider.name}</strong><span>{catalog.adapters.find(adapter => adapter.id === provider.adapter)?.name || provider.adapter}</span></button>)}<button type="button" className="choose-file-button" onClick={() => { const adapter = catalog.adapters[0]; setDraft({ name: '', adapter: adapter?.id || emptyProvider.adapter, baseUrl: adapter?.defaultBaseUrl || emptyProvider.baseUrl }); setKey(''); }}>{zh ? '+ 添加 Provider' : '+ Add provider'}</button></div>
        <div className="settings-form-grid">
          <Field title={zh ? '显示名称' : 'Display name'}><input value={draft.name} placeholder={zh ? '例如：我的 API 服务' : 'e.g. My API service'} onChange={e => setDraft(previous => ({ ...previous, name: e.target.value }))} /></Field>
          <Field title={zh ? '接口适配器' : 'API adapter'}><select value={draft.adapter} onChange={e => { const adapter = catalog.adapters.find(adapter => adapter.id === e.target.value); setDraft(previous => ({ ...previous, adapter: e.target.value, baseUrl: adapter?.defaultBaseUrl || previous.baseUrl })); }}>{catalog.adapters.map(adapter => <option key={adapter.id} value={adapter.id}>{adapter.name}</option>)}</select></Field>
          <Field title={zh ? '服务器地址' : 'Server URL'}><input value={draft.baseUrl} placeholder="https://api.example.com/v1" onChange={e => setDraft(previous => ({ ...previous, baseUrl: e.target.value }))} /></Field>
          <Field title="API Key"><div className="secret-input"><input type={showKey ? 'text' : 'password'} value={key} autoComplete="off" placeholder={edited?.hasApiKey ? (zh ? '已保存；留空保留' : 'Saved; leave blank to keep') : (zh ? '可选，依服务而定' : 'Optional; depends on provider')} onChange={e => setKey(e.target.value)} /><button type="button" aria-pressed={showKey} onClick={() => setShowKey(value => !value)}>{zh ? (showKey ? '隐藏' : '显示') : (showKey ? 'Hide' : 'Show')}</button></div></Field>
        </div>
        <p className="settings-hint">{zh ? '适配器声明支持的能力，不保证服务商部署了所有接口。密钥由系统安全存储加密；远程服务请使用 HTTPS。修改地址会影响所有引用此 Provider 的任务。' : 'Adapters declare supported capabilities; actual endpoints depend on your provider. Keys are encrypted using system storage. Use HTTPS remotely. Address changes affect all tasks using this provider.'}</p>
        <div className="settings-actions"><button type="button" className="primary provider-save" onClick={() => void act(async () => { const result = await window.lingvoice.saveProvider({ ...draft, ...(key ? { apiKey: key } : {}) }); if (!result.ok) throw new Error(result.error); setDraft({ id: result.data.id, name: result.data.name, adapter: result.data.adapter, baseUrl: result.data.baseUrl }); setKey(''); await refresh(); success(); })}>{zh ? '保存 Provider' : 'Save provider'}</button>
          {edited?.hasApiKey && <button className="text-button" type="button" onClick={() => void act(async () => { const result = await window.lingvoice.saveProvider({ ...draft, apiKey: '' }); if (!result.ok) throw new Error(result.error); setKey(''); await refresh(); success(); })}>{zh ? '清除密钥' : 'Clear key'}</button>}
          {draft.id && <button className="text-button" type="button" onClick={() => void act(async () => { const result = await window.lingvoice.removeProvider(draft.id!); if (!result.ok) throw new Error(result.error); await refresh(); setDraft({ ...emptyProvider }); setKey(''); success(); })}>{zh ? '删除 Provider' : 'Delete provider'}</button>}
        </div>
      </fieldset>
    </section>
    <section className="settings-section translation-section" aria-labelledby="translation-settings-title">
      <div className="settings-section-heading"><h3 id="translation-settings-title">{zh ? '字幕翻译' : 'Subtitle translation'}</h3><p>{zh ? '仅保存任务所需的模型、协议和语言；地址与密钥由 Provider 提供。' : 'Choose the model, protocol and languages. The provider supplies connection details.'}</p></div>
      <fieldset disabled={!loaded || busy} className="translation-fields"><div className="settings-form-grid">
        <Field title="Provider"><select value={translation.providerId || ''} onChange={e => chooseTranslationProvider(e.target.value)}>{providerChoices('translation', translation.providerId)}</select></Field>
        <Field title={zh ? '目标语言' : 'Target language'}><select value={translation.targetLanguage} onChange={e => setTranslation(previous => ({ ...previous, targetLanguage: e.target.value }))}>{[['zh', '简体中文'], ['en', 'English'], ['ja', '日本語'], ['ko', '한국어'], ['fr', 'Français'], ['de', 'Deutsch'], ['es', 'Español']].map(([code, title]) => <option key={code} value={code}>{title}</option>)}</select></Field>
        <Field title={zh ? '原文语言' : 'Source language'}><input value={translation.sourceLanguage} placeholder="auto / en / zh" onChange={e => setTranslation(previous => ({ ...previous, sourceLanguage: e.target.value }))} /></Field>
        {protocols.length > 0 && <Field title={zh ? '请求协议' : 'Request protocol'}><select value={translation.protocol} onChange={e => setTranslation(previous => ({ ...previous, protocol: e.target.value }))}>{protocols.map(protocol => <option key={protocol} value={protocol}>{protocol === 'chat' ? 'Chat Completions' : protocol === 'responses' ? 'Responses API' : protocol}</option>)}</select></Field>}
        {modelEnabled && <Field title={zh ? '模型名称' : 'Model name'}><div className="model-input"><input list="translation-models" value={translation.model} onChange={e => setTranslation(previous => ({ ...previous, model: e.target.value }))} /><button type="button" className="choose-file-button" disabled={!translationAdapter?.capabilities.includes('models')} onClick={() => void act(async () => { await saveTranslation(); const result = await window.lingvoice.translationModels(); if (!result.ok) throw new Error(result.error); setModels(result.data); setNotice(zh ? `已获取 ${result.data.length} 个模型` : `${result.data.length} models loaded`); })}>{zh ? '获取模型' : 'Fetch models'}</button></div><datalist id="translation-models">{models.map(model => <option key={model} value={model} />)}</datalist></Field>}
        <label className="checkbox-field"><input type="checkbox" checked={translation.fullUrl} onChange={e => setTranslation(previous => ({ ...previous, fullUrl: e.target.checked }))} />{zh ? 'Provider 地址是完整请求地址' : 'Provider URL is a complete endpoint'}</label>
      </div><div className="settings-actions"><button className="primary translation-save" type="button" onClick={() => void act(async () => { await saveTranslation(); success(); })}>{zh ? '保存翻译设置' : 'Save translation'}</button><button className="choose-file-button" type="button" onClick={() => void act(async () => { await saveTranslation(); const result = await window.lingvoice.translateSubtitles({ texts: ['Hello, welcome to LingVoice.'] }); if (!result.ok) throw new Error(result.error); setNotice(result.data[0]); })}>{zh ? '测试翻译（少量用量）' : 'Test translation (uses quota)'}</button></div></fieldset>
    </section>
    <section className="settings-section asr-section" aria-labelledby="asr-settings-title">
      <div className="settings-section-heading"><h3 id="asr-settings-title">{zh ? '语音识别 · ASR' : 'Speech recognition · ASR'}</h3><p>{zh ? '从视频生成带时间轴的原文字幕，再使用上面的翻译服务。' : 'Generate timestamped original subtitles from video, then use the translation service above.'}</p></div>
      <fieldset disabled={!loaded || busy} className="translation-fields"><div className="settings-form-grid">
        <Field title="Provider"><select value={asr.providerId || ''} onChange={e => setAsr(previous => ({ ...previous, providerId: e.target.value }))}>{providerChoices('asr', asr.providerId)}</select></Field>
        <Field title={zh ? '识别模型' : 'Transcription model'}><input value={asr.model} placeholder="whisper-1" onChange={e => setAsr(previous => ({ ...previous, model: e.target.value }))} /></Field>
        <Field title={zh ? '音频语言（留空自动识别）' : 'Audio language (blank for auto detect)'}><input value={asr.language} placeholder="en / zh / ja" onChange={e => setAsr(previous => ({ ...previous, language: e.target.value }))} /></Field>
        <Field title={zh ? '术语提示（可选）' : 'Terminology prompt (optional)'}><input value={asr.prompt} onChange={e => setAsr(previous => ({ ...previous, prompt: e.target.value }))} /></Field>
        <label className="checkbox-field"><input type="checkbox" checked={asr.fullUrl} onChange={e => setAsr(previous => ({ ...previous, fullUrl: e.target.checked }))} />{zh ? 'Provider 地址是完整请求地址' : 'Provider URL is a complete endpoint'}</label>
      </div><p className="settings-hint">{zh ? 'OpenAI 兼容适配器使用 /v1/audio/transcriptions，要求支持 verbose_json 和 segments 时间戳，建议先用 whisper-1。音频会上传至所选服务，可能收费。每 5 分钟分段识别；最长 6 小时。' : 'The OpenAI adapter uses /v1/audio/transcriptions and requires verbose_json with segment timestamps. Start with whisper-1. Audio is uploaded to the chosen service and may incur charges. Audio is split into 5-minute chunks, up to 6 hours.'}</p><div className="settings-actions"><button className="primary asr-save" type="button" onClick={() => void act(async () => { const result = await window.lingvoice.saveAsrConfig({ settings: asr }); if (!result.ok) throw new Error(result.error); setAsr(result.data.settings); success(); })}>{zh ? '保存语音识别设置' : 'Save speech recognition'}</button></div></fieldset>
    </section>
    {notice && <p className="settings-notice services-feedback" role="status">{notice}</p>}{error && <p className="settings-error services-feedback" role="alert">{error}</p>}
  </>;
}
