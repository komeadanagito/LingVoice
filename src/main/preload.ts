import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron';
import type { DubbingProgress } from '../shared/dubbing';
import type { AsrProgress } from '../shared/asr';
import type { DownloadEvent, IpcContract, IpcResult, LingVoiceApi } from '../shared/contracts';

function invoke<K extends keyof IpcContract>(
  channel: K, ...args: IpcContract[K]['args']
): Promise<IpcResult<IpcContract[K]['result']>> {
  return ipcRenderer.invoke(channel, ...args);
}

const api: LingVoiceApi = {
  runtime: 'desktop',
  dubbingConfig: () => invoke('dubbing:config'),
  saveDubbingConfig: settings => invoke('dubbing:save', settings),
  checkDubbing: () => invoke('dubbing:check'),
  runDubbing: request => invoke('dubbing:run', request),
  cancelDubbing: jobId => invoke('dubbing:cancel', jobId),
  clearDubbingCache: () => invoke('dubbing:clear'),
  deleteDubbingVoice: voiceId => invoke('dubbing:deleteVoice', voiceId),
  onDubbingProgress: callback => {
    const listener = (_event: IpcRendererEvent, data: DubbingProgress): void => callback(data);
    ipcRenderer.on('dubbing:progress', listener);
    return () => ipcRenderer.removeListener('dubbing:progress', listener);
  },
  providers: () => invoke('providers:list'),
  saveProvider: update => invoke('providers:save', update),
  providerModels: id => invoke('providers:models', id),
  ttsConfig: () => invoke('tts:config'),
  saveTtsConfig: update => invoke('tts:save', update),
  generateSpeech: request => invoke('tts:generate', request),
  cancelTts: () => invoke('tts:cancel'),
  removeProvider: id => invoke('providers:remove', id),
  localFilePath: file => webUtils.getPathForFile(file),
  asrConfig: () => invoke('asr:config'),
  saveAsrConfig: update => invoke('asr:save', update),
  transcribe: request => invoke('asr:run', request),
  cancelAsr: () => invoke('asr:cancel'),
  testAsr: () => invoke('asr:test'),
  onAsrProgress: callback => {
    const listener = (_event: IpcRendererEvent, data: AsrProgress): void => callback(data);
    ipcRenderer.on('asr:progress', listener);
    return () => { ipcRenderer.removeListener('asr:progress', listener); };
  },
  translationConfig: () => invoke('translation:config'),
  saveTranslationConfig: update => invoke('translation:save', update),
  translationModels: () => invoke('translation:models'),
  translateSubtitles: request => invoke('translation:run', request),
  state: () => invoke('app:state'),
  setLocale: locale => invoke('app:locale', locale),
  chooseFolder: () => invoke('folder:choose'),
  openFolder: () => invoke('folder:open'),
  chooseCookies: () => invoke('cookies:choose'),
  clearCookies: () => invoke('cookies:clear'),
  inspect: url => invoke('video:inspect', url),
  download: options => invoke('video:download', options),
  cancel: () => invoke('video:cancel'),
  reveal: () => invoke('video:reveal'),
  onEvent: callback => {
    const listener = (_event: IpcRendererEvent, data: DownloadEvent): void => callback(data);
    ipcRenderer.on('download:event', listener);
    return () => { ipcRenderer.removeListener('download:event', listener); };
  },
};
contextBridge.exposeInMainWorld('lingvoice', api);
