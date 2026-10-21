// Development-only browser bridge to the local Vite backend; no simulated downloads.
import type { DownloadEvent, IpcResult, LingVoiceApi } from '../shared/contracts';
import { isLocale } from '../shared/i18n/catalog';

async function request<T>(route: string, data: object = {}, signal?: AbortSignal): Promise<IpcResult<T>> {
  try {
    const response = await fetch(`/api/lingvoice/${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data), signal });
    return await response.json() as IpcResult<T>;
  } catch {
    if (signal?.aborted) return { ok: false, error: 'Task cancelled.' };
    return { ok: false, error: 'Local Web service is unavailable. Restart npm run web.', errorKey: 'errors.webService' };
  }
}

export function installWebMock(): void {
  let localMedia: { reference: string; file: File } | undefined;
  let asrController: AbortController | undefined;
  let dubbingTask: { jobId: string; controller: AbortController } | undefined;
  const api: LingVoiceApi = {
    dubbingConfig: () => request('dubbing-config'),
    saveDubbingConfig: settings => request('dubbing-save', settings),
    checkDubbing: () => request('dubbing-check'),
    clearDubbingCache: () => request('dubbing-clear'),
    deleteDubbingVoice: voiceId => request('dubbing-delete-voice', { voiceId }),
    runDubbing: async payload => {
      if (dubbingTask) return { ok: false, error: 'Dubbing is already busy.' };
      const task = { jobId: payload.jobId, controller: new AbortController() };
      dubbingTask = task;
      let uploaded = '';
      try {
        let reference = payload.file;
        if (reference.startsWith('browser-file:')) {
          if (!localMedia || localMedia.reference !== reference) throw new Error('Select the local media file again.');
          if (!localMedia.file.size || localMedia.file.size > 512 * 1024 * 1024) throw new Error('Select a media file between 1 byte and 512 MB.');
          const response = await fetch('/api/lingvoice/asr-upload', {
            method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: localMedia.file, signal: task.controller.signal,
          });
          const result = await response.json() as IpcResult<{ file: string }>;
          if (!result.ok) return result;
          uploaded = reference = result.data.file;
        }
        if (task.controller.signal.aborted) throw new Error('Dubbing cancelled.');
        return await request('dubbing-run', { ...payload, file: reference }, task.controller.signal);
      } catch (error) {
        return { ok: false, error: task.controller.signal.aborted ? 'Dubbing cancelled.' : error instanceof Error ? error.message : 'Media upload failed.' };
      } finally {
        if (uploaded) await request('asr-upload-remove', { file: uploaded });
        if (dubbingTask === task) dubbingTask = undefined;
      }
    },
    cancelDubbing: jobId => {
      if (dubbingTask?.jobId === jobId) dubbingTask.controller.abort();
      return request('dubbing-cancel', { jobId });
    },
    onDubbingProgress: callback => {
      const events = new EventSource('/api/lingvoice/events');
      events.addEventListener('dubbing-progress', event => {
        try { callback(JSON.parse((event as MessageEvent<string>).data)); } catch { /* Ignore incomplete events. */ }
      });
      return () => events.close();
    },
    runtime: 'browser',
    providers: () => request('providers'),
    saveProvider: update => request('provider-save', update),
    providerModels: id => request('provider-models', { id }),
    ttsConfig: () => request('tts-config'),
    saveTtsConfig: update => request('tts-save', update),
    generateSpeech: payload => request('tts-generate', payload),
    cancelTts: () => request('tts-cancel'),
    removeProvider: id => request('provider-remove', { id }),
    localFilePath: file => {
      localMedia = { reference: `browser-file:${crypto.randomUUID()}`, file };
      return localMedia.reference;
    },
    asrConfig: () => request('asr-config'),
    saveAsrConfig: update => request('asr-save', update),
    transcribe: async payload => {
      if (asrController) return { ok: false, error: 'ASR is already busy.' };
      const controller = new AbortController();
      asrController = controller;
      let uploaded = '';
      try {
        let reference = payload.file;
        if (reference.startsWith('browser-file:')) {
          if (!localMedia || localMedia.reference !== reference) return { ok: false, error: 'Select the local media file again.' };
          const file = localMedia.file;
          if (!file.size || file.size > 512 * 1024 * 1024) return { ok: false, error: 'Select a media file between 1 byte and 512 MB.' };
          const response = await fetch('/api/lingvoice/asr-upload', {
            method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file, signal: controller.signal,
          });
          const result = await response.json() as IpcResult<{ file: string }>;
          if (!result.ok) return result;
          uploaded = reference = result.data.file;
        }
        if (controller.signal.aborted) return { ok: false, error: 'ASR cancelled.' };
        return await request('asr-run', { file: reference }, controller.signal);
      } catch {
        return { ok: false, error: controller.signal.aborted ? 'ASR cancelled.' : 'Media upload failed. Check the local Web service and try again.' };
      } finally {
        if (uploaded) await request('asr-upload-remove', { file: uploaded });
        if (asrController === controller) asrController = undefined;
      }
    },
    cancelAsr: () => {
      asrController?.abort();
      return request('asr-cancel');
    },
    testAsr: () => request('asr-test'),
    onAsrProgress: callback => {
      const events = new EventSource('/api/lingvoice/events');
      events.addEventListener('asr-progress', event => {
        try { callback(JSON.parse((event as MessageEvent<string>).data)); } catch { /* Ignore incomplete events. */ }
      });
      return () => events.close();
    },
    translationConfig: () => request('translation-config'),
    saveTranslationConfig: update => request('translation-save', update),
    translationModels: () => request('translation-models'),
    translateSubtitles: payload => request('translation-run', payload),
    state: async () => {
      const result = await request<import('../shared/contracts').AppState>('state');
      const locale = localStorage.getItem('lingvoice.locale');
      if (result.ok && isLocale(locale)) result.data.locale = locale;
      return result;
    },
    setLocale: async locale => {
      const result = await request<typeof locale>('locale', { locale });
      if (result.ok) localStorage.setItem('lingvoice.locale', result.data);
      return result;
    },
    inspect: url => request('inspect', { url }),
    download: options => request('download', options),
    cancel: () => request('cancel'),
    reveal: async () => {
      const result = await request<string>('reveal');
      if (!result.ok) return result;
      if (result.data) {
        const link = document.createElement('a');
        link.href = result.data;
        link.download = 'LingVoice.mp4';
        link.click();
      }
      return { ok: true, data: undefined };
    },
    chooseFolder: () => request('choose-folder'),
    openFolder: () => request('open-folder'),
    chooseCookies: () => request('choose-cookies'),
    clearCookies: () => request('clear-cookies'),
    onEvent: callback => {
      const events = new EventSource('/api/lingvoice/events');
      events.onmessage = event => {
        try { callback(JSON.parse(event.data) as DownloadEvent); } catch { /* Ignore incomplete events. */ }
      };
      return () => events.close();
    },
  };
  window.lingvoice = api;
}
