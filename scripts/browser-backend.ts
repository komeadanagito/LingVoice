// Development-only local backend for browser previews. Never included in the renderer bundle.
import type { Plugin } from 'vite';
import type { ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import ffmpeg from 'ffmpeg-static';
import { Downloader } from '../src/main/downloader';
import { mediaResponse } from '../src/main/media';
import { filePathToMediaUrl } from '../src/renderer/utils/media';
import { LocalizedError } from '../src/shared/i18n/translate';
import { isLocale } from '../src/shared/i18n/catalog';
import { devServerUrl } from '../src/shared/dev-server';
import { defaultTranslationSettings } from '../src/shared/translation';
import { defaultAsrSettings } from '../src/shared/asr';
import { createDefaultProviderRegistry } from '../src/main/providers';

export function browserBackend(): Plugin {
  return {
    name: 'lingvoice-browser-backend',
    apply: 'serve',
    configureServer(server) {
      const folder = path.resolve('video');
      const streams = new Set<ServerResponse>();
      const files = new Map<string, string>();
      let lastToken = '';
      const manager = new Downloader({
        dataDir: path.resolve('.cache/lingvoice'), ffmpegPath: ffmpeg || '',
        emit: event => { for (const stream of streams) stream.write(`data: ${JSON.stringify(event)}\n\n`); },
      });
      server.httpServer?.once('close', () => {
        manager.cancel();
        for (const stream of streams) stream.end();
      });
      server.middlewares.use('/api/lingvoice', async (req, res) => {
        const reply = (data: unknown, status = 200) => {
          res.statusCode = status;
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.end(JSON.stringify(data));
        };
        const expected = new URL(devServerUrl);
        if (req.headers.host !== expected.host || (req.headers.origin && req.headers.origin !== expected.origin) || req.headers['sec-fetch-site'] === 'cross-site') {
          reply({ ok: false, error: 'Invalid request origin' }, 403); return;
        }
        const route = (req.url || '').split('?')[0];
        if (route === '/events' && req.method === 'GET') {
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
          res.write(': connected\n\n');
          streams.add(res);
          req.on('close', () => streams.delete(res));
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
        if (req.method !== 'POST' || !req.headers['content-type']?.startsWith('application/json')) {
          reply({ ok: false, error: 'JSON POST required' }, 405); return;
        }
        try {
          let body = '';
          for await (const chunk of req) {
            body += chunk.toString();
            if (Buffer.byteLength(body) > 8192) throw new Error('Request too large');
          }
          const data = JSON.parse(body || '{}');
          let result: unknown;
          switch (route) {
            case '/providers': result = { providers: [], adapters: createDefaultProviderRegistry().list() }; break;
            case '/asr-config': result = { settings: defaultAsrSettings, hasApiKey: false }; break;
            case '/provider-save':
            case '/provider-remove':
            case '/asr-save':
            case '/asr-run':
            case '/asr-cancel': throw new Error('Provider 配置和语音识别需要桌面版。 / Providers and speech recognition require the desktop app.');
            case '/translation-config': result = { settings: defaultTranslationSettings, hasApiKey: false, hasMachineKey: false }; break;
            case '/translation-save':
            case '/translation-models':
            case '/translation-run': throw new Error('翻译服务和密钥安全保存需要桌面版。浏览器预览支持导入和显示原文字幕。 / Translation services require the desktop app.');
            case '/state': result = { folder, version: 'web-local', locale: 'zh-CN' }; break;
            case '/inspect':
              if (typeof data.url !== 'string' || data.url.length > 4096) throw new LocalizedError('errors.urlLength');
              result = await manager.inspect(data.url); break;
            case '/download': {
              if (typeof data.url !== 'string' || data.url.length > 4096 || typeof data.height !== 'string') throw new LocalizedError('errors.downloadArgs');
              const downloaded = await manager.download({ url: data.url, height: data.height, folder });
              lastToken = randomUUID();
              files.set(lastToken, downloaded.file);
              result = { file: `${expected.origin}/api/lingvoice/media/${lastToken}` }; break;
            }
            case '/cancel': manager.cancel(); break;
            case '/reveal': result = lastToken ? `${expected.origin}/api/lingvoice/media/${lastToken}` : ''; break;
            case '/locale':
              if (!isLocale(data.locale)) throw new LocalizedError('errors.locale');
              result = data.locale; break;
            default: throw new LocalizedError('errors.desktopDownload');
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
