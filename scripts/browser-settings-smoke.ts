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

app.on('window-all-closed', () => { /* Cleanup completes before the explicit test exit code. */ });
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const deadline = setTimeout(() => app.exit(1), 120000);
async function waitFor(window: BrowserWindow, expression: string) {
  for (let i = 0; i < 150; i++) {
    if (await window.webContents.executeJavaScript(expression)) return;
    await pause(50);
  }
  const feedback = await window.webContents.executeJavaScript("Array.from(document.querySelectorAll('[role=alert], .task-history-execution, .subtitle-hint, .transcript-cue-text, .subtitle-stage-actions')).map(node => node.textContent).join(' | ')");
  throw new Error(`Timed out: ${expression}. Feedback: ${feedback}`);
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
    if (req.url === '/v1/models') { modelRequests++; res.end(JSON.stringify({ data: ['web-test-model', 'qwen-audio-3.1-asr-flash', 'tts-1'].map(id => ({ id })) })); }
    else if (req.url === '/v1/audio/speech') {
      res.setHeader('Content-Type', 'audio/mpeg'); res.end(mp3);
    }
    else if (req.url === '/v1/audio/transcriptions') res.end(JSON.stringify({ text: 'Web recognized speech', segments: [{ start: 0, end: 1, text: 'Web recognized speech' }] }));
    else if (req.url?.endsWith('/chat/completions') && JSON.parse(body).messages?.some((message: { content: unknown }) => Array.isArray(message.content) && message.content.some(part => part.type === 'input_audio'))) res.end(JSON.stringify({ choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'Web recognized speech' } }] }));
    else if (req.url === '/api/v1/services/aigc/multimodal-generation/generation') res.end(JSON.stringify({ output: { choices: [{ message: { content: [{ text: 'Web recognized speech' }] } }] } }));
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
    await window.webContents.executeJavaScript("document.querySelector('.nav-history').click()");
    await waitFor(window, "!document.querySelector('.history-page').hidden && !!document.querySelector('.task-history-empty-state')");
    assert.equal(await window.webContents.executeJavaScript("document.querySelector('.main-content').hidden && !document.querySelector('.sidebar .task-history-list') && document.querySelector('.nav-history').getAttribute('aria-current') === 'page'"), true, 'History navigation opens the main content list, not a sidebar list');
    await window.webContents.executeJavaScript("document.querySelector('#sidebar-navigation .nav-item').click()");
    await waitFor(window, "document.querySelector('.history-page').hidden && !document.querySelector('.main-content').hidden");
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
      for (const selector of ['#translation-provider', '#asr-provider']) {
        const select = document.querySelector(selector); select.value = id;
        select.dispatchEvent(new Event('change', { bubbles: true }));
      }
    })()`);
    await pause(100);
    const originalTaskSettings = await window.webContents.executeJavaScript('(async () => [await window.lingvoice.translationConfig(), await window.lingvoice.asrConfig()])()');
    await window.webContents.executeJavaScript("document.querySelector('.translation-section .fetch-models').click()");
    await waitFor(window, "!!document.querySelector('select#translation-model') && !!document.querySelector('select#asr-model') && !!document.querySelector('select#tts-model')");
    assert.equal(modelRequests, 1, 'Translation and ASR model pickers share a single discovery result');
    assert.deepEqual(await window.webContents.executeJavaScript('(async () => [await window.lingvoice.translationConfig(), await window.lingvoice.asrConfig()])()'), originalTaskSettings, 'Model discovery never saves task settings');
    assert.deepEqual(await window.webContents.executeJavaScript("[document.getElementById('translation-model').value, document.getElementById('asr-model').value, document.getElementById('tts-model').value]"), ['gpt-4o-mini', 'qwen-audio-3.1-asr-flash', 'qwen-audio-3.1-tts-plus']);
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
    await window.webContents.executeJavaScript(`(() => {
      const url = document.getElementById('tts-base-url');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(url, ${JSON.stringify(providerUrl)});
      url.dispatchEvent(new Event('input', { bubbles: true }));
      const key = document.querySelector('.tts-section .secret-input input');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(key, 'web-test-secret');
      key.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
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
      const input = document.querySelector('.video-player-card:not([hidden]) .player-actions input[type=file]');
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
    assert.equal(await window.webContents.executeJavaScript("document.querySelector('.subtitle-translate').disabled && document.querySelector('.dubbing-main-button').disabled"), true);
    await window.webContents.executeJavaScript(`(() => {
      window.__phaseCalls = { asr: 0, translate: 0, dub: 0 };
      const transcribe = window.lingvoice.transcribe;
      const translate = window.lingvoice.translateSubtitles;
      window.lingvoice.transcribe = payload => { window.__phaseCalls.asr++; return transcribe(payload); };
      window.lingvoice.translateSubtitles = payload => { window.__phaseCalls.translate++; return translate(payload); };
      window.lingvoice.runDubbing = async payload => {
        window.__phaseCalls.dub++;
        window.__dubCues = payload.cues;
        window.__dubUseTtsConfig = payload.useTtsConfig;
        return { ok: false, error: 'Test dubbing reached existing translations' };
      };
    })()`);
    await window.webContents.executeJavaScript("document.querySelector('.asr-start').click()");
    await waitFor(window, "document.querySelector('.transcript-cue-text')?.textContent.includes('Web recognized speech') && !document.querySelector('.subtitle-translate').disabled");
    assert.deepEqual(await window.webContents.executeJavaScript('window.__phaseCalls'), { asr: 1, translate: 0, dub: 0 }, 'Recognition stops before translation');
    assert.equal(await window.webContents.executeJavaScript("document.querySelector('.dubbing-main-button').disabled"), true);
    assert.equal(await window.webContents.executeJavaScript("window.__asrProgress.some(value => value.stage === 'transcribing')"), true);
    await window.webContents.executeJavaScript("document.querySelector('.subtitle-translate').click()");
    await waitFor(window, "document.querySelector('.transcript-cue-translation')?.textContent.includes('Web 测试译文') && !document.querySelector('.dubbing-main-button').disabled");
    assert.deepEqual(await window.webContents.executeJavaScript('window.__phaseCalls'), { asr: 1, translate: 1, dub: 0 }, 'Translation reuses recognized cues and stops before dubbing');
    await window.webContents.executeJavaScript("document.querySelector('.dubbing-main-button').click()");
    await waitFor(window, "document.querySelector('.subtitle-workspace [role=alert]')?.textContent.includes('Test dubbing reached existing translations')");
    assert.deepEqual(await window.webContents.executeJavaScript('window.__phaseCalls'), { asr: 1, translate: 1, dub: 1 }, 'Dubbing does not repeat recognition or translation');
    assert.equal(await window.webContents.executeJavaScript('window.__dubCues[0].speechText'), 'Web 测试译文');
    assert.equal(await window.webContents.executeJavaScript('window.__dubUseTtsConfig'), true, 'Main workspace explicitly uses current TTS endpoint and model');
    assert.deepEqual(await fs.readdir(path.join(directory, 'uploads')), []);
    console.log('PASS: three independent transcription/translation/dubbing buttons, stage prerequisites, existing-cue reuse, SSE progress and upload cleanup.');
    // Exercise a second batch failure and resume without repeating ASR or the first batch.
    await window.webContents.executeJavaScript(`(() => {
      window.__resumeSizes = [];
      window.__resumeFailed = false;
      window.lingvoice.transcribe = async () => ({ ok: true, data: Array.from({ length: 31 }, (_, i) => ({ id: i + 1, start: i, end: i + 0.8, text: 'Line ' + i })) });
      window.lingvoice.summarizeTranslation = async () => ({ ok: true, data: { summary: 'Summary', terms: [] } });
      window.lingvoice.reviewTranslation = async () => ({ ok: true, data: [] });
      window.lingvoice.translateSubtitles = async payload => {
        window.__resumeSizes.push(payload.texts.length);
        if (payload.texts.length === 1 && !window.__resumeFailed) {
          window.__resumeFailed = true;
          return { ok: false, error: 'Test second batch interruption' };
        }
        return { ok: true, data: payload.texts.map(text => '译文 ' + text) };
      };
    })()`);
    await window.webContents.executeJavaScript("document.querySelector('.asr-start').click()");
    await waitFor(window, "document.querySelectorAll('.transcript-cue-item').length === 31 && !document.querySelector('.subtitle-translate').disabled");
    await window.webContents.executeJavaScript("document.querySelector('.subtitle-translate').click()");
    await waitFor(window, "document.querySelector('.subtitle-workspace [role=alert]')?.textContent.includes('Test second batch interruption')");
    assert.equal(await window.webContents.executeJavaScript("document.querySelectorAll('.transcript-cue-translation').length"), 30);
    assert.equal(await window.webContents.executeJavaScript("document.querySelector('.dubbing-main-button').disabled"), true);
    await waitFor(window, "document.querySelector('.sidebar-save-status')?.dataset.saveState === 'saved'");
    const partialBatchSizes = await window.webContents.executeJavaScript('window.__resumeSizes');
    await window.loadURL(`http://127.0.0.1:${port}`);
    await waitFor(window, "document.querySelectorAll('.transcript-cue-translation').length === 30 && !document.querySelector('.subtitle-translate').disabled");
    await window.webContents.executeJavaScript(`(() => {
      window.__resumeSizes = ${JSON.stringify(partialBatchSizes)};
      window.lingvoice.summarizeTranslation = async () => ({ ok: true, data: { summary: 'Summary', terms: [] } });
      window.lingvoice.reviewTranslation = async () => ({ ok: true, data: [] });
      window.lingvoice.translateSubtitles = async payload => {
        window.__resumeSizes.push(payload.texts.length);
        return { ok: true, data: payload.texts.map(text => '译文 ' + text) };
      };
    })()`);
    assert.deepEqual(partialBatchSizes, [30, 1]);
    await window.webContents.executeJavaScript("document.querySelector('.subtitle-translate').click()");
    await waitFor(window, "document.querySelectorAll('.transcript-cue-translation').length === 31 && !document.querySelector('.dubbing-main-button').disabled");
    assert.deepEqual(await window.webContents.executeJavaScript('window.__resumeSizes'), [30, 1, 1], 'Retry translates only the missing batch and preserves all results');
    console.log('PASS: translation retry retains 30 completed cues and fills the remaining batch.');
    const durableSource = await window.webContents.executeJavaScript("document.querySelector('.video-player-card:not([hidden]) .player-viewport video').src");
    await window.webContents.executeJavaScript(`(() => {
      window.lingvoice.runDubbing = async payload => ({ ok: true, data: {
        jobId: payload.jobId, video: ${JSON.stringify(`${durableSource}#dubbed`)}, audio: ${JSON.stringify(durableSource)},
        subtitles: ${JSON.stringify(durableSource)}, cues: payload.cues, preview: false,
        targetLanguage: 'zh', voiceId: 'history-test-voice'
      } });
      document.querySelector('.dubbing-main-button').click();
    })()`);
    await waitFor(window, "!!document.querySelector('.dubbing-result-card') && document.querySelector('.sidebar-save-status')?.dataset.saveState === 'saved'");
    assert.equal(await window.webContents.executeJavaScript("document.querySelectorAll('.task-history-row').length"), 1);
    await waitFor(window, "document.querySelector('.video-player-card:not([hidden]) .player-source-switch button:last-child')?.getAttribute('aria-pressed') === 'true'");
    assert.equal(await window.webContents.executeJavaScript("document.querySelector('.video-player-card:not([hidden]) .player-viewport video').src"), `${durableSource}#dubbed`);
    assert.equal(await window.webContents.executeJavaScript("document.querySelectorAll('.dubbing-result-card audio').length"), 0, 'Dubbing plays in the video player, with no separate competing audio player');
    await waitFor(window, "document.querySelector('.video-player-card:not([hidden]) .player-viewport video').readyState >= 2 && !document.querySelector('.player-spinner')");
    await window.webContents.executeJavaScript("(() => { const v = document.querySelector('.video-player-card:not([hidden]) .player-viewport video'); v.pause(); v.currentTime = 0.35; })()");
    await waitFor(window, "Math.abs(document.querySelector('.video-player-card:not([hidden]) .player-viewport video').currentTime - 0.35) < 0.05");
    await window.webContents.executeJavaScript("document.querySelector('.video-player-card:not([hidden]) .player-source-switch button:first-child').click()");
    await waitFor(window, "document.querySelector('.video-player-card:not([hidden]) .player-source-switch button:first-child')?.getAttribute('aria-pressed') === 'true' && document.querySelector('.video-player-card:not([hidden]) .player-viewport video').readyState >= 2 && !document.querySelector('.player-spinner')");
    const switchedPlayback = await window.webContents.executeJavaScript("(() => { const v = document.querySelector('.video-player-card:not([hidden]) .player-viewport video'); return { time: v.currentTime, paused: v.paused }; })()");
    assert.ok(Math.abs(switchedPlayback.time - 0.35) < 0.05, 'Switching versions retains the playback position');
    assert.equal(switchedPlayback.paused, true, 'Switching versions retains paused state');
    assert.equal(await window.webContents.executeJavaScript("document.querySelector('.video-player-card:not([hidden]) .player-viewport video').src"), durableSource);
    assert.equal(await window.webContents.executeJavaScript("document.querySelectorAll('.transcript-cue-translation').length"), 31, 'Switching versions retains subtitle work');
    await window.webContents.executeJavaScript("document.querySelector('.video-player-card:not([hidden]) .player-source-switch button:last-child').click()");
    await waitFor(window, "document.querySelector('.video-player-card:not([hidden]) .player-source-switch button:last-child')?.getAttribute('aria-pressed') === 'true'");
    console.log('PASS: dubbed video auto-loads, original/dubbed switching preserves subtitles and uses one player.');
    await window.webContents.executeJavaScript('window.__stopProgress?.()');
    await window.loadURL(`http://127.0.0.1:${port}`);
    await waitFor(window, "document.querySelectorAll('.transcript-cue-translation').length === 31 && !!document.querySelector('.dubbing-result-card') && !document.querySelector('.dubbing-main-button').disabled && document.querySelector('.sidebar-save-status')?.dataset.saveState === 'saved'");
    assert.equal(await window.webContents.executeJavaScript("document.querySelector('.task-history-meta').textContent.includes('配音完成')"), true);
    assert.equal(await window.webContents.executeJavaScript("document.querySelector('.dubbing-result-actions a').getAttribute('href')"), durableSource);
    await waitFor(window, "document.querySelector('.video-player-card:not([hidden]) .player-source-switch button:last-child')?.getAttribute('aria-pressed') === 'true'");
    assert.equal(await window.webContents.executeJavaScript("document.querySelector('.video-player-card:not([hidden]) .player-viewport video').src"), durableSource, 'Reload restores the canonical durable server media URL for the dubbed version');
    assert.equal(await window.webContents.executeJavaScript(`(async () => {
      const response = await fetch(document.querySelector('.video-player-card:not([hidden]) .player-viewport video').src);
      const bytes = new Uint8Array(await response.arrayBuffer());
      const expected = ${JSON.stringify(wav)};
      return response.ok && bytes.length === expected.length && bytes.every((value, index) => value === expected[index]);
    })()`), true, 'Reload retains the selected video bytes on the server disk');
    await window.webContents.executeJavaScript("document.querySelector('#sidebar-navigation .nav-item').click()");
    await waitFor(window, "!document.querySelector('.transcript-cue-item') && document.querySelectorAll('.task-history-row').length === 1");
    await window.webContents.executeJavaScript(`(() => {
      const input = document.querySelector('.video-player-card:not([hidden]) .player-actions input[type=file]');
      const data = new DataTransfer();
      data.items.add(new File([new Uint8Array(${JSON.stringify(wav)})], 'second-video.mp4', { type: 'video/mp4' }));
      input.files = data.files; input.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await waitFor(window, "document.querySelectorAll('.task-history-row').length === 2 && document.querySelector('.sidebar-save-status')?.dataset.saveState === 'saved'");
    assert.equal(await window.webContents.executeJavaScript("document.querySelectorAll('.transcript-cue-item').length"), 0, 'A new task starts without previous subtitles');
    await window.webContents.executeJavaScript("document.querySelector('.nav-history').click()");
    await waitFor(window, "!document.querySelector('.history-page').hidden && document.querySelectorAll('.history-page .task-history-row').length === 2");
    await window.webContents.executeJavaScript("Array.from(document.querySelectorAll('.task-history-open')).find(node => node.textContent.includes('speech.mp4')).click()");
    await waitFor(window, "document.querySelector('.history-page').hidden && !document.querySelector('.main-content').hidden && document.querySelectorAll('.transcript-cue-translation').length === 31 && !!document.querySelector('.dubbing-result-card')");
    await window.webContents.executeJavaScript("window.confirm = () => true; Array.from(document.querySelectorAll('.task-history-row')).find(node => node.textContent.includes('second-video.mp4')).querySelector('.task-history-delete').click()");
    await waitFor(window, "document.querySelectorAll('.task-history-row').length === 1 && document.querySelector('.sidebar-save-status')?.dataset.saveState === 'saved'");
    await window.loadURL(`http://127.0.0.1:${port}`);
    await waitFor(window, "document.querySelectorAll('.task-history-row').length === 1 && document.querySelectorAll('.transcript-cue-translation').length === 31");
    console.log('PASS: SQLite video/cue/result restore after reload, independent new tasks, history selection and durable deletion.');
    await window.webContents.executeJavaScript("document.querySelector('.nav-history').click()");
    await waitFor(window, "!document.querySelector('.history-page').hidden");
    window.setSize(1280, 800);
    await pause(250);
    await fs.writeFile(path.join(os.tmpdir(), 'lingvoice-task-history.png'), (await window.webContents.capturePage()).toPNG());
    window.setSize(620, 720);
    await pause(250);
    assert.equal(await window.webContents.executeJavaScript('document.documentElement.scrollWidth <= window.innerWidth'), true, 'Task history does not introduce horizontal page overflow');
    await window.webContents.executeJavaScript("document.querySelector('.task-history-open').click()");
    await waitFor(window, "!!document.querySelector('.subtitle-offset input')");
    await window.webContents.executeJavaScript(`(() => {
      window.__originalHistorySave = window.lingvoice.saveHistoryTask;
      window.lingvoice.saveHistoryTask = async () => ({ ok: false, error: 'Test SQLite disk full' });
      const input = document.querySelector('.subtitle-offset input');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '1.5');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await waitFor(window, "document.querySelector('.task-history-save.has-error')?.textContent.includes('保存失败')");
    assert.equal(await window.webContents.executeJavaScript("document.querySelectorAll('.transcript-cue-translation').length"), 31, 'A failed cache write keeps the current work visible');
    await window.webContents.executeJavaScript(`(() => {
      window.lingvoice.saveHistoryTask = window.__originalHistorySave;
      const input = document.querySelector('.subtitle-offset input');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '2');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await waitFor(window, "!document.querySelector('.task-history-save.has-error') && document.querySelector('.sidebar-save-status')?.dataset.saveState === 'saved'");
    await window.loadURL(`http://127.0.0.1:${port}`);
    await waitFor(window, "document.querySelector('.subtitle-offset input')?.value === '2' && document.querySelectorAll('.transcript-cue-translation').length === 31");
    console.log('PASS: explicit quota-error feedback, recovery after a successful save and persisted subtitle settings.');
    await window.webContents.executeJavaScript(`(() => {
      window.lingvoice.inspect = async () => ({ ok: true, data: { id: 'history1234', title: 'History download fixture', uploader: 'Test', duration: 1, thumbnail: '', heights: [], partCount: 1 } });
      window.lingvoice.download = async () => ({ ok: true, data: { file: ${JSON.stringify(durableSource)} } });
      const input = document.querySelector('#url');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'https://www.youtube.com/watch?v=history1234');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await waitFor(window, "!document.querySelector('#inspect').disabled");
    await window.webContents.executeJavaScript("document.querySelector('#inspect').click()");
    await waitFor(window, "document.querySelectorAll('.task-history-row').length === 2 && !document.querySelector('#download').disabled");
    await window.webContents.executeJavaScript("document.querySelector('#download').click()");
    await waitFor(window, `document.querySelector('.video-player-card:not([hidden]) .player-viewport video')?.src === ${JSON.stringify(durableSource)} && document.querySelector('.sidebar-save-status')?.dataset.saveState === 'saved'`);
    assert.equal(await window.webContents.executeJavaScript("document.querySelectorAll('.task-history-row').length"), 2, 'Downloading updates its inspected task rather than creating a duplicate');
    console.log('PASS: inspected link and downloaded source share one persistent task.');
    const legacyId = await window.webContents.executeJavaScript(`(async () => {
      const current = await window.lingvoice.history();
      const original = current.data.tasks.find(task => task.title === 'speech.mp4');
      const id = crypto.randomUUID();
      const db = await new Promise((resolve, reject) => { const r = indexedDB.open('lingvoice-tasks', 2); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
      await new Promise((resolve, reject) => {
        const tx = db.transaction('tasks', 'readwrite');
        tx.objectStore('tasks').put({ ...original, id, title: 'Legacy migration fixture', file: '', mediaFile: new File([new Uint8Array(${JSON.stringify(wav)})], 'legacy.mp4', { type: 'video/mp4' }) });
        tx.oncomplete = resolve; tx.onabort = () => reject(tx.error);
      });
      db.close();
      return id;
    })()`);
    await window.loadURL(`http://127.0.0.1:${port}`);
    await waitFor(window, "document.querySelectorAll('.task-history-row').length === 3 && !document.querySelector('.task-history-save.has-error')");
    await window.webContents.executeJavaScript("document.querySelector('.nav-history').click(); Array.from(document.querySelectorAll('.task-history-open')).find(node => node.textContent.includes('Legacy migration fixture')).click()");
    await waitFor(window, "document.querySelectorAll('.transcript-cue-translation').length === 31 && !document.querySelector('.dubbing-main-button').disabled && document.querySelector('.sidebar-save-status')?.dataset.saveState === 'saved'");
    assert.equal(await window.webContents.executeJavaScript(`(async () => {
      const state = await window.lingvoice.history();
      const task = state.data.tasks.find(task => task.id === ${JSON.stringify(legacyId)});
      const response = await fetch(task.file);
      return task.title === 'Legacy migration fixture' && (await response.arrayBuffer()).byteLength === ${wav.length};
    })()`), true, 'Legacy file and subtitle data are committed to server storage');
    await window.webContents.session.clearStorageData({ origin: `http://127.0.0.1:${port}`, storages: ['indexdb', 'localstorage'] });
    await window.loadURL(`http://127.0.0.1:${port}`);
    await waitFor(window, "document.querySelectorAll('.task-history-row').length === 3 && document.querySelectorAll('.transcript-cue-translation').length === 31");
    assert.equal(await window.webContents.executeJavaScript("document.querySelector('.video-player-card:not([hidden]) .player-viewport video').src.startsWith(location.origin + '/api/lingvoice/media/')"), true);
    assert.equal((await fs.readFile(path.join(directory, 'history.sqlite'))).subarray(0, 16).toString(), 'SQLite format 3\u0000');
    await waitFor(window, "document.querySelector('.sidebar-save-status')?.dataset.saveState === 'saved'");
    assert.equal(await window.webContents.executeJavaScript("!!document.querySelector('.sidebar .task-history-save') || document.querySelector('.sidebar').textContent.includes('已保存到 SQLite')"), false, 'Successful saves have no persistent sidebar description');
    console.log('PASS: old IndexedDB task migration, disk-backed media and SQLite history survive clearing browser storage.');
    await window.webContents.executeJavaScript(`(() => {
      document.querySelector('.sidebar-settings').click();
      const input = document.getElementById('tts-base-url');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await waitFor(window, "document.querySelector('#tts-token-plan-hint')?.textContent.includes('voice-enrollment')");
    assert.equal(await window.webContents.executeJavaScript("document.getElementById('tts-base-url').getAttribute('aria-describedby')"), 'tts-token-plan-hint');
    console.log('PASS: Token Plan endpoint shows native-API and cloning-permission guidance without issuing a paid request.');
    await window.webContents.executeJavaScript(`(() => {
      window.confirm = () => true;
      window.__batchCalls = [];
      window.lingvoice.transcribe = async request => {
        window.__batchCalls.push(request.file);
        if (window.__batchCalls.length === 1) await new Promise(resolve => { window.__releaseBatch = resolve; });
        return { ok: true, data: [{ id: 1, start: 0, end: 1, text: 'Batch source sentence.' }] };
      };
      window.lingvoice.translateSubtitles = async payload => ({ ok: true, data: payload.texts.map(() => 'Batch translated sentence.') });
      window.lingvoice.reviewTranslation = async () => ({ ok: true, data: [] });
      window.lingvoice.runDubbing = async payload => ({ ok: true, data: {
        jobId: payload.jobId, video: ${JSON.stringify(durableSource)}, audio: ${JSON.stringify(durableSource)},
        subtitles: ${JSON.stringify(durableSource)}, cues: payload.cues, preview: false, targetLanguage: 'en', voiceId: 'batch-fixture'
      } });
      document.querySelector('.nav-history').click();
    })()`);
    await waitFor(window, "!document.querySelector('.history-page').hidden");
    await window.webContents.executeJavaScript(`(() => {
      const input = document.querySelector('.task-history-file-import input');
      const data = new DataTransfer();
      for (const name of ['batch-a.mp4', 'batch-b.mp4']) data.items.add(new File([new Uint8Array(${JSON.stringify(wav)})], name, { type: 'video/mp4' }));
      input.files = data.files; input.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await waitFor(window, "document.querySelectorAll('.task-history-row').length === 5 && document.querySelector('.sidebar-save-status')?.dataset.saveState === 'saved'");
    await window.webContents.executeJavaScript(`(() => {
      for (const row of document.querySelectorAll('.task-history-row')) if (/batch-[ab]\\.mp4/.test(row.textContent)) row.querySelector('input[type=checkbox]').click();
    })()`);
    await waitFor(window, "!document.querySelector('.task-history-run').disabled");
    await window.webContents.executeJavaScript("document.querySelector('.task-history-run').click()");
    await waitFor(window, "window.__batchCalls.length === 1 && !!window.__releaseBatch");
    assert.equal(await window.webContents.executeJavaScript("document.querySelectorAll('.task-history-badge.is-queued').length"), 1, 'Second batch task waits rather than competing for ASR/GPU');
    await window.webContents.executeJavaScript("document.querySelector('.sidebar-settings').click()");
    await waitFor(window, "!document.querySelector('.settings-page').hidden");
    await window.webContents.executeJavaScript("document.querySelector('.nav-history').click(); Array.from(document.querySelectorAll('.task-history-open')).find(node => node.textContent.includes('Legacy migration fixture')).click()");
    await waitFor(window, "!document.querySelector('.main-content').hidden && document.querySelectorAll('.transcript-cue-translation').length === 31");
    assert.equal(await window.webContents.executeJavaScript('window.__batchCalls.length'), 1, 'Switching task and settings does not restart or discard a running task');
    await window.webContents.executeJavaScript("window.__releaseBatch(); document.querySelector('.nav-history').click()");
    await waitFor(window, "Array.from(document.querySelectorAll('.task-history-row')).filter(row => /batch-[ab]\\.mp4/.test(row.textContent) && row.querySelector('.task-history-badge.is-completed')).length === 2");
    assert.equal(await window.webContents.executeJavaScript('window.__batchCalls.length'), 2);
    await window.webContents.executeJavaScript("Array.from(document.querySelectorAll('.task-history-open')).find(node => node.textContent.includes('batch-a.mp4')).click()");
    await waitFor(window, "!!document.querySelector('.dubbing-result-card') && document.querySelectorAll('.transcript-cue-translation').length === 1 && !document.querySelector('.dubbing-main-button').disabled");
    console.log('PASS: two imported local videos execute serially through transcription, translation and dubbing; switching settings and tasks retains work and completed results.');
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
