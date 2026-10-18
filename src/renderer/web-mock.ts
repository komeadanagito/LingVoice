// Development-only browser bridge to the local Vite backend; no simulated downloads.
import type { DownloadEvent, IpcResult, LingVoiceApi } from '../shared/contracts';
import { isLocale } from '../shared/i18n/catalog';

async function request<T>(route: string, data: object = {}): Promise<IpcResult<T>> {
  try {
    const response = await fetch(`/api/lingvoice/${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    return await response.json() as IpcResult<T>;
  } catch {
    return { ok: false, error: 'Local download service is unavailable. Restart npm run web.', errorKey: 'errors.webService' };
  }
}

export function installWebMock(): void {
  const api: LingVoiceApi = {
    providers: () => request('providers'),
    saveProvider: update => request('provider-save', update),
    removeProvider: id => request('provider-remove', { id }),
    localFilePath: () => '',
    asrConfig: () => request('asr-config'),
    saveAsrConfig: update => request('asr-save', update),
    transcribe: payload => request('asr-run', payload),
    cancelAsr: () => request('asr-cancel'),
    onAsrProgress: () => () => {},
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
