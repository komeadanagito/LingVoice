import { app, BrowserWindow, ipcMain, dialog, shell, protocol, safeStorage } from 'electron';
import { TranslationService } from './translation';
import { TtsService } from './tts';
import { DubbingService } from './dubbing';
import { AsrService } from './asr';
import { ProviderService } from './providers';
import { mediaResponse } from './media';
import path from 'node:path';
import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import ffmpegStatic from 'ffmpeg-static';
import { Downloader } from './downloader';
import { Settings } from './settings';
import { errorText, type IpcContract, type IpcResult } from '../shared/contracts';
import { devServerUrl } from '../shared/dev-server';
import { defaultLocale, isLocale, resolveLocale, type Locale, type MessageKey } from '../shared/i18n/catalog';
import { LocalizedError, translate } from '../shared/i18n/translate';

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'media',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      bypassCSP: true,
      stream: true,
    },
  },
]);

export function getVideoDirectory(): string {
  const baseDir = app.isPackaged ? path.dirname(process.execPath) : process.cwd();
  return path.resolve(baseDir, 'video');
}

let window: BrowserWindow | undefined;
let downloader: Downloader | undefined;
let ttsService: TtsService | undefined;
let dubbingService: DubbingService | undefined;
let asrService: AsrService | undefined;
let settings: Settings | undefined;
let systemLocale: Locale = defaultLocale;
let cookieFile = '';
let lastFile = '';
const rendererFile = path.resolve(__dirname, '../../renderer/index.html');
const devUrl = !app.isPackaged && process.env.LINGVOICE_DEV === '1' ? devServerUrl : undefined;
const pageUrl = devUrl ?? pathToFileURL(rendererFile).href;
const locale = (): Locale => settings?.current.locale ?? systemLocale;
const t = (key: MessageKey): string => translate(locale(), key);
const message = (error: unknown): string => error instanceof LocalizedError
  ? translate(locale(), error.key, error.values)
  : error ? errorText(error) : t('errors.generic');

function handle<K extends keyof IpcContract>(
  name: K,
  action: (...args: IpcContract[K]['args']) => IpcContract[K]['result'] | Promise<IpcContract[K]['result']>,
): void {
  ipcMain.handle(name, async (event, ...args: unknown[]): Promise<IpcResult<IpcContract[K]['result']>> => {
    try {
      if (!window || event.sender !== window.webContents || event.senderFrame?.url !== pageUrl) {
        throw new LocalizedError('errors.source');
      }
      return { ok: true, data: await action(...args as IpcContract[K]['args']) };
    } catch (error) {
      return error instanceof LocalizedError
        ? { ok: false, error: message(error), errorKey: error.key, errorValues: error.values }
        : { ok: false, error: message(error) };
    }
  });
}

