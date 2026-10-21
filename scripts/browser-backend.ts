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

export interface BrowserBackendOptions { dataDir?: string; folder?: string; origin?: string; ffmpegPath?: string }
const MAX_UPLOAD_BYTES = 512 * 1024 * 1024;
const MAX_UPLOADS = 4;
const UPLOAD_TTL = 30 * 60 * 1000;

export function browserBackend(options: BrowserBackendOptions = {}): Plugin {
  return {
    name: 'lingvoice-browser-backend',
    apply: 'serve',
    configureServer(server) {
      const folder = options.folder ?? path.resolve('video');
      // Keep the vault outside Vite's source/workspace file-serving roots.
      const dataDir = options.dataDir ?? path.join(os.homedir(), '.lingvoice', 'web');
      const ffmpegPath = options.ffmpegPath ?? ffmpeg ?? '';
      const expected = new URL(options.origin ?? devServerUrl);
      const streams = new Set<ServerResponse>();
      const files = new Map<string, string>();
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
        const asr = new AsrService(path.join(dataDir, 'asr.json'), vault, ffmpegPath, progress => {
          for (const stream of streams) stream.write(`event: asr-progress\ndata: ${JSON.stringify(progress)}\n\n`);
        }, {}, providers);
        speech = asr;
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
        for (const stream of streams) stream.end();
        for (const token of uploads.keys()) void removeUpload(token).catch(() => {});
      });
      server.middlewares.use('/api/lingvoice', async (req, res) => {
        const reply = (data: unknown, status = 200) => {
          if (res.destroyed || res.writableEnded) return;
          res.statusCode = status;
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.setHeader('Cache-Control', 'no-store');
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
          const file = files.get(route.slice('/media/'.length));
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
        if (route === '/asr-upload' && req.method === 'POST') {
          if (req.headers['content-type'] !== 'application/octet-stream') { reply({ ok: false, error: 'Binary media upload required.' }, 415); return; }
          if (Number(req.headers['content-length']) > MAX_UPLOAD_BYTES) { reply({ ok: false, error: 'Media upload exceeds 512 MB.' }, 413); return; }
          if (uploads.size + uploading >= MAX_UPLOADS) { reply({ ok: false, error: 'Too many pending media uploads.' }, 429); return; }
          uploading++;
          let directory = '';
          try {
            await fs.mkdir(path.join(dataDir, 'uploads'), { recursive: true, mode: 0o700 });
            directory = await fs.mkdtemp(path.join(dataDir, 'uploads', 'media-'));
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
            } finally { await handle.close(); }
            if (!size || !req.complete) throw new Error('Media upload is empty or incomplete.');
            const token = `upload:${randomUUID()}`;
            const timer = setTimeout(() => { void removeUpload(token).catch(() => {}); }, UPLOAD_TTL);
            timer.unref();
            uploads.set(token, { file, directory, timer });
            reply({ ok: true, data: { file: token } });
          } catch (error) {
            if (directory) await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
            reply({ ok: false, error: error instanceof Error ? error.message : 'Media upload failed.' });
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
            if (bodyBytes > (route === '/dubbing-run' ? 2 * 1024 * 1024 : 256 * 1024)) throw new Error('Request too large');
            chunks.push(bytes);
          }
          const data = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
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
              let file = upload?.file;
              if (!file) {
                try {
                  const url = new URL(data.file);
                  if (url.origin === expected.origin && url.pathname.startsWith('/api/lingvoice/media/')) file = files.get(url.pathname.slice('/api/lingvoice/media/'.length));
                } catch { /* Accept only issued local media tokens, never arbitrary client paths. */ }
              }
              if (!file) throw new Error('Select a local media file or a video downloaded by this Web server.');
              // Claim the upload for the entire pipeline, not just the ASR stage.
              if (upload) { clearTimeout(upload.timer); uploads.delete(data.file); }
              const disconnected = () => { if (!res.writableEnded) dubbing.cancel(data.jobId); };
              res.once('close', disconnected);
              try {
                const completed = await dubbing.run({ ...data, file });
                const expose = (file: string) => { const token = randomUUID(); files.set(token, file); return `${expected.origin}/api/lingvoice/media/${token}`; };
                result = { ...completed, video: expose(completed.video), audio: expose(completed.audio), subtitles: expose(completed.subtitles) };
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
              let file = upload?.file;
              if (!file) {
                try {
                  const url = new URL(data.file);
                  if (url.origin === expected.origin && url.pathname.startsWith('/api/lingvoice/media/')) file = files.get(url.pathname.slice('/api/lingvoice/media/'.length));
                } catch { /* Arbitrary paths and remote URLs are never accepted. */ }
              }
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
            case '/state': result = { folder, version: 'web-local', locale: 'zh-CN' }; break;
            case '/inspect':
              if (typeof data.url !== 'string' || data.url.length > 4096) throw new LocalizedError('errors.urlLength');
              result = await manager.inspect(data.url); break;
            case '/download': {
              if (typeof data.url !== 'string' || data.url.length > 4096 || typeof data.height !== 'string') throw new LocalizedError('errors.downloadArgs');
              const downloaded = await manager.download({ url: data.url, height: data.height, folder });
              lastToken = randomUUID(); files.set(lastToken, downloaded.file);
              result = { file: `${expected.origin}/api/lingvoice/media/${lastToken}` }; break;
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
