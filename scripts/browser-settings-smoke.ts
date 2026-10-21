// Isolated browser integration test: real Web backend, local test provider, no paid requests.
import { app, BrowserWindow } from 'electron';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import ffmpeg from 'ffmpeg-static';
import type { ViteDevServer, Plugin } from 'vite';
import { browserBackend } from './browser-backend';
import { pcmWav } from '../src/main/asr';

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const deadline = setTimeout(() => app.exit(1), 60000);
async function waitFor(window: BrowserWindow, expression: string) {
  for (let i = 0; i < 150; i++) {
    if (await window.webContents.executeJavaScript(expression)) return;
    await pause(50);
  }
  throw new Error(`Timed out: ${expression}`);
}
async function freePort(): Promise<number> {
  const server = http.createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>(resolve => server.close(() => resolve()));
  return port;
}

app.whenReady().then(async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lingvoice-web-ui-'));
  let vite: ViteDevServer | undefined;
  let window: BrowserWindow | undefined;
  let mp3: Buffer = Buffer.alloc(0);
  let modelRequests = 0;
  let failTranslation = false;
  const upstream = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk.toString();
    if (req.headers.authorization !== 'Bearer web-test-secret') { res.writeHead(401).end(); return; }
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/v1/models') { modelRequests++; res.end(JSON.stringify({ data: ['web-test-model', 'whisper-1', 'tts-1'].map(id => ({ id })) })); }
    else if (req.url === '/v1/audio/speech') {
      res.setHeader('Content-Type', 'audio/mpeg'); res.end(mp3);
    }
    else if (req.url === '/v1/audio/transcriptions') res.end(JSON.stringify({ segments: [{ start: 0, end: 0.5, text: 'Web recognized speech' }] }));
    else if (failTranslation) { res.statusCode = 400; res.end(JSON.stringify({ error: { message: 'private-provider-body' } })); }
    else res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(['Web 测试译文']) } }] }));
  });
  try {
    const encoded = await promisify(execFile)(ffmpeg!, ['-nostdin', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.25', '-f', 'mp3', 'pipe:1'], { encoding: 'buffer', windowsHide: true });
    mp3 = encoded.stdout;
    await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
    const providerUrl = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
    const port = await freePort();
    // Preserve native ESM imports in this CommonJS-compiled Electron test runner.
    const loadModule = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<unknown>;
    const { createServer } = await loadModule('vite') as typeof import('vite');
    const { default: react } = await loadModule('@vitejs/plugin-react') as { default: () => Plugin };
    vite = await createServer({
      configFile: false,
      root: path.resolve(__dirname, '../../src/renderer'),
      plugins: [react(), browserBackend({ dataDir: directory, folder: path.join(directory, 'video'), origin: `http://127.0.0.1:${port}` }), {
        name: 'test-csp', transformIndexHtml: html => html.replace('__CSP__', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws:; img-src 'self' data:; media-src 'self' blob:"),
      }],
      server: { host: '127.0.0.1', port, strictPort: true },
    });
    await vite.listen();
    window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
    await window.loadURL(`http://127.0.0.1:${port}`);
    await waitFor(window, "!!document.querySelector('.provider-save') && !document.querySelector('.translation-fields').disabled");
    await window.webContents.executeJavaScript("document.querySelector('.sidebar-settings').click()");
    assert.equal(await window.webContents.executeJavaScript("!document.querySelector('.settings-preview-notice') && window.lingvoice.runtime === 'browser'"), true);
    await window.webContents.executeJavaScript(`(() => {
      const inputs = document.querySelectorAll('.provider-section .settings-form-grid input');
      const values = ['Web UI provider', ${JSON.stringify(providerUrl)}, 'web-test-secret'];
      inputs.forEach((input, index) => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, values[index]);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
    })()`);
    await pause(100);
    await window.webContents.executeJavaScript("document.querySelector('.provider-save').click()");
    await waitFor(window, "document.querySelector('.provider-list-item')?.textContent.includes('Web UI provider')");
    await window.webContents.executeJavaScript(`(async () => {
      const catalog = await window.lingvoice.providers();
      const id = catalog.data.providers[0].id;
      for (const selector of ['#translation-provider', '#asr-provider', '#tts-provider']) {
        const select = document.querySelector(selector); select.value = id;
        select.dispatchEvent(new Event('change', { bubbles: true }));
      }
    })()`);
    await pause(100);
    const originalTaskSettings = await window.webContents.executeJavaScript('(async () => [await window.lingvoice.translationConfig(), await window.lingvoice.asrConfig()])()');
    await window.webContents.executeJavaScript("document.querySelector('.translation-section .fetch-models').click()");
    await waitFor(window, "!!document.querySelector('select#translation-model') && !!document.querySelector('select#asr-model') && !!document.querySelector('select#tts-model')");
    assert.equal(modelRequests, 1, 'All three model pickers share a single discovery result');
    assert.deepEqual(await window.webContents.executeJavaScript('(async () => [await window.lingvoice.translationConfig(), await window.lingvoice.asrConfig()])()'), originalTaskSettings, 'Model discovery never saves task settings');
    assert.deepEqual(await window.webContents.executeJavaScript("[document.getElementById('translation-model').value, document.getElementById('asr-model').value, document.getElementById('tts-model').value]"), ['gpt-4o-mini', 'whisper-1', 'tts-1']);
    await window.webContents.executeJavaScript("document.querySelector('.asr-section .fetch-models').click()");
    await waitFor(window, "!document.querySelector('.asr-section .fetch-models').disabled");
    assert.equal(modelRequests, 2, 'ASR can refresh the same provider model cache');
    assert.deepEqual(await window.webContents.executeJavaScript("[document.getElementById('translation-source-language').value, document.getElementById('asr-language').value, document.querySelector('.asr-section').textContent.includes('术语提示')]"), ['auto', '', false]);
    await window.webContents.executeJavaScript("document.querySelector('.translation-save').click()");
    await waitFor(window, "!document.querySelector('.translation-fields').disabled && !!document.querySelector('.translation-section .settings-notice')");
    await window.webContents.executeJavaScript("document.querySelector('.asr-save').click()");
    await waitFor(window, "!document.querySelector('.translation-fields').disabled && document.querySelector('.asr-feedback')?.textContent.includes('已保存')");
    await window.webContents.executeJavaScript("document.querySelector('.translation-section .settings-actions .choose-file-button').click()");
    await waitFor(window, "document.querySelector('.translation-section .translation-test-feedback')?.textContent.includes('Web 测试译文')");
    failTranslation = true;
    await window.webContents.executeJavaScript("document.querySelector('.translation-test').click()");
    await waitFor(window, "document.querySelector('.translation-section .translation-test-feedback[role=alert]')?.textContent.includes('HTTP 400')");
    assert.equal(await window.webContents.executeJavaScript("document.querySelector('.translation-test-feedback').textContent.includes('private-provider-body')"), false);
    failTranslation = false;
    await window.webContents.executeJavaScript("document.querySelector('.tts-save').click()");
    await waitFor(window, "document.querySelector('.tts-feedback')?.textContent.includes('已保存')");
    await window.webContents.executeJavaScript(`(() => {
      const input = document.querySelector('.tts-text-field textarea');
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, 'Hello from browser TTS');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await waitFor(window, "!document.querySelector('.tts-generate').disabled");
    await window.webContents.executeJavaScript("document.querySelector('.tts-generate').click()");
    await waitFor(window, "document.querySelector('.tts-audio-result audio')?.readyState >= 1");
    assert.equal(await window.webContents.executeJavaScript("document.querySelector('.tts-download').download"), 'speech.mp3');
    const downloadComplete = new Promise<void>((resolve, reject) => {
      window!.webContents.session.once('will-download', (_event, item) => {
        item.setSavePath(path.join(directory, 'speech.mp3'));
        item.once('done', (_event, state) => state === 'completed' ? resolve() : reject(new Error(`Download: ${state}`)));
      });
    });
    await window.webContents.executeJavaScript("document.querySelector('.tts-download').click()");
    await downloadComplete;
    assert.deepEqual(await fs.readFile(path.join(directory, 'speech.mp3')), mp3);
    console.log('PASS: task-local translation success/errors, synchronized model discovery, language selects, playable Web TTS and audio download.');
    assert.equal(await window.webContents.executeJavaScript("JSON.stringify(localStorage).includes('web-test-secret')"), false);
    assert.equal((await fs.readFile(path.join(directory, 'providers.json'), 'utf8')).includes('web-test-secret'), false);
    await window.webContents.reload();
    await waitFor(window, "!!document.querySelector('.provider-list-item') && !document.querySelector('.translation-fields').disabled");
    assert.equal(await window.webContents.executeJavaScript("document.querySelector('.translation-section select').value === document.querySelector('.asr-section select').value && !!document.querySelector('.asr-section select').value"), true);
    console.log('PASS: Web settings save, real server-side translation, persisted bindings, no plaintext credential storage in browser.');
    const wav = [...pcmWav(Buffer.alloc(32000))];
    await window.webContents.executeJavaScript(`(() => {
      const input = document.querySelector('.player-actions input[type=file]');
      const data = new DataTransfer();
      data.items.add(new File([new Uint8Array(${JSON.stringify(wav)})], 'speech.mp4', { type: 'video/mp4' }));
      input.files = data.files; input.dispatchEvent(new Event('change', { bubbles: true }));
      document.querySelector('.app-right-sidebar-toggle').click();
      window.__asrProgress = [];
      window.__stopProgress = window.lingvoice.onAsrProgress(value => window.__asrProgress.push(value));
    })()`);
    await waitFor(window, "!document.querySelector('.asr-start').disabled");
    // SSE subscription must be established before the short deterministic ASR task.
    await pause(250);
    await window.webContents.executeJavaScript("document.querySelector('.asr-start').click()");
    await waitFor(window, "!!document.querySelector('.asr-confirm')");
    assert.equal(await window.webContents.executeJavaScript("document.querySelector('.asr-consent').textContent.includes('Web 后端')"), true);
    await window.webContents.executeJavaScript("document.querySelector('.asr-confirm').click()");
    await waitFor(window, "document.querySelector('.subtitle-overlay')?.textContent.includes('Web recognized speech')");
    assert.equal(await window.webContents.executeJavaScript("window.__asrProgress.some(value => value.stage === 'transcribing')"), true);
    await window.webContents.executeJavaScript("document.querySelector('.subtitle-toolbar .primary').click()");
    await waitFor(window, "document.querySelector('.subtitle-translation')?.textContent.includes('Web 测试译文')");
    assert.deepEqual(await fs.readdir(path.join(directory, 'uploads')), []);
    console.log('PASS: browser-selected media, upload consent, real FFmpeg extraction, ASR provider request, SSE progress, translated overlay and temporary-file cleanup.');
    await window.webContents.executeJavaScript('window.__stopProgress()');
    window.destroy(); window = undefined;
    await vite.close(); vite = undefined;
    upstream.closeAllConnections();
    await new Promise<void>(resolve => upstream.close(() => resolve()));
    await fs.rm(directory, { recursive: true, force: true });
    clearTimeout(deadline); app.exit(0);
  } catch (error) {
    console.error(error);
    window?.destroy();
    await vite?.close().catch(() => {});
    upstream.closeAllConnections(); upstream.close();
    await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
    clearTimeout(deadline); app.exit(1);
  }
});