async function createWindow(): Promise<void> {
  systemLocale = resolveLocale(app.getLocale());
  const defaultFolder = getVideoDirectory();
  await fs.mkdir(defaultFolder, { recursive: true });
  const preferences = await Settings.load(path.join(app.getPath('userData'), 'settings.json'), {
    folder: defaultFolder, locale: systemLocale,
  });
  if (preferences.current.folder !== defaultFolder) {
    await preferences.update({ folder: defaultFolder });
  }
  settings = preferences;
  if (!ffmpegStatic) throw new LocalizedError('errors.ffmpegMissing');
  const ffmpegPath = app.isPackaged ? ffmpegStatic.replace('app.asar', 'app.asar.unpacked') : ffmpegStatic;
  const manager = new Downloader({
    dataDir: app.getPath('userData'), ffmpegPath,
    emit: event => { if (window && !window.isDestroyed()) window.webContents.send('download:event', event); },
  });
  downloader = manager;
  const mainWindow = new BrowserWindow({
    width: 1130, height: 850, minWidth: 640, minHeight: 480,
    title: t('app.title'), backgroundColor: '#f6f8f7', autoHideMenuBar: true,
    icon: path.resolve(__dirname, '../../../icon/lingvoice-logo.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: true,
    },
  });
  window = mainWindow;
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', event => event.preventDefault());

  if (!protocol.isProtocolHandled('media')) {
    protocol.handle('media', mediaResponse);
  }

  const vault = {
    encrypt: (value: string) => {
      if (!safeStorage.isEncryptionAvailable()) throw new Error('系统安全存储不可用，无法保存密钥。');
      return safeStorage.encryptString(value).toString('base64');
    },
    decrypt: (value: string) => safeStorage.decryptString(Buffer.from(value, 'base64')),
  };
  const providers = new ProviderService(path.join(app.getPath('userData'), 'providers.json'), vault);
  await providers.importLegacy({ translation: path.join(app.getPath('userData'), 'translation.json'), asr: path.join(app.getPath('userData'), 'asr.json') });
  handle('providers:list', () => providers.list());
  handle('providers:save', async update => {
    if (update?.id) {
      const [catalog, translationConfig, asrConfig, ttsConfig] = await Promise.all([providers.list(), translation.getConfig(), asr.getConfig(), tts.getConfig()]);
      const adapter = catalog.adapters.find(adapter => adapter.id === update.adapter);
      if (translationConfig.settings.providerId === update.id && !adapter?.capabilities.includes('translation')) throw new Error('该 Provider 正被字幕翻译使用，需要支持翻译能力。 / Provider is bound to translation.');
      if (ttsConfig.settings.providerId === update.id && !adapter?.capabilities.includes('tts')) throw new Error('该 Provider 正被 TTS 使用，需要支持文字转语音能力。 / Provider is bound to TTS.');
      if (asrConfig.settings.providerId === update.id && !adapter?.capabilities.includes('asr')) throw new Error('该 Provider 正被 ASR 使用，需要支持语音识别能力。 / Provider is bound to ASR.');
    }
    return providers.save(update);
  });
  handle('providers:remove', async id => {
    const [translationConfig, asrConfig, ttsConfig] = await Promise.all([translation.getConfig(), asr.getConfig(), tts.getConfig()]);
    if (translationConfig.settings.providerId === id || asrConfig.settings.providerId === id || ttsConfig.settings.providerId === id) throw new Error('该 Provider 正在被使用，请先修改翻译/ASR/TTS 绑定。 / Provider is in use. Change task bindings first.');
    await providers.remove(id);
  });
  const translation = new TranslationService(path.join(app.getPath('userData'), 'translation.json'), vault, providers);
  const tts = new TtsService(path.join(app.getPath('userData'), 'tts.json'), providers, vault);
  ttsService = tts;
  const dubbing = new DubbingService({
    directory: path.join(app.getPath('userData'), 'dubbing'), ffmpegPath,
    helperPath: app.isPackaged ? path.join(process.resourcesPath, 'audio-separation.py') : path.resolve(__dirname, '../../../scripts/audio-separation.py'),
    tts, translation,
    emit: progress => { if (!mainWindow.isDestroyed()) mainWindow.webContents.send('dubbing:progress', progress); },
  });
  dubbingService = dubbing;
  handle('dubbing:config', () => dubbing.getConfig());
  handle('dubbing:save', settings => dubbing.saveConfig(settings));
  handle('dubbing:check', () => dubbing.check());
  handle('dubbing:run', request => dubbing.run(request));
  handle('dubbing:cancel', jobId => { if (typeof jobId !== 'string') throw new Error('Invalid dubbing job.'); dubbing.cancel(jobId); });
  handle('dubbing:clear', () => dubbing.clearCache());
  handle('dubbing:deleteVoice', voiceId => dubbing.deleteVoice(voiceId));
  const asr = new AsrService(path.join(app.getPath('userData'), 'asr.json'), vault, ffmpegPath, progress => {
    if (!mainWindow.isDestroyed()) mainWindow.webContents.send('asr:progress', progress);
  }, {}, providers);
  asrService = asr;
  handle('asr:config', () => asr.getConfig());
  handle('asr:save', update => asr.saveConfig(update));
  handle('asr:run', request => asr.transcribe(request));
  handle('asr:cancel', () => asr.cancel());
  handle('asr:test', () => asr.test());
  handle('providers:models', id => providers.models(id));
  handle('tts:config', () => tts.getConfig());
  handle('tts:save', update => tts.saveConfig(update));
  handle('tts:generate', request => tts.generate(request));
  handle('tts:cancel', () => tts.cancel());
  handle('translation:config', () => translation.getConfig());
  handle('translation:save', update => translation.saveConfig(update));
  handle('translation:models', () => translation.models());
  handle('translation:run', request => translation.translate(request));
  handle('app:state', () => ({ ...preferences.current, version: app.getVersion() }));
  handle('app:locale', async requested => {
    if (!isLocale(requested)) throw new LocalizedError('errors.locale');
    await preferences.update({ locale: requested });
    if (!mainWindow.isDestroyed()) mainWindow.setTitle(t('app.title'));
    return preferences.current.locale;
  });
  handle('folder:choose', async () => {
    if (manager.busy) throw new LocalizedError('errors.busyFolder');
    const result = await dialog.showOpenDialog(mainWindow, { title: t('dialog.folder'), defaultPath: preferences.current.folder, properties: ['openDirectory', 'createDirectory'] });
    if (!result.canceled && result.filePaths[0]) {
      await preferences.update({ folder: result.filePaths[0] });
    }
    return preferences.current.folder;
  });
  handle('folder:open', async () => {
    const folder = preferences.current.folder;
    await fs.mkdir(folder, { recursive: true });
    const error = await shell.openPath(folder);
    if (error) throw new Error(error);
  });
  handle('cookies:choose', async () => {
    if (manager.busy) throw new LocalizedError('errors.busyCookies');
    const result = await dialog.showOpenDialog(mainWindow, {
      title: t('dialog.cookies'), properties: ['openFile'],
      filters: [{ name: t('dialog.cookieFilter'), extensions: ['txt'] }],
    });
    if (!result.canceled && result.filePaths[0]) {
      const selected = result.filePaths[0];
      const stat = await fs.stat(selected);
      if (stat.size > 5 * 1024 * 1024) throw new LocalizedError('errors.cookieSize');
      const content = await fs.readFile(selected, 'utf8');
      if (!/^# (?:Netscape HTTP Cookie File|HTTP Cookie File)/m.test(content)) throw new LocalizedError('errors.cookieFormat');
      cookieFile = selected;
    }
    return cookieFile ? path.basename(cookieFile) : '';
  });
  handle('cookies:clear', () => {
    if (manager.busy) throw new LocalizedError('errors.wait');
    cookieFile = '';
  });
  handle('video:inspect', async url => {
    if (typeof url !== 'string' || url.length > 4096) throw new LocalizedError('errors.urlLength');
    return manager.inspect(url, cookieFile);
  });
  handle('video:download', async options => {
    if (!options || typeof options.url !== 'string' || options.url.length > 4096 || typeof options.height !== 'string') throw new LocalizedError('errors.downloadArgs');
    const folder = preferences.current.folder;
    await fs.mkdir(folder, { recursive: true });
    const result = await manager.download({ url: options.url, height: options.height, folder, cookieFile });
    lastFile = result.file;
    return result;
  });
  handle('video:cancel', () => manager.cancel());
  handle('video:reveal', () => { if (lastFile) shell.showItemInFolder(lastFile); });
  mainWindow.on('close', event => {
    if (!manager.busy && !asr.busy && !tts.busy && !dubbing.busy) return;
    const choice = dialog.showMessageBoxSync(mainWindow, {
      type: 'question', buttons: [t('dialog.keepRunning'), t('dialog.exit')], defaultId: 0, cancelId: 0,
      title: t('dialog.busyTitle'), message: t('dialog.exitMessage'),
      detail: t('dialog.exitDetail'),
    });
    if (choice === 0) event.preventDefault(); else { manager.cancel(); asr.cancel(); tts.cancel(); dubbing.cancel(); }
  });
  if (devUrl) await mainWindow.loadURL(devUrl);
  else await mainWindow.loadFile(rendererFile);
}

const lock = app.requestSingleInstanceLock();
if (!lock) app.quit();
else {
  app.on('second-instance', () => {
    if (window) { if (window.isMinimized()) window.restore(); window.focus(); }
  });
  app.whenReady().then(createWindow).catch((error: unknown) => {
    dialog.showErrorBox('启动失败', errorText(error));
    app.quit();
  });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', () => { downloader?.cancel(); asrService?.cancel(); ttsService?.cancel(); dubbingService?.cancel(); });
}
