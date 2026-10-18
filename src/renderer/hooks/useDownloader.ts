import { useEffect, useRef, useState } from 'react';
import type { DownloadProgress, IpcResult, VideoInfo } from '../../shared/contracts';
import { type DisplayMessage, type Locale, type MessageKey } from '../../shared/i18n/catalog';
import { i18n } from '../i18n';

class IpcFailure extends Error {
  constructor(readonly display: DisplayMessage, fallback: string) { super(fallback); }
}
export async function unwrap<T>(promise: Promise<IpcResult<T>>): Promise<T> {
  const result = await promise;
  if (!result.ok) throw new IpcFailure(result.errorKey
    ? { key: result.errorKey, values: result.errorValues } : { text: result.error }, result.error);
  return result.data;
}
function displayError(error: unknown): DisplayMessage {
  if (error instanceof IpcFailure) {
    return 'key' in error.display && !i18n.exists(error.display.key) ? { text: error.message } : error.display;
  }
  return error instanceof Error ? { text: error.message } : { key: 'errors.generic' };
}
interface TaskStatus { title: MessageKey; message: DisplayMessage }
const ready: TaskStatus = { title: 'status.readyTitle', message: { key: 'status.readyMessage' } };
type Phase = 'idle' | 'inspect' | 'download';

export function useDownloader() {
  const api = window.lingvoice;
  const [url, setUrl] = useState('');
  const [video, setVideo] = useState<VideoInfo | null>(null);
  const [parsedUrl, setParsedUrl] = useState('');
  const [quality, setQuality] = useState('best');
  const [folder, setFolder] = useState('');
  const [version, setVersion] = useState('0.1.0');
  const [cookieFile, setCookieFile] = useState('');
  const [initialized, setInitialized] = useState(false);
  const [savingLanguage, setSavingLanguage] = useState(false);
  const [phase, setPhase] = useState<Phase>('idle');
  const [cancelling, setCancelling] = useState(false);
  const [status, setStatus] = useState<TaskStatus>(ready);
  const [progress, setProgress] = useState<DownloadProgress | null>(null);
  const [completed, setCompleted] = useState(false);
  const [lastDownloadedFile, setLastDownloadedFile] = useState('');
  const [error, setError] = useState<DisplayMessage | null>(null);
  const busyRef = useRef(false);
  const savingLanguageRef = useRef(false);
  const cancellingRef = useRef(false);
  const busy = phase !== 'idle';

  useEffect(() => {
    let mounted = true;
    unwrap(api.state()).then(async state => {
      if (!mounted) return;
      await i18n.changeLanguage(state.locale);
      if (mounted) { setFolder(state.folder); setVersion(state.version); setInitialized(true); }
    }).catch((error: unknown) => {
      if (mounted) { setError(displayError(error)); setInitialized(true); }
    });
    const unsubscribe = api.onEvent(event => {
      if (!busyRef.current || cancellingRef.current) return;
      if (event.type === 'status') {
        if (/Merger|Fixup|VideoRemuxer/.test(event.message)) {
          setStatus({ title: 'status.mergeTitle', message: { key: 'status.mergeMessage' } });
        } else setStatus(previous => ({ ...previous, message: event.messageKey
          ? { key: event.messageKey, values: event.messageValues } : { text: event.message } }));
      } else {
        setProgress(event);
        setStatus(event.status === 'finished'
          ? { title: 'status.streamFinishedTitle', message: { key: 'status.streamFinishedMessage' } }
          : { title: 'status.transferTitle', message: event.filename ? { text: event.filename } : { key: 'status.transferMessage' } });
      }
    });
    return () => { mounted = false; unsubscribe(); };
  }, [api]);

  function invalidate(): void {
    setVideo(null); setParsedUrl(''); setQuality('best'); setCompleted(false);
    setProgress(null); setStatus(ready); setError(null);
  }
  function changeUrl(value: string): void { if (!busyRef.current) { setUrl(value); invalidate(); } }
  function start(next: Phase): void {
    busyRef.current = true; cancellingRef.current = false;
    setPhase(next); setCancelling(false); setError(null);
  }
  function finish(): void {
    busyRef.current = false; cancellingRef.current = false;
    setPhase('idle'); setCancelling(false);
  }
  async function inspect(): Promise<void> {
    if (busyRef.current) return;
    const input = url.trim();
    if (!input) { setError({ key: 'errors.enterUrl' }); return; }
    invalidate(); start('inspect');
    setStatus({ title: 'status.inspectTitle', message: { key: 'status.inspectMessage' } });
    try {
      const info = await unwrap(api.inspect(input));
      setVideo(info); setParsedUrl(input);
      setStatus({ title: 'status.inspectedTitle', message: { key: 'status.inspectedMessage' } });
    } catch (error) {
      setError(displayError(error));
      setStatus({ title: 'status.inspectFailedTitle', message: { key: 'status.inspectFailedMessage' } });
    } finally { finish(); }
  }
  async function download(): Promise<void> {
    if (busyRef.current) return;
    let targetUrl = parsedUrl;
    let currentVideo = video;
    if (!currentVideo) {
      const input = url.trim();
      if (!input) { setError({ key: 'errors.enterUrl' }); return; }
      invalidate(); start('inspect');
      setStatus({ title: 'status.inspectTitle', message: { key: 'status.inspectMessage' } });
      try {
        currentVideo = await unwrap(api.inspect(input));
        setVideo(currentVideo);
        targetUrl = input;
        setParsedUrl(input);
      } catch (error) {
        setError(displayError(error));
        setStatus({ title: 'status.inspectFailedTitle', message: { key: 'status.inspectFailedMessage' } });
        finish();
        return;
      }
    }
    start('download'); setCompleted(false); setProgress(null);
    setStatus({ title: 'status.downloadTitle', message: { key: 'status.downloadMessage' } });
    try {
      const result = await unwrap(api.download({ url: targetUrl, height: quality }));
      setCompleted(true);
      setLastDownloadedFile(result.file);
      setStatus({ title: 'status.completeTitle', message: { text: result.file } });
    } catch (error) {
      setError(displayError(error)); setProgress(null);
      setStatus({ title: 'status.stoppedTitle', message: { key: 'status.stoppedMessage' } });
    } finally { finish(); }
  }
  async function cancel(): Promise<void> {
    if (!busyRef.current || cancellingRef.current) return;
    cancellingRef.current = true; setCancelling(true);
    setStatus({ title: 'status.cancelTitle', message: { key: 'status.cancelMessage' } });
    try { await unwrap(api.cancel()); } catch (error) { setError(displayError(error)); }
  }
  async function changeLocale(locale: Locale): Promise<void> {
    if (!initialized || savingLanguageRef.current) return;
    savingLanguageRef.current = true; setSavingLanguage(true);
    try { await i18n.changeLanguage(await unwrap(api.setLocale(locale))); }
    catch (error) { setError(displayError(error)); }
    finally { savingLanguageRef.current = false; setSavingLanguage(false); }
  }
  async function chooseFolder(): Promise<void> {
    if (busyRef.current) return;
    try { setFolder(await unwrap(api.chooseFolder())); } catch (error) { setError(displayError(error)); }
  }
  async function chooseCookies(): Promise<void> {
    if (busyRef.current) return;
    try { setCookieFile(await unwrap(api.chooseCookies())); invalidate(); } catch (error) { setError(displayError(error)); }
  }
  async function clearCookies(): Promise<void> {
    if (busyRef.current) return;
    try { await unwrap(api.clearCookies()); setCookieFile(''); invalidate(); } catch (error) { setError(displayError(error)); }
  }
  async function openFolder(): Promise<void> {
    try { await unwrap(api.openFolder()); } catch (error) { setError(displayError(error)); }
  }
  async function reveal(): Promise<void> {
    try { await unwrap(api.reveal()); } catch (error) { setError(displayError(error)); }
  }
  return {
    url, video, quality, folder, version, cookieFile, phase, busy, cancelling, status, progress, completed, error,
    lastDownloadedFile, setLastDownloadedFile,
    initialized, savingLanguage, changeLocale,
    changeUrl, setQuality, inspect, download, cancel, chooseFolder, chooseCookies, clearCookies, openFolder, reveal,
  };
}
export type DownloadController = ReturnType<typeof useDownloader>;
