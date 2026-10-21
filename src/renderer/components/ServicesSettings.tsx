import { useEffect, useRef, useState, type ReactNode } from 'react';
import { defaultTranslationSettings, type TranslationSettings } from '../../shared/translation';
import { defaultAsrSettings, type AsrSettings } from '../../shared/asr';
import type { ProviderCatalog, ProviderUpdate } from '../../shared/providers';
import { Select, type SelectOption } from './Select';
import { ModelPicker } from './ModelPicker';
import { TtsSettingsCard } from './TtsSettingsCard';
import { useProviderModels } from '../hooks/useProviderModels';
import { languageOptions, normalizeLanguageSelection } from '../utils/languages';
import { useI18n } from '../i18n';

const emptyProvider: ProviderUpdate = { name: '', adapter: 'openai-compatible', baseUrl: '' };
type Feedback = { error: boolean; text: string } | null;
function Field({ title, children }: { title: string; children: ReactNode }) {
  return <label>{title}{children}</label>;
}
function Result({ value, className = '' }: { value: Feedback; className?: string }) {
  return value ? <p className={`${value.error ? 'settings-error' : 'settings-notice'} ${className}`} role={value.error ? 'alert' : 'status'}>{value.text}</p> : null;
}
function ChevronIcon() {
  return (
    <svg className="section-chevron" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

/** Connection credentials belong to Providers; task settings, custom keys and feedback are independent. */
export function ServicesSettings() {
  const { locale } = useI18n();
  const zh = locale === 'zh-CN';
  const [catalog, setCatalog] = useState<ProviderCatalog>({ providers: [], adapters: [] });
  const [draft, setDraft] = useState<ProviderUpdate>({ ...emptyProvider });
  const [key, setKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [translation, setTranslation] = useState<TranslationSettings>({ ...defaultTranslationSettings });
  const [hasTranslationKey, setHasTranslationKey] = useState(false);
  const [translationKey, setTranslationKey] = useState('');
  const [showTranslationKey, setShowTranslationKey] = useState(false);
  const [asr, setAsr] = useState<AsrSettings>({ ...defaultAsrSettings });
  const [hasAsrKey, setHasAsrKey] = useState(false);
  const [asrKey, setAsrKey] = useState('');
  const [showAsrKey, setShowAsrKey] = useState(false);
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(() => new Set());
  const [busy, setBusy] = useState(false);
  const actionRunning = useRef(false);
  const [loaded, setLoaded] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [translationFeedback, setTranslationFeedback] = useState<Feedback>(null);
  const [asrFeedback, setAsrFeedback] = useState<Feedback>(null);
  const [testingTranslation, setTestingTranslation] = useState(false);
  const [testingAsr, setTestingAsr] = useState(false);
  const models = useProviderModels(catalog);

  const toggleSection = (id: string) => {
    setCollapsedSections(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  useEffect(() => {
    let live = true;
    void Promise.all([window.lingvoice.providers(), window.lingvoice.translationConfig(), window.lingvoice.asrConfig()]).then(([providers, trans, speech]) => {
      if (!live) return;
      if (!providers.ok) throw new Error(providers.error);
      if (!trans.ok) throw new Error(trans.error);
      if (!speech.ok) throw new Error(speech.error);
      setCatalog(providers.data);
      setTranslation({
        ...trans.data.settings,
        targetLanguage: normalizeLanguageSelection(trans.data.settings.targetLanguage, 'zh'),
        sourceLanguage: normalizeLanguageSelection(trans.data.settings.sourceLanguage, 'auto'),
      });
      setHasTranslationKey(trans.data.hasApiKey);
      setAsr({
        ...speech.data.settings,
        prompt: '',
        language: normalizeLanguageSelection(speech.data.settings.language, ''),
      });
      setHasAsrKey(speech.data.hasApiKey);
      setLoaded(true);
      const first = providers.data.adapters[0];
      if (first) setDraft({ name: '', adapter: first.id, baseUrl: '' });
    }).catch(error => { if (live) setError(error instanceof Error ? error.message : String(error)); });
    return () => { live = false; };
  }, []);

  async function act(operation: () => Promise<void>) {
    if (actionRunning.current) return;
    actionRunning.current = true; setBusy(true); setError(''); setNotice('');
    try { await operation(); }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { actionRunning.current = false; setBusy(false); }
  }

  async function refresh() {
    models.invalidate();
    const result = await window.lingvoice.providers();
    if (!result.ok) throw new Error(result.error);
    setCatalog(result.data);
  }

  const success = () => setNotice(zh ? '设置已保存' : 'Settings saved');
  const edited = catalog.providers.find(provider => provider.id === draft.id);
  const taskProviders = (capability: 'translation' | 'asr') => catalog.providers.filter(provider => catalog.adapters.find(adapter => adapter.id === provider.adapter)?.capabilities.includes(capability));
  const translationProvider = catalog.providers.find(provider => provider.id === translation.providerId);
  const translationAdapter = catalog.adapters.find(adapter => adapter.id === translationProvider?.adapter);
  const asrProvider = catalog.providers.find(provider => provider.id === asr.providerId);
  const asrAdapter = catalog.adapters.find(adapter => adapter.id === asrProvider?.adapter);
  const modelEnabled = translationAdapter?.translationOptions?.model ?? false;
  const protocols = translationAdapter?.translationOptions?.protocols ?? [];

  function chooseTranslationProvider(id: string) {
    const provider = catalog.providers.find(provider => provider.id === id);
    const choices = catalog.adapters.find(adapter => adapter.id === provider?.adapter)?.translationOptions?.protocols;
    setTranslation(previous => ({ ...previous, providerId: id, protocol: choices?.length && !choices.includes(previous.protocol) ? choices[0] : previous.protocol }));
    setTranslationFeedback(null);
  }

  const getProviderOptions = (capability: 'translation' | 'asr', current?: string): SelectOption[] => {
    const defaultLabel = capability === 'asr'
      ? (zh ? '自定义配置（直接填写 Base URL 与 Key）' : 'Custom (Direct Base URL & Key)')
      : (zh ? '请选择 Provider' : 'Choose a provider');
    const list: SelectOption[] = [{ value: '', label: defaultLabel }];
    if (current && !taskProviders(capability).some(provider => provider.id === current)) list.push({ value: current, label: zh ? '原 Provider 不可用，请重新选择' : 'Provider unavailable; choose another', disabled: true });
    taskProviders(capability).forEach(provider => list.push({ value: provider.id, label: provider.name }));
    return list;
  };

  async function saveTranslation(explicitKey?: string) {
    const payload = {
      settings: {
        ...translation,
        baseUrl: translation.baseUrl.trim() || defaultTranslationSettings.baseUrl,
        machineUrl: translation.machineUrl.trim() || defaultTranslationSettings.machineUrl,
        model: translation.model.trim() || defaultTranslationSettings.model,
      },
      ...(explicitKey !== undefined ? { apiKey: explicitKey } : translationKey ? { apiKey: translationKey } : {}),
    };
    const result = await window.lingvoice.saveTranslationConfig(payload);
    if (!result.ok) throw new Error(result.error);
    setTranslation(result.data.settings);
    setHasTranslationKey(result.data.hasApiKey);
    setTranslationKey('');
  }

  async function clearTranslationKey() {
    if (actionRunning.current) return;
    actionRunning.current = true; setBusy(true); setTranslationFeedback(null);
    try {
      await saveTranslation('');
      setTranslationFeedback({ error: false, text: zh ? '已清除独立密钥，已恢复使用 Provider 默认密钥' : 'Custom key cleared; reverted to Provider default key' });
    } catch (err) {
      setTranslationFeedback({ error: true, text: err instanceof Error ? err.message : String(err) });
    } finally {
      actionRunning.current = false; setBusy(false);
    }
  }

  async function runTranslation(test: boolean) {
    if (actionRunning.current) return;
    actionRunning.current = true; setBusy(true); setTestingTranslation(test); setTranslationFeedback(null);
    try {
      if (test && !translation.providerId) throw new Error(zh ? '请先选择翻译 Provider。' : 'Choose a translation provider first.');
      await saveTranslation();
      if (test) {
        const result = await window.lingvoice.translateSubtitles({ texts: ['Hello, welcome to LingVoice.'] });
        if (!result.ok) throw new Error(result.error);
        setTranslationFeedback({ error: false, text: result.data[0] });
      } else setTranslationFeedback({ error: false, text: zh ? '翻译设置已保存' : 'Settings saved' });
    } catch (error) { setTranslationFeedback({ error: true, text: error instanceof Error ? error.message : String(error) }); }
    finally { actionRunning.current = false; setBusy(false); setTestingTranslation(false); }
  }

  async function saveAsrConfigPayload(explicitKey?: string) {
    const payload = {
      settings: {
        ...asr,
        prompt: '',
        baseUrl: asr.baseUrl.trim() || defaultAsrSettings.baseUrl,
        model: asr.model.trim() || defaultAsrSettings.model,
      },
      ...(explicitKey !== undefined ? { apiKey: explicitKey } : asrKey ? { apiKey: asrKey } : {}),
    };
    const result = await window.lingvoice.saveAsrConfig(payload);
    if (!result.ok) throw new Error(result.error);
    setAsr({ ...result.data.settings, prompt: '' });
    setHasAsrKey(result.data.hasApiKey);
    setAsrKey('');
    return result.data;
  }

  async function runAsr(test: boolean) {
    if (actionRunning.current) return;
    actionRunning.current = true; setBusy(true); setTestingAsr(test); setAsrFeedback(null);
    try {
      if (test && !asr.providerId && !asr.baseUrl.trim()) throw new Error(zh ? '请先填写接口地址 (Base URL) 或选择 Provider。' : 'Enter a Base URL or choose a provider first.');
      await saveAsrConfigPayload();
      if (test) {
        const result = await window.lingvoice.testAsr();
        if (!result.ok) throw new Error(result.error);
        setAsrFeedback({ error: false, text: zh ? '✓ 测试成功！语音识别转写接口正常。' : '✓ Test succeeded! ASR transcription endpoint is working.' });
      } else {
        setAsrFeedback({ error: false, text: zh ? '语音识别设置已保存' : 'Speech recognition settings saved' });
      }
    } catch (error) { setAsrFeedback({ error: true, text: error instanceof Error ? error.message : String(error) }); }
    finally { actionRunning.current = false; setBusy(false); setTestingAsr(false); }
  }

  function chooseAsrProvider(id: string) {
    const provider = catalog.providers.find(p => p.id === id);
    setAsr(previous => ({
      ...previous,
      providerId: id,
      baseUrl: provider ? provider.baseUrl : (previous.baseUrl || defaultAsrSettings.baseUrl),
    }));
    setAsrFeedback(null);
  }

  async function clearAsrKey() {
    if (actionRunning.current) return;
    actionRunning.current = true; setBusy(true); setAsrFeedback(null);
    try {
      await saveAsrConfigPayload('');
      setAsrFeedback({ error: false, text: zh ? '独立密钥已清除' : 'Custom key cleared' });
    } catch (error) { setAsrFeedback({ error: true, text: error instanceof Error ? error.message : String(error) }); }
    finally { actionRunning.current = false; setBusy(false); }
  }

  return <>
    <section className={`settings-section provider-section${collapsedSections.has('provider') ? ' is-collapsed' : ''}`} aria-labelledby="provider-title">
      <div className="settings-section-heading">
        <button
          type="button"
          className="settings-section-header"
          onClick={() => toggleSection('provider')}
          aria-expanded={!collapsedSections.has('provider')}
          aria-controls="provider-section-body"
        >
          <h3 id="provider-title">{zh ? '服务提供商 · Providers' : 'Providers'}</h3>
          <ChevronIcon />
        </button>
      </div>
      <div id="provider-section-body" className="settings-section-body">
        <fieldset disabled={!loaded || busy} className="translation-fields">
          <div className="provider-list">
            {catalog.providers.map(provider => <button type="button" key={provider.id} className={`provider-list-item${draft.id === provider.id ? ' selected' : ''}`} onClick={() => { setDraft({ id: provider.id, name: provider.name, adapter: provider.adapter, baseUrl: provider.baseUrl }); setKey(''); setShowKey(false); }}><strong>{provider.name}</strong><span>{catalog.adapters.find(adapter => adapter.id === provider.adapter)?.name || provider.adapter}</span></button>)}
          </div>
          <div className="settings-form-grid">
            <Field title={zh ? '显示名称' : 'Display name'}><input value={draft.name} placeholder={zh ? '例如：我的 API 服务' : 'e.g. My API service'} onChange={event => setDraft(previous => ({ ...previous, name: event.target.value }))} /></Field>
            <Field title={zh ? '接口适配器' : 'API adapter'}><Select value={draft.adapter} options={catalog.adapters.map(adapter => ({ value: adapter.id, label: adapter.name }))} onChange={adapter => setDraft(previous => ({ ...previous, adapter }))} /></Field>
            <Field title={zh ? '服务器地址' : 'Server URL'}><input value={draft.baseUrl} placeholder="https://api.openai.com/v1" onChange={event => setDraft(previous => ({ ...previous, baseUrl: event.target.value }))} /></Field>
            <Field title="API Key"><div className="secret-input"><input type={showKey ? 'text' : 'password'} value={key} autoComplete="off" placeholder={edited?.hasApiKey ? (zh ? '已保存；留空保留' : 'Saved; leave blank to keep') : (zh ? '可选，依服务而定' : 'Optional; depends on provider')} onChange={event => setKey(event.target.value)} /><button type="button" aria-pressed={showKey} onClick={() => setShowKey(value => !value)}>{zh ? (showKey ? '隐藏' : '显示') : (showKey ? 'Hide' : 'Show')}</button></div></Field>
          </div>
          <div className="settings-actions"><button type="button" className="primary provider-save" onClick={() => void act(async () => { const result = await window.lingvoice.saveProvider({ ...draft, ...(key ? { apiKey: key } : {}) }); if (!result.ok) throw new Error(result.error); setDraft({ id: result.data.id, name: result.data.name, adapter: result.data.adapter, baseUrl: result.data.baseUrl }); setKey(''); await refresh(); success(); })}>{zh ? '保存 Provider' : 'Save provider'}</button>
            {edited?.hasApiKey && <button className="text-button" type="button" onClick={() => void act(async () => { const result = await window.lingvoice.saveProvider({ ...draft, apiKey: '' }); if (!result.ok) throw new Error(result.error); setKey(''); await refresh(); success(); })}>{zh ? '清除密钥' : 'Clear key'}</button>}
            {draft.id && <button className="text-button" type="button" onClick={() => void act(async () => { const result = await window.lingvoice.removeProvider(draft.id!); if (!result.ok) throw new Error(result.error); await refresh(); setDraft({ ...emptyProvider }); setKey(''); success(); })}>{zh ? '删除 Provider' : 'Delete provider'}</button>}
          </div>
        </fieldset>
        {notice && <p className="settings-notice services-feedback" role="status">{notice}</p>}{error && <p className="settings-error services-feedback" role="alert">{error}</p>}
      </div>
    </section>

    <section className={`settings-section translation-section${collapsedSections.has('translation') ? ' is-collapsed' : ''}`} aria-labelledby="translation-settings-title">
      <div className="settings-section-heading">
        <button
          type="button"
          className="settings-section-header"
          onClick={() => toggleSection('translation')}
          aria-expanded={!collapsedSections.has('translation')}
          aria-controls="translation-section-body"
        >
          <h3 id="translation-settings-title">{zh ? '字幕翻译' : 'Subtitle translation'}</h3>
          <ChevronIcon />
        </button>
      </div>
      <div id="translation-section-body" className="settings-section-body">
        <fieldset disabled={!loaded || busy} className="translation-fields"><div className="settings-form-grid">
          <Field title="Provider"><Select id="translation-provider" value={translation.providerId || ''} options={getProviderOptions('translation', translation.providerId)} onChange={chooseTranslationProvider} /></Field>
          <Field title={zh ? '目标语言' : 'Target language'}><Select id="translation-target-language" value={translation.targetLanguage} options={languageOptions(zh, 'auto', translation.targetLanguage, false)} onChange={targetLanguage => setTranslation(previous => ({ ...previous, targetLanguage }))} /></Field>
          <Field title={zh ? '原文语言' : 'Source language'}><Select id="translation-source-language" value={translation.sourceLanguage} options={languageOptions(zh, 'auto', translation.sourceLanguage)} onChange={sourceLanguage => setTranslation(previous => ({ ...previous, sourceLanguage }))} /></Field>
          {protocols.length > 0 && <Field title={zh ? '请求协议' : 'Request protocol'}><Select id="translation-protocol" value={translation.protocol} options={protocols.map(value => ({ value, label: value === 'chat' ? 'Chat Completions' : value === 'responses' ? 'Responses API' : value }))} onChange={protocol => setTranslation(previous => ({ ...previous, protocol }))} /></Field>}
          {modelEnabled && <Field title={zh ? '模型名称' : 'Model name'}><ModelPicker id="translation-model" providerId={translation.providerId || ''} value={translation.model} onChange={model => setTranslation(previous => ({ ...previous, model }))} entry={models.entries[translation.providerId || '']} onFetch={() => void models.fetchModels(translation.providerId || '')} supportsModels={!!translationAdapter?.capabilities.includes('models')} disabled={busy} placeholder="gpt-4o-mini" zh={zh} /></Field>}
          <Field title={zh ? '独立 API Key（可选）' : 'Custom API Key (optional)'}>
            <div className="secret-input">
              <input
                type={showTranslationKey ? 'text' : 'password'}
                value={translationKey}
                autoComplete="off"
                placeholder={hasTranslationKey ? (zh ? '已配置独立密钥；留空保留' : 'Custom key saved; leave blank to keep') : (zh ? '留空使用 Provider 默认密钥' : 'Leave blank to use Provider key')}
                onChange={event => setTranslationKey(event.target.value)}
                aria-label={zh ? '独立 API Key' : 'Custom API Key'}
              />
              <button type="button" aria-pressed={showTranslationKey} onClick={() => setShowTranslationKey(value => !value)}>
                {zh ? (showTranslationKey ? '隐藏' : '显示') : (showTranslationKey ? 'Hide' : 'Show')}
              </button>
            </div>
          </Field>
          <label className="checkbox-field"><input type="checkbox" checked={translation.fullUrl} onChange={event => setTranslation(previous => ({ ...previous, fullUrl: event.target.checked }))} />{zh ? 'Provider 地址是完整请求地址' : 'Provider URL is a complete endpoint'}</label>
        </div><div className="settings-actions">
          <button className="primary translation-save" type="button" onClick={() => void runTranslation(false)}>{zh ? '保存翻译设置' : 'Save translation'}</button>
          <button className="choose-file-button translation-test" type="button" onClick={() => void runTranslation(true)}>{testingTranslation ? (zh ? '测试中…' : 'Testing…') : (zh ? '测试翻译（少量用量）' : 'Test translation (uses quota)')}</button>
          {hasTranslationKey && <button className="text-button" type="button" onClick={() => void clearTranslationKey()}>{zh ? '清除独立密钥' : 'Clear custom key'}</button>}
        </div></fieldset>
        <Result value={translationFeedback} className="translation-test-feedback" />
      </div>
    </section>

    <section className={`settings-section asr-section${collapsedSections.has('asr') ? ' is-collapsed' : ''}`} aria-labelledby="asr-settings-title">
      <div className="settings-section-heading">
        <button
          type="button"
          className="settings-section-header"
          onClick={() => toggleSection('asr')}
          aria-expanded={!collapsedSections.has('asr')}
          aria-controls="asr-section-body"
        >
          <h3 id="asr-settings-title">{zh ? '语音识别 · ASR' : 'Speech recognition · ASR'}</h3>
          <ChevronIcon />
        </button>
      </div>
      <div id="asr-section-body" className="settings-section-body">
        <p className="settings-hint asr-hint" style={{ margin: '0 0 12px', fontSize: '13px', color: 'var(--color-text-muted, #666)', lineHeight: 1.5 }}>
          {zh
            ? '支持自定义填写接口地址 (Base URL)、API Key 与识别模型（如本地 Whisper、SiliconFlow、Groq 等），也可以选择已有的 Provider。'
            : 'You can directly enter a custom Base URL, API Key, and model (e.g. local Whisper, SiliconFlow, Groq), or select an existing Provider.'}
        </p>
        <fieldset disabled={!loaded || busy} className="translation-fields"><div className="settings-form-grid">
          <Field title="Provider"><Select id="asr-provider" value={asr.providerId || ''} options={getProviderOptions('asr', asr.providerId)} onChange={chooseAsrProvider} /></Field>
          <Field title={zh ? '接口地址 (Base URL)' : 'Base URL'}>
            <input
              id="asr-base-url"
              type="url"
              value={asr.baseUrl}
              placeholder="https://api.openai.com/v1"
              onChange={event => setAsr(previous => ({ ...previous, baseUrl: event.target.value }))}
            />
          </Field>
          <Field title={zh ? '识别模型' : 'Transcription model'}><ModelPicker id="asr-model" providerId={asr.providerId || ''} value={asr.model} onChange={model => setAsr(previous => ({ ...previous, model }))} entry={asr.providerId ? models.entries[asr.providerId] : undefined} onFetch={() => asr.providerId && void models.fetchModels(asr.providerId)} supportsModels={!!asrAdapter?.capabilities.includes('models')} disabled={busy} placeholder="whisper-1" zh={zh} /></Field>
          <Field title={zh ? '音频语言' : 'Audio language'}><Select id="asr-language" value={asr.language} options={languageOptions(zh, '', asr.language)} onChange={language => setAsr(previous => ({ ...previous, language }))} /></Field>
          <Field title={asr.providerId ? (zh ? '独立 API Key（可选）' : 'Custom API Key (optional)') : (zh ? 'API Key（密钥）' : 'API Key')}>
            <div className="secret-input">
              <input
                type={showAsrKey ? 'text' : 'password'}
                value={asrKey}
                autoComplete="off"
                placeholder={hasAsrKey ? (zh ? '已配置密钥；留空保留' : 'Key saved; leave blank to keep') : (asr.providerId ? (zh ? '留空使用 Provider 默认密钥' : 'Leave blank to use Provider key') : (zh ? '输入 API Key（本地部署无密码可留空）' : 'Enter API Key (or leave blank if none)'))}
                onChange={event => setAsrKey(event.target.value)}
                aria-label={zh ? 'API Key' : 'API Key'}
              />
              <button type="button" aria-pressed={showAsrKey} onClick={() => setShowAsrKey(value => !value)}>
                {zh ? (showAsrKey ? '隐藏' : '显示') : (showAsrKey ? 'Hide' : 'Show')}
              </button>
            </div>
          </Field>
          <label className="checkbox-field"><input type="checkbox" checked={asr.fullUrl} onChange={event => setAsr(previous => ({ ...previous, fullUrl: event.target.checked }))} />{zh ? '接口地址是完整请求地址 (/audio/transcriptions)' : 'Endpoint is full URL'}</label>
        </div><div className="settings-actions">
          <button className="primary asr-save" type="button" onClick={() => void runAsr(false)}>{zh ? '保存语音识别设置' : 'Save speech recognition'}</button>
          <button className="choose-file-button asr-test" type="button" onClick={() => void runAsr(true)}>{testingAsr ? (zh ? '测试中…' : 'Testing…') : (zh ? '测试语音识别' : 'Test speech recognition')}</button>
          {hasAsrKey && <button className="text-button" type="button" onClick={() => void clearAsrKey()}>{zh ? '清除密钥' : 'Clear key'}</button>}
        </div></fieldset>
        <Result value={asrFeedback} className="asr-feedback" />
      </div>
    </section>

    <TtsSettingsCard
      catalog={catalog}
      models={models}
      disabled={!loaded || busy}
      collapsed={collapsedSections.has('tts')}
      onToggleCollapse={() => toggleSection('tts')}
    />
  </>;
}
