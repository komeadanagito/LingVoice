import { useCallback, useEffect, useRef, useState } from 'react';
import { defaultTranslationSettings, type TranslationSettings } from '../../shared/translation';
import { defaultAsrSettings, type AsrSettings } from '../../shared/asr';
import { DEFAULT_TTS_BASE_URL, defaultTtsSettings } from '../../shared/tts';
import type {
  LocalEngineDownloadTarget,
  LocalModelDownloadProgress,
  LocalModelsStatus,
  ModelDownloadSource,
} from '../../shared/local-models';
import { Select } from './Select';
import { TtsSettingsCard } from './TtsSettingsCard';
import { languageOptions, normalizeLanguageSelection } from '../utils/languages';
import { useI18n } from '../i18n';

type Feedback = { error: boolean; text: string } | null;

function Result({ value, className = '' }: { value: Feedback; className?: string }) {
  return value ? (
    <p className={`${value.error ? 'settings-error' : 'settings-notice'} ${className}`} role={value.error ? 'alert' : 'status'}>
      {value.text}
    </p>
  ) : null;
}

function ChevronIcon() {
  return (
    <svg className="section-chevron" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

/** Local-only settings view: clean engine status + model downloads (ModelScope/HF) + simple language/separation controls. */
export function ServicesSettings() {
  const { locale } = useI18n();
  const zh = locale === 'zh-CN';
  const [translation, setTranslation] = useState<TranslationSettings>({ ...defaultTranslationSettings, mode: 'local' });
  const [asr, setAsr] = useState<AsrSettings>({ ...defaultAsrSettings, mode: 'local' });
  const [localStatus, setLocalStatus] = useState<LocalModelsStatus | null>(null);
  const [downloadSource, setDownloadSource] = useState<ModelDownloadSource>('modelscope');
  const [downloadProgress, setDownloadProgress] = useState<LocalModelDownloadProgress | null>(null);
  const [builtinSeparationReady, setBuiltinSeparationReady] = useState(false);
  const [localFeedback, setLocalFeedback] = useState<Feedback>(null);
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(() => new Set());
  const [busy, setBusy] = useState(false);
  const actionRunning = useRef(false);
  const wasDownloading = useRef(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const [translationFeedback, setTranslationFeedback] = useState<Feedback>(null);
  const [asrFeedback, setAsrFeedback] = useState<Feedback>(null);
  const [testingTranslation, setTestingTranslation] = useState(false);
  const [testingAsr, setTestingAsr] = useState(false);

  const toggleSection = (id: string) => {
    setCollapsedSections(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const refreshLocalStatus = useCallback(async () => {
    const [statusRes, dubCheck] = await Promise.all([
      window.lingvoice.localModelsStatus?.() ?? Promise.resolve(null),
      window.lingvoice.checkDubbing?.() ?? Promise.resolve(null),
    ]);
    if (statusRes && statusRes.ok) {
      setLocalStatus(statusRes.data);
      if (statusRes.data.download && (statusRes.data.download.active || statusRes.data.download.stage !== 'idle')) {
        setDownloadProgress(statusRes.data.download);
        wasDownloading.current = statusRes.data.download.active;
      }
    }
    if (dubCheck && dubCheck.ok) {
      setBuiltinSeparationReady(Boolean(dubCheck.data.ready || dubCheck.data.builtinSeparationReady));
    }
  }, []);

  useEffect(() => {
    const unsubscribe = window.lingvoice.onLocalModelsDownloadProgress?.(progress => {
      setDownloadProgress(progress);
      if (progress.active) {
        wasDownloading.current = true;
      } else if (wasDownloading.current) {
        wasDownloading.current = false;
        void refreshLocalStatus();
      }
    });
    return () => { unsubscribe?.(); };
  }, [refreshLocalStatus]);

  // Recover progress when an SSE notification is missed or the page reconnects.
  useEffect(() => {
    if (!downloadProgress?.active) return;
    const timer = window.setInterval(() => { void refreshLocalStatus().catch(() => {}); }, 5000);
    return () => window.clearInterval(timer);
  }, [downloadProgress?.active, refreshLocalStatus]);

  useEffect(() => {
    let live = true;
    void Promise.all([
      window.lingvoice.translationConfig(),
      window.lingvoice.asrConfig(),
      window.lingvoice.ttsConfig(),
      window.lingvoice.localModelsStatus?.() ?? Promise.resolve(null),
      window.lingvoice.checkDubbing?.() ?? Promise.resolve(null),
    ]).then(async ([trans, speech, tts, local, dubCheck]) => {
      if (!live) return;
      if (!trans.ok) throw new Error(trans.error);
      if (!speech.ok) throw new Error(speech.error);

      const normalizedTranslation: TranslationSettings = {
        ...trans.data.settings,
        mode: 'local',
        targetLanguage: normalizeLanguageSelection(trans.data.settings.targetLanguage, 'zh'),
        sourceLanguage: normalizeLanguageSelection(trans.data.settings.sourceLanguage, 'auto'),
      };
      const normalizedAsr: AsrSettings = {
        ...speech.data.settings,
        mode: 'local',
        prompt: '',
        language: normalizeLanguageSelection(speech.data.settings.language, ''),
      };

      setTranslation(normalizedTranslation);
      setAsr(normalizedAsr);
      if (local && local.ok) {
        setLocalStatus(local.data);
        if (local.data.download && (local.data.download.active || local.data.download.stage !== 'idle')) {
          setDownloadProgress(local.data.download);
          wasDownloading.current = local.data.download.active;
        }
      }
      if (dubCheck && dubCheck.ok) {
        setBuiltinSeparationReady(Boolean(dubCheck.data.ready || dubCheck.data.builtinSeparationReady));
      }

      if (trans.data.settings.mode !== 'local') {
        void window.lingvoice.saveTranslationConfig({ settings: normalizedTranslation }).catch(() => {});
      }
      if (speech.data.settings.mode !== 'local') {
        void window.lingvoice.saveAsrConfig({ settings: { ...normalizedAsr, fullUrl: false, prompt: '' } }).catch(() => {});
      }
      if (tts.ok && tts.data.settings.mode !== 'local') {
        void window.lingvoice.saveTtsConfig({
          settings: {
            ...defaultTtsSettings,
            ...tts.data.settings,
            mode: 'local',
            providerId: '',
            baseUrl: tts.data.settings.baseUrl || DEFAULT_TTS_BASE_URL,
          },
        }).catch(() => {});
      }
      setLoaded(true);
    }).catch(err => {
      if (live) setError(err instanceof Error ? err.message : String(err));
    });
    return () => { live = false; };
  }, []);

  async function saveTranslation(overrideSettings?: TranslationSettings) {
    const active = overrideSettings ?? translation;
    const payload = {
      settings: {
        ...active,
        mode: 'local' as const,
        baseUrl: active.baseUrl.trim() || defaultTranslationSettings.baseUrl,
        machineUrl: active.machineUrl.trim() || defaultTranslationSettings.machineUrl,
        model: active.model.trim() || defaultTranslationSettings.model,
      },
    };
    const result = await window.lingvoice.saveTranslationConfig(payload);
    if (!result.ok) throw new Error(result.error);
    setTranslation({ ...result.data.settings, mode: 'local' });
  }

  async function runTranslation(test: boolean) {
    if (actionRunning.current) return;
    actionRunning.current = true;
    setBusy(true);
    setTestingTranslation(test);
    setTranslationFeedback(null);
    try {
      await saveTranslation();
      if (test) {
        const result = await window.lingvoice.translateSubtitles({ texts: ['Hello, welcome to LingVoice.'] });
        if (!result.ok) throw new Error(result.error);
        setTranslationFeedback({ error: false, text: zh ? `测试通过：${result.data[0]}` : `Passed: ${result.data[0]}` });
        void refreshLocalStatus();
      } else {
        setTranslationFeedback({ error: false, text: zh ? '字幕翻译设置已保存' : 'Translation settings saved' });
      }
    } catch (err) {
      setTranslationFeedback({ error: true, text: err instanceof Error ? err.message : String(err) });
    } finally {
      actionRunning.current = false;
      setBusy(false);
      setTestingTranslation(false);
    }
  }

  async function saveAsrConfigPayload(overrideSettings?: AsrSettings) {
    const active = overrideSettings ?? asr;
    const payload = {
      settings: {
        ...active,
        mode: 'local' as const,
        fullUrl: false,
        prompt: '',
        baseUrl: active.baseUrl.trim() || defaultAsrSettings.baseUrl,
        model: active.model.trim() || defaultAsrSettings.model,
      },
    };
    const result = await window.lingvoice.saveAsrConfig(payload);
    if (!result.ok) throw new Error(result.error);
    setAsr({ ...result.data.settings, mode: 'local', prompt: '' });
  }

  async function runAsr(test: boolean) {
    if (actionRunning.current) return;
    actionRunning.current = true;
    setBusy(true);
    setTestingAsr(test);
    setAsrFeedback(null);
    try {
      await saveAsrConfigPayload();
      if (test) {
        const result = await window.lingvoice.testAsr();
        if (!result.ok) throw new Error(result.error);
        setAsrFeedback({
          error: false,
          text: zh ? '本地语音识别服务正常（Qwen3-ASR 已就绪）。' : 'Local Qwen3-ASR service is ready.',
        });
        void refreshLocalStatus();
      } else {
        setAsrFeedback({ error: false, text: zh ? '语音识别设置已保存' : 'ASR settings saved' });
      }
    } catch (err) {
      setAsrFeedback({ error: true, text: err instanceof Error ? err.message : String(err) });
    } finally {
      actionRunning.current = false;
      setBusy(false);
      setTestingAsr(false);
    }
  }

  async function stopLocalPlugins() {
    if (actionRunning.current || typeof window.lingvoice.stopLocalModels !== 'function') return;
    actionRunning.current = true;
    setBusy(true);
    setLocalFeedback(null);
    try {
      const res = await window.lingvoice.stopLocalModels();
      if (!res.ok) throw new Error(res.error);
      setLocalStatus(res.data);
      setLocalFeedback({
        error: false,
        text: zh ? '已停止运行中的本地模型并释放显存。' : 'Stopped active local plugins and freed GPU memory.',
      });
    } catch (err) {
      setLocalFeedback({ error: true, text: err instanceof Error ? err.message : String(err) });
    } finally {
      actionRunning.current = false;
      setBusy(false);
    }
  }

  async function startModelDownload(target: LocalEngineDownloadTarget) {
    if (typeof window.lingvoice.downloadLocalModels !== 'function' || downloadProgress?.active) return;
    setLocalFeedback(null);
    try {
      const res = await window.lingvoice.downloadLocalModels({ target, source: downloadSource });
      if (!res.ok) throw new Error(res.error);
      setLocalStatus(res.data);
      if (res.data.download) {
        setDownloadProgress(res.data.download);
        wasDownloading.current = res.data.download.active;
      }
    } catch (err) {
      setLocalFeedback({ error: true, text: err instanceof Error ? err.message : String(err) });
    }
  }

  async function cancelModelDownload() {
    if (typeof window.lingvoice.cancelLocalModelsDownload !== 'function') return;
    try {
      const res = await window.lingvoice.cancelLocalModelsDownload();
      if (!res.ok) throw new Error(res.error);
      setLocalStatus(res.data);
      if (res.data.download) setDownloadProgress(res.data.download);
      wasDownloading.current = false;
    } catch (err) {
      setLocalFeedback({ error: true, text: err instanceof Error ? err.message : String(err) });
    }
  }

  const isDownloading = Boolean(downloadProgress?.active);
  const downloadSupported = typeof window.lingvoice.downloadLocalModels === 'function';

  const engineCards = [
    {
      id: 'asr' as const,
      title: zh ? '语音识别 (ASR)' : 'Speech Recognition',
      model: localStatus?.services.asr?.modelLabel || 'Qwen3-ASR-1.7B + ForcedAligner-0.6B',
      ready: !!localStatus?.services.asr?.installed && !!localStatus?.services.asr?.weightsReady,
      running: !!localStatus?.services.asr?.running,
      healthy: !!localStatus?.services.asr?.healthy,
    },
    {
      id: 'translation' as const,
      title: zh ? '字幕翻译' : 'Subtitle Translation',
      model: localStatus?.services.translation?.modelLabel || 'Gemma 4 E2B (NF4 4-bit)',
      ready: !!localStatus?.services.translation?.installed && !!localStatus?.services.translation?.weightsReady,
      running: !!localStatus?.services.translation?.running,
      healthy: !!localStatus?.services.translation?.healthy,
    },
    {
      id: 'voice-clone' as const,
      title: zh ? '声音克隆与配音' : 'Voice Cloning & Dubbing',
      model: localStatus?.services['voice-clone']?.modelLabel || 'GPT-SoVITS V5 (v5turbo)',
      ready: !!localStatus?.services['voice-clone']?.installed && !!localStatus?.services['voice-clone']?.weightsReady,
      running: !!localStatus?.services['voice-clone']?.running,
      healthy: !!localStatus?.services['voice-clone']?.healthy,
    },
    {
      id: 'separation' as const,
      title: zh ? '人声与 BGM 分离' : 'Vocal & BGM Separation',
      model: 'Karaoke BS-RoFormer (2.1 GB VRAM)',
      ready: builtinSeparationReady,
      running: false,
      healthy: false,
    },
  ];
  const readyCount = engineCards.filter(c => c.ready).length;

  return (
    <>
      <section className={`settings-section local-models-section${collapsedSections.has('local') ? ' is-collapsed' : ''}`} aria-labelledby="local-models-title">
        <div className="settings-section-heading">
          <button
            type="button"
            className="settings-section-header"
            onClick={() => toggleSection('local')}
            aria-expanded={!collapsedSections.has('local')}
            aria-controls="local-models-section-body"
          >
            <div className="settings-section-title-row">
              <h3 id="local-models-title">{zh ? '本地 AI 引擎状态' : 'Local AI Engines'}</h3>
              <span className={`local-pill${readyCount === engineCards.length ? ' is-ready' : ' is-warn'}`}>
                {zh ? `${readyCount}/${engineCards.length} 已就绪` : `${readyCount}/${engineCards.length} ready`}
              </span>
            </div>
            <ChevronIcon />
          </button>
        </div>
        <div id="local-models-section-body" className="settings-section-body">
          <div className="local-download-toolbar">
            <div className="local-download-source">
              <span className="mode-switch-label">{zh ? '模型下载源' : 'Download source'}</span>
              <div className="mode-switch-group" role="group" aria-label={zh ? '模型下载源' : 'Model download source'}>
                <button
                  type="button"
                  className={`mode-switch-btn${downloadSource === 'modelscope' ? ' is-active' : ''}`}
                  disabled={isDownloading}
                  onClick={() => setDownloadSource('modelscope')}
                >
                  {zh ? '魔搭社区' : 'ModelScope'}
                </button>
                <button
                  type="button"
                  className={`mode-switch-btn${downloadSource === 'huggingface' ? ' is-active' : ''}`}
                  disabled={isDownloading}
                  onClick={() => setDownloadSource('huggingface')}
                >
                  Hugging Face
                </button>
              </div>
            </div>
            {downloadSupported && (
              <div className="local-download-actions">
                <button
                  type="button"
                  className={readyCount < engineCards.length ? 'primary' : 'choose-file-button'}
                  disabled={!loaded || busy || isDownloading}
                  onClick={() => void startModelDownload('all')}
                >
                  {isDownloading
                    ? (zh ? '下载中…' : 'Downloading…')
                    : readyCount < engineCards.length
                      ? (zh ? '一键下载全部模型' : 'Download all models')
                      : (zh ? '校验 / 补全全部模型' : 'Verify / download all')}
                </button>
                {isDownloading && (
                  <button type="button" className="cancel-button" onClick={() => void cancelModelDownload()}>
                    {zh ? '取消下载' : 'Cancel download'}
                  </button>
                )}
              </div>
            )}
          </div>

          {downloadProgress && (downloadProgress.active || downloadProgress.stage === 'complete' || downloadProgress.error || downloadProgress.stage === 'cancelled') && (
            <div
              className={`local-download-status${downloadProgress.error ? ' is-error' : downloadProgress.stage === 'complete' ? ' is-done' : ''}`}
              role={downloadProgress.error ? 'alert' : 'status'}
            >
              <div className="local-download-status-row">
                <span>{downloadProgress.message}</span>
                {downloadProgress.percent !== null && (
                  <span className="local-download-percent">{downloadProgress.percent}%</span>
                )}
              </div>
              {downloadProgress.active && (
                <div className="local-download-bar" aria-hidden="true">
                  <div className="local-download-bar-fill" style={{ width: `${downloadProgress.percent ?? 15}%` }} />
                </div>
              )}
            </div>
          )}

          <div className="local-engines-grid">
            {engineCards.map(card => (
              <div key={card.id} className="local-engine-card">
                <div className="local-engine-head">
                  <strong>{card.title}</strong>
                  <div className="local-model-meta">
                    <span className={`local-pill${card.ready ? ' is-ready' : localStatus ? ' is-warn' : ''}`}>
                      {!localStatus ? (zh ? '检测中…' : 'Checking…') : card.ready ? (zh ? '已就绪' : 'Ready') : (zh ? '未就绪' : 'Not ready')}
                    </span>
                    {card.running && (
                      <span className="local-pill is-running">
                        {card.healthy ? (zh ? '运行中' : 'Running') : (zh ? '启动中' : 'Starting')}
                      </span>
                    )}
                  </div>
                </div>
                <span className="local-engine-model">{card.model}</span>
                {downloadSupported && (
                  <div className="local-engine-actions">
                    <button
                      type="button"
                      className={card.ready ? 'text-button' : 'choose-file-button'}
                      disabled={!loaded || busy || isDownloading}
                      onClick={() => void startModelDownload(card.id)}
                    >
                      {card.ready
                        ? (zh ? '重新校验 / 下载' : 'Verify / redownload')
                        : (zh ? '下载模型' : 'Download model')}
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
          <div className="settings-actions" style={{ marginTop: 14 }}>
            <button type="button" className="choose-file-button" disabled={!loaded || busy} onClick={() => void refreshLocalStatus()}>
              {zh ? '刷新引擎状态' : 'Refresh status'}
            </button>
            {localStatus?.activeService && (
              <button type="button" className="cancel-button" disabled={busy} onClick={() => void stopLocalPlugins()}>
                {zh ? '停止当前模型并释放显存' : 'Stop active model & free VRAM'}
              </button>
            )}
          </div>
          <Result value={localFeedback} className="local-models-feedback" />
        </div>
      </section>

      {error && <p className="settings-error services-feedback" role="alert">{error}</p>}

      <div className="settings-cards-grid">
        <section className={`settings-section asr-section${collapsedSections.has('asr') ? ' is-collapsed' : ''}`} aria-labelledby="asr-settings-title">
          <div className="settings-section-heading">
            <button
              type="button"
              className="settings-section-header"
              onClick={() => toggleSection('asr')}
              aria-expanded={!collapsedSections.has('asr')}
              aria-controls="asr-section-body"
            >
              <div className="settings-section-title-row">
                <h3 id="asr-settings-title">{zh ? '语音识别 (ASR)' : 'Speech Recognition (ASR)'}</h3>
                <span className="local-pill is-ready">Qwen3-ASR</span>
              </div>
              <ChevronIcon />
            </button>
          </div>
          <div id="asr-section-body" className="settings-section-body">
            <fieldset disabled={!loaded || busy} className="translation-fields">
              <p className="settings-hint" style={{ marginTop: 0 }}>
                {zh ? '识别视频中说话人的语音，生成带时间轴的原文字幕。' : 'Transcribes spoken audio from the video into timed subtitles.'}
              </p>
              <div className="settings-form-single">
                <label>
                  {zh ? '视频原声语言' : 'Spoken audio language'}
                  <Select
                    id="asr-language"
                    value={asr.language}
                    options={languageOptions(zh, '', asr.language)}
                    onChange={language => setAsr(previous => ({ ...previous, language }))}
                  />
                </label>
              </div>
              <div className="settings-actions">
                <button className="primary asr-save" type="button" onClick={() => void runAsr(false)}>
                  {zh ? '保存识别设置' : 'Save ASR settings'}
                </button>
                <button className="choose-file-button asr-test" type="button" onClick={() => void runAsr(true)}>
                  {testingAsr ? (zh ? '检测中…' : 'Checking…') : (zh ? '检测识别服务' : 'Test local ASR')}
                </button>
              </div>
            </fieldset>
            <Result value={asrFeedback} className="asr-feedback" />
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
              <div className="settings-section-title-row">
                <h3 id="translation-settings-title">{zh ? '字幕翻译' : 'Subtitle Translation'}</h3>
                <span className="local-pill is-ready">Gemma 4 E2B</span>
              </div>
              <ChevronIcon />
            </button>
          </div>
          <div id="translation-section-body" className="settings-section-body">
            <fieldset disabled={!loaded || busy} className="translation-fields">
              <p className="settings-hint" style={{ marginTop: 0 }}>
                {zh ? '结合上下文与术语记忆翻译字幕，并自动控制句长以便后续配音对齐。' : 'Translates subtitles with context memory and pacing for dubbing alignment.'}
              </p>
              <div className="settings-form-grid">
                <label>
                  {zh ? '原文语言' : 'Source language'}
                  <Select
                    id="translation-source-language"
                    value={translation.sourceLanguage}
                    options={languageOptions(zh, 'auto', translation.sourceLanguage)}
                    onChange={sourceLanguage => setTranslation(previous => ({ ...previous, sourceLanguage }))}
                  />
                </label>
                <label>
                  {zh ? '翻译目标语言' : 'Target language'}
                  <Select
                    id="translation-target-language"
                    value={translation.targetLanguage}
                    options={languageOptions(zh, 'auto', translation.targetLanguage, false)}
                    onChange={targetLanguage => setTranslation(previous => ({ ...previous, targetLanguage }))}
                  />
                </label>
              </div>
              <div className="settings-actions">
                <button className="primary translation-save" type="button" onClick={() => void runTranslation(false)}>
                  {zh ? '保存翻译设置' : 'Save translation'}
                </button>
                <button className="choose-file-button translation-test" type="button" onClick={() => void runTranslation(true)}>
                  {testingTranslation ? (zh ? '测试中…' : 'Testing…') : (zh ? '测试翻译效果' : 'Test local translation')}
                </button>
              </div>
            </fieldset>
            <Result value={translationFeedback} className="translation-test-feedback" />
          </div>
        </section>
      </div>

      <TtsSettingsCard
        disabled={!loaded || busy}
        collapsed={collapsedSections.has('tts')}
        onToggleCollapse={() => toggleSection('tts')}
        builtinSeparationReady={builtinSeparationReady}
      />
    </>
  );
}
