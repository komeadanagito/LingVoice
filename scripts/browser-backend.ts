// Local Web backend. Credentials and provider requests stay in Node, never in the renderer.
import type { Plugin } from 'vite';
import type { ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import ffmpeg from 'ffmpeg-static';
import { Downloader } from '../src/main/downloader';
import { HistoryService, MAX_HISTORY_BYTES, validateHistoryTask } from '../src/main/history';
import type { HistoryTask } from '../src/shared/history';
import { mediaResponse } from '../src/main/media';
import { ProviderService } from '../src/main/providers';
import { TranslationService } from '../src/main/translation';
import { TtsService } from '../src/main/tts';
import { DubbingService } from '../src/main/dubbing';
import { AsrService } from '../src/main/asr';
import { createServerVault } from '../src/main/server-vault';
import { filePathToMediaUrl } from '../src/renderer/utils/media';
import { LocalizedError } from '../src/shared/i18n/translate';
import { isLocale } from '../src/shared/i18n/catalog';
import { devServerUrl } from '../src/shared/dev-server';

export interface BrowserBackendOptions { dataDir?: string; folder?: string; origin?: string; ffmpegPath?: string; responseHeartbeatMs?: number }
// JSON whitespace keeps idle HTTP/proxy connections active without changing the API envelope.
const LONG_REQUEST_ROUTES = new Set([
  '/translation-run', '/translation-memory', '/translation-review', '/translation-models',
  '/asr-run', '/asr-test', '/tts-generate', '/dubbing-run', '/dubbing-check',
  '/provider-models', '/inspect', '/download',
]);
const MAX_UPLOAD_BYTES = 512 * 1024 * 1024;
const MAX_UPLOADS = 4;
const UPLOAD_TTL = 30 * 60 * 1000;

async function syncDirectory(directory: string): Promise<void> {
  // Windows cannot open directories as file descriptors; file fsync still applies there.
  if (process.platform === 'win32') return;
  const handle = await fs.open(directory, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

export function browserBackend(options: BrowserBackendOptions = {}): Plugin {
  return {
    name: 'lingvoice-browser-backend',
    apply: 'serve',
    configureServer(server) {
      const folder = options.folder ?? path.resolve('video');
      // Keep the vault outside Vite's source/workspace file-serving roots.
      const dataDir = options.dataDir ?? path.join(os.homedir(), '.lingvoice', 'web');
      const historyReady = Promise.resolve().then(() => new HistoryService(path.join(dataDir, 'history.sqlite')));
      void historyReady.catch(() => {});
      const ffmpegPath = options.ffmpegPath ?? ffmpeg ?? '';
      const expected = new URL(options.origin ?? devServerUrl);
      const streams = new Set<ServerResponse>();
      // Only this server writes these capability records; client paths are never registered.
      // Per-handle records avoid lost updates when several outputs finish concurrently.
      const handlesDir = path.join(dataDir, 'media-handles');
      const handlesReady = (async () => {
        await fs.mkdir(handlesDir, { recursive: true, mode: 0o700 });
        await fs.chmod(handlesDir, 0o700);
      })();
      void handlesReady.catch(() => {});
      async function expose(file: string): Promise<string> {
        await handlesReady;
        const canonical = await fs.realpath(file);
        if (!(await fs.stat(canonical)).isFile()) throw new Error('Media file is unavailable.');
        const token = randomUUID();
        // Publish the URL only after its private record has been durably written.
        const handle = await fs.open(path.join(handlesDir, token), 'wx', 0o600);
        try {
          await handle.writeFile(JSON.stringify({ version: 1, file: canonical }));
          await handle.sync();
        } finally { await handle.close(); }
        await syncDirectory(handlesDir);
        return `${expected.origin}/api/lingvoice/media/${token}`;
      }
      async function resolveHandle(token: string): Promise<string | undefined> {
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(token)) return;
        try {
          await handlesReady;
          const record = JSON.parse(await fs.readFile(path.join(handlesDir, token), 'utf8'));
          if (record?.version !== 1 || typeof record.file !== 'string' || !path.isAbsolute(record.file)) return;
          // Missing files and paths replaced with symlinks must fail closed after restart.
          if (await fs.realpath(record.file) !== record.file || !(await fs.stat(record.file)).isFile()) return;
          return record.file;
        } catch { return; }
      }
      async function resolveMediaUrl(value: string): Promise<string | undefined> {
        try {
          const url = new URL(value);
          if (url.origin === expected.origin && url.pathname.startsWith('/api/lingvoice/media/')) {
            return await resolveHandle(url.pathname.slice('/api/lingvoice/media/'.length));
          }
        } catch { /* Accept only server-issued URLs, never client filesystem paths. */ }
      }
      async function historyReferences(task: HistoryTask, storing: boolean): Promise<HistoryTask> {
        const map = async (value: string): Promise<string> => {
          if (!value) return '';
          if (storing) {
            if (!await resolveMediaUrl(value)) throw new Error('Invalid history media reference.');
            return new URL(value).pathname;
          }
          if (!/^\/api\/lingvoice\/media\/[0-9a-f-]{36}$/.test(value)) throw new Error('Invalid history media reference.');
          return `${expected.origin}${value}`;
        };
        task.file = await map(task.file);
        const result = task.subtitles?.result;
        if (result) {
          result.video = await map(result.video);
          result.audio = await map(result.audio);
          result.subtitles = await map(result.subtitles);
        }
        return task;
      }
      const uploads = new Map<string, { file: string; directory: string; timer: NodeJS.Timeout }>();
      let uploading = 0;
      let lastToken = '';
      let speech: AsrService | undefined;
      let synthesis: TtsService | undefined;
      let dubbingService: DubbingService | undefined;
      const manager = new Downloader({
        dataDir, ffmpegPath,
        emit: event => { for (const stream of streams) stream.write(`data: ${JSON.stringify(event)}\n\n`); },
      });
      const services = (async () => {
        const vault = await createServerVault(dataDir);
        const providers = new ProviderService(path.join(dataDir, 'providers.json'), vault);
        const translation = new TranslationService(path.join(dataDir, 'translation.json'), vault, providers);
        const tts = new TtsService(path.join(dataDir, 'tts.json'), providers, vault);
        synthesis = tts;
        const dubbing = new DubbingService({
          directory: path.join(dataDir, 'dubbing'), ffmpegPath,
          helperPath: await fs.access(path.join(__dirname, 'audio-separation.py'))
            .then(() => path.join(__dirname, 'audio-separation.py'))
            .catch(() => path.resolve(__dirname, '../../scripts/audio-separation.py')),
          tts, translation,
          emit: progress => { for (const stream of streams) stream.write(`event: dubbing-progress\ndata: ${JSON.stringify(progress)}\n\n`); },
        });
        dubbingService = dubbing;
        const asr = new AsrService(path.join(dataDir, 'asr.json'), vault, ffmpegPath, progress => {
          for (const stream of streams) stream.write(`event: asr-progress\ndata: ${JSON.stringify(progress)}\n\n`);
        }, {}, providers);
        speech = asr;
        return { providers, translation, asr, tts, dubbing };
      })();
      // Initialization errors are returned through the same typed API as other failures.
      void services.catch(() => {});
      async function removeUpload(token: string) {
        const upload = uploads.get(token);
        if (!upload) return;
        uploads.delete(token); clearTimeout(upload.timer);
        await fs.rm(upload.directory, { recursive: true, force: true });
      }
      server.httpServer?.once('close', () => {
        manager.cancel(); speech?.cancel(); synthesis?.cancel(); dubbingService?.cancel();
        void historyReady.then(history => history.close()).catch(() => {});
        for (const stream of streams) stream.end();
        for (const token of uploads.keys()) void removeUpload(token).catch(() => {});
      });
      server.middlewares.use('/api/lingvoice', async (req, res) => {
        let heartbeat: NodeJS.Timeout | undefined;
        const stopHeartbeat = () => { if (heartbeat) clearInterval(heartbeat); };
        res.once('close', stopHeartbeat);
        const reply = (data: unknown, status = 200) => {
          stopHeartbeat();
          if (res.destroyed || res.writableEnded) return;
          if (!res.headersSent) {
            res.statusCode = status;
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.setHeader('Cache-Control', 'no-store');
          }
          res.end(JSON.stringify(data));
        };
        if (req.headers.host !== expected.host || (req.headers.origin && req.headers.origin !== expected.origin) || req.headers['sec-fetch-site'] === 'cross-site') {
          reply({ ok: false, error: 'Invalid request origin' }, 403); return;
        }
        const route = (req.url || '').split('?')[0];
        if (route === '/events' && req.method === 'GET') {
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
          res.write(': connected\n\n');
          streams.add(res);
          const heartbeat = setInterval(() => res.write(': keep-alive\n\n'), 15000);
          req.on('close', () => { clearInterval(heartbeat); streams.delete(res); });
          return;
        }
        if (route.startsWith('/media/') && ['GET', 'HEAD'].includes(req.method || '')) {
          const file = await resolveHandle(route.slice('/media/'.length));
          if (!file) { reply({ ok: false, error: 'File not found' }, 404); return; }
          const response = await mediaResponse(new Request(filePathToMediaUrl(file), { method: req.method, headers: req.headers.range ? { Range: req.headers.range } : {} }));
          res.statusCode = response.status;
          response.headers.forEach((value, key) => res.setHeader(key, value));
          if (!response.body) { res.end(); return; }
          const stream = Readable.fromWeb(response.body as import('node:stream/web').ReadableStream);
          stream.on('error', () => res.destroy());
          res.on('close', () => stream.destroy());
          stream.pipe(res);
          return;
        }
        const historyUpload = route.startsWith('/history-media/');
        if ((route === '/asr-upload' || historyUpload) && req.method === 'POST') {
          if (historyUpload && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(route.slice('/history-media/'.length))) {
            reply({ ok: false, error: 'Invalid history task ID.' }, 400); return;
          }
          if (req.headers['content-type'] !== 'application/octet-stream') { reply({ ok: false, error: 'Binary media upload required.' }, 415); return; }
          if (Number(req.headers['content-length']) > MAX_UPLOAD_BYTES) { reply({ ok: false, error: 'Media upload exceeds 512 MB.' }, 413); return; }
          if (uploads.size + uploading >= MAX_UPLOADS) { reply({ ok: false, error: 'Too many pending media uploads.' }, 429); return; }
          uploading++;
          let directory = '';
          try {
            const root = path.join(dataDir, historyUpload ? 'task-media' : 'uploads');
            await fs.mkdir(root, { recursive: true, mode: 0o700 });
            await fs.chmod(root, 0o700);
            directory = await fs.mkdtemp(path.join(root, 'media-'));
            await fs.chmod(directory, 0o700);
            const file = path.join(directory, 'media');
            const handle = await fs.open(file, 'wx', 0o600);
            let size = 0;
            try {
              for await (const chunk of req) {
                const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
                size += bytes.byteLength;
                if (size > MAX_UPLOAD_BYTES) throw new Error('Media upload exceeds 512 MB.');
                // FileHandle.writeFile handles partial writes without buffering the full video.
                await handle.writeFile(bytes);
              }
              if (historyUpload) await handle.sync();
            } finally { await handle.close(); }
            if (!size || !req.complete) throw new Error('Media upload is empty or incomplete.');
            if (historyUpload) {
              // Make the file and its containing directory durable before publishing a capability.
              for (const dir of [directory, root, dataDir]) await syncDirectory(dir);
              reply({ ok: true, data: { file: await expose(file) } });
              return;
            }
            const token = `upload:${randomUUID()}`;
            const timer = setTimeout(() => { void removeUpload(token).catch(() => {}); }, UPLOAD_TTL);
            timer.unref();
            uploads.set(token, { file, directory, timer });
            reply({ ok: true, data: { file: token } });
          } catch (error) {
            if (directory) await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
            reply({ ok: false, error: historyUpload ? 'History media upload failed (maximum 512 MB).' : error instanceof Error ? error.message : 'Media upload failed.' });
          } finally { uploading--; }
          return;
        }
        if (req.method !== 'POST' || !req.headers['content-type']?.startsWith('application/json')) {
          reply({ ok: false, error: 'JSON POST required' }, 405); return;
        }
        try {
          const chunks: Buffer[] = [];
          let bodyBytes = 0;
          for await (const chunk of req) {
            const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            bodyBytes += bytes.byteLength;
            if (bodyBytes > (route === '/history-save' ? MAX_HISTORY_BYTES : route === '/dubbing-run' ? 2 * 1024 * 1024 : 256 * 1024)) throw new Error('Request too large');
            chunks.push(bytes);
          }
          const data = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
          if (LONG_REQUEST_ROUTES.has(route)) {
            // Disable socket inactivity timeouts only after the bounded request body is read.
            // Do not change the server's upload/header timeouts or replay billable operations.
            req.setTimeout(0);
            res.setTimeout(0);
            res.writeHead(200, {
              'Content-Type': 'application/json; charset=utf-8',
              'Cache-Control': 'no-store, no-transform',
              'X-Accel-Buffering': 'no',
            });
            res.write(' \n');
            heartbeat = setInterval(() => {
              if (res.destroyed || res.writableEnded) { stopHeartbeat(); return; }
              // Respect backpressure; a slow/disconnected client must not accumulate writes.
              if (!res.writableNeedDrain) res.write(' \n');
            }, options.responseHeartbeatMs ?? 15000);
            heartbeat.unref();
          }
          if (['/history', '/history-save', '/history-delete', '/history-select'].includes(route)) {
            try {
              const history = await historyReady;
              let result: unknown;
              if (route === '/history') {
                const state = history.list();
                result = { ...state, tasks: await Promise.all(state.tasks.map(task => historyReferences(task, false))) };
              } else if (route === '/history-save') {
                history.save(await historyReferences(validateHistoryTask(data), true));
              } else if (route === '/history-delete') history.delete(data?.id);
              else history.select(data?.id);
              reply({ ok: true, data: result });
            } catch { reply({ ok: false, error: 'Unable to update or read task history. Verify task data and server-issued media references.' }); }
            return;
          }
          const { providers, translation, asr, tts, dubbing } = await services;
          let result: unknown;
          switch (route) {
            case '/dubbing-config': result = await dubbing.getConfig(); break;
            case '/dubbing-save': result = await dubbing.saveConfig(data); break;
            case '/dubbing-check': result = await dubbing.check(); break;
            case '/dubbing-clear': await dubbing.clearCache(); break;
            case '/dubbing-delete-voice': await dubbing.deleteVoice(data.voiceId); break;
            case '/dubbing-cancel': {
              if (typeof data.jobId !== 'string') throw new Error('Invalid dubbing job.');
              dubbing.cancel(data.jobId); break;
            }
            case '/dubbing-run': {
              if (!data || typeof data.file !== 'string') throw new Error('Invalid media reference.');
              if (dubbing.busy) throw new Error('Dubbing is already in progress.');
              const upload = uploads.get(data.file);
              const file = upload?.file ?? await resolveMediaUrl(data.file);
              if (!file) throw new Error('Select a local media file or a video downloaded by this Web server.');
              // Claim the upload for the entire pipeline, not just the ASR stage.
              if (upload) { clearTimeout(upload.timer); uploads.delete(data.file); }
              const disconnected = () => { if (!res.writableEnded) dubbing.cancel(data.jobId); };
              res.once('close', disconnected);
              try {
                const completed = await dubbing.run({ ...data, file });
                result = { ...completed, video: await expose(completed.video), audio: await expose(completed.audio), subtitles: await expose(completed.subtitles) };
              } finally {
                res.removeListener('close', disconnected);
                if (upload) await fs.rm(upload.directory, { recursive: true, force: true });
              }
              break;
            }
            case '/providers': result = await providers.list(); break;
            case '/provider-save': {
              if (data?.id) {
                const [catalog, trans, speech, synthesis] = await Promise.all([providers.list(), translation.getConfig(), asr.getConfig(), tts.getConfig()]);
                const adapter = catalog.adapters.find(adapter => adapter.id === data.adapter);
                if (trans.settings.providerId === data.id && !adapter?.capabilities.includes('translation')) throw new Error('Provider is bound to translation and must support translation.');
                if (synthesis.settings.providerId === data.id && !adapter?.capabilities.includes('tts')) throw new Error('Provider is bound to speech synthesis and must support TTS.');
                if (speech.settings.providerId === data.id && !adapter?.capabilities.includes('asr')) throw new Error('Provider is bound to speech recognition and must support ASR.');
              }
              result = await providers.save(data); break;
            }
            case '/provider-remove': {
              const [trans, speech, synthesis] = await Promise.all([translation.getConfig(), asr.getConfig(), tts.getConfig()]);
              if (trans.settings.providerId === data.id || speech.settings.providerId === data.id || synthesis.settings.providerId === data.id) throw new Error('Provider is in use. Change task bindings first.');
              await providers.remove(data.id); break;
            }
            case '/asr-config': result = await asr.getConfig(); break;
            case '/asr-save': result = await asr.saveConfig(data); break;
            case '/asr-cancel': asr.cancel(); break;
            case '/asr-test': await asr.test(); break;
            case '/asr-upload-remove': await removeUpload(data.file); break;
            case '/asr-run': {
              if (!data || typeof data.file !== 'string' || Object.keys(data).some(key => key !== 'file')) throw new Error('Invalid media reference.');
              const upload = uploads.get(data.file);
              const file = upload?.file ?? await resolveMediaUrl(data.file);
              if (!file) throw new Error('Select a local media file or a video downloaded by this Web server.');
              if (asr.busy) throw new Error('ASR is already busy.');
              if (upload) { clearTimeout(upload.timer); uploads.delete(data.file); }
              const disconnected = () => { if (!res.writableEnded) asr.cancel(); };
              res.once('close', disconnected);
              try { result = await asr.transcribe({ file }); }
              finally {
                res.removeListener('close', disconnected);
                if (upload) await fs.rm(upload.directory, { recursive: true, force: true });
              }
              break;
            }
            case '/provider-models': result = await providers.models(data.id); break;
            case '/tts-config': result = await tts.getConfig(); break;
            case '/tts-save': result = await tts.saveConfig(data); break;
            case '/tts-cancel': tts.cancel(); break;
            case '/tts-generate': {
              const disconnected = () => { if (!res.writableEnded) tts.cancel(); };
              res.once('close', disconnected);
              try { result = await tts.generate(data); }
              finally { res.removeListener('close', disconnected); }
              break;
            }
            case '/translation-config': result = await translation.getConfig(); break;
            case '/translation-save': result = await translation.saveConfig(data); break;
            case '/translation-models': result = await translation.models(); break;
            case '/translation-run': result = await translation.translate(data); break;
            case '/translation-memory': result = await translation.summarize(data); break;
            case '/translation-review': result = await translation.review(data); break;
            case '/state': result = { folder, version: 'web-local', locale: 'zh-CN' }; break;
            case '/inspect':
              if (typeof data.url !== 'string' || data.url.length > 4096) throw new LocalizedError('errors.urlLength');
              result = await manager.inspect(data.url); break;
            case '/download': {
              if (typeof data.url !== 'string' || data.url.length > 4096 || typeof data.height !== 'string') throw new LocalizedError('errors.downloadArgs');
              const downloaded = await manager.download({ url: data.url, height: data.height, folder });
              const url = await expose(downloaded.file);
              lastToken = url.slice(url.lastIndexOf('/') + 1);
              result = { file: url }; break;
            }
            case '/cancel': manager.cancel(); break;
            case '/reveal': result = lastToken ? `${expected.origin}/api/lingvoice/media/${lastToken}` : ''; break;
            case '/locale':
              if (!isLocale(data.locale)) throw new LocalizedError('errors.locale');
              result = data.locale; break;
            default: throw new Error('Unsupported Web API route.');
          }
          reply({ ok: true, data: result });
        } catch (error) {
          reply(error instanceof LocalizedError
            ? { ok: false, error: error.message, errorKey: error.key, errorValues: error.values }
            : { ok: false, error: error instanceof Error ? error.message : String(error) });
        }
      });
    },
  };
}
