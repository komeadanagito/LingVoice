import { app, BrowserWindow } from 'electron';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Keep the test's language and folder preferences separate from the user's application.
const userData = mkdtempSync(path.join(os.tmpdir(), 'lingvoice-desktop-'));
writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({ locale: 'zh-CN' }));
app.setPath('userData', userData);
app.setName('lingvoice-downloader');
void import('../src/main/index');
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const deadline = setTimeout(() => { console.error('Desktop smoke test timed out'); app.exit(1); }, 30000);

async function waitFor(window: BrowserWindow, expression: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (await window.webContents.executeJavaScript(expression)) return;
    await pause(50);
  }
  throw new Error(`Timed out: ${expression}`);
}
async function inputUrl(window: BrowserWindow, value: string): Promise<void> {
  await window.webContents.executeJavaScript(`
    (() => {
      const input = document.getElementById('url');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(value)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()
  `);
  await pause(100);
  await window.webContents.executeJavaScript("document.getElementById('link-form').requestSubmit()");
}

async function changeLanguage(window: BrowserWindow, locale: 'zh-CN' | 'en'): Promise<void> {
  await waitFor(window, "!!document.getElementById('language') && !document.getElementById('language').disabled");
  await window.webContents.executeJavaScript(`
    (() => {
      const select = document.getElementById('language');
      select.value = ${JSON.stringify(locale)};
      select.dispatchEvent(new Event('change', { bubbles: true }));
    })()
  `);
  await waitFor(window, `document.documentElement.lang === ${JSON.stringify(locale)}`);
}

app.whenReady().then(async () => {
  try {
    let window: BrowserWindow | undefined;
    for (let i = 0; i < 100; i++) {
      window = BrowserWindow.getAllWindows()[0];
      if (window && !window.webContents.isLoading() && window.webContents.getURL().endsWith('index.html')) break;
      await pause(100);
    }
    assert.ok(window, 'Main window exists');
    await waitFor(window, "!!document.getElementById('folder')?.textContent");
    const initial = await window.webContents.executeJavaScript(`({
      title: document.querySelector('h1').textContent,
      folder: document.getElementById('folder').textContent,
      downloadDisabled: document.getElementById('download').disabled,
      bridge: typeof window.lingvoice.inspect,
      nodeExposed: typeof window.require
    })`) as { title: string; folder: string; downloadDisabled: boolean; bridge: string; nodeExposed: string };
    assert.ok(initial.title.includes('让喜欢的视频'));
    assert.ok(path.isAbsolute(initial.folder));
    assert.equal(initial.downloadDisabled, true);
    assert.equal(initial.bridge, 'function');
    assert.equal(initial.nodeExposed, 'undefined');
    const sidebarState = () => window!.webContents.executeJavaScript(`({
      left: document.querySelector('.app-sidebar-toggle').getAttribute('aria-expanded') === 'true',
      right: document.querySelector('.app-right-sidebar-toggle').getAttribute('aria-expanded') === 'true',
      empty: document.getElementById('right-sidebar').childElementCount === 0,
      hidden: document.getElementById('right-sidebar').getAttribute('aria-hidden') === 'true'
    })`);
    assert.deepEqual(await sidebarState(), { left: true, right: false, empty: true, hidden: true });
    await window.webContents.executeJavaScript("document.querySelector('.app-right-sidebar-toggle').click()");
    await waitFor(window, "document.querySelector('.app-right-sidebar-toggle').getAttribute('aria-expanded') === 'true' && document.getElementById('right-sidebar').getBoundingClientRect().width >= 260");
    assert.deepEqual(await sidebarState(), { left: false, right: true, empty: true, hidden: false });
    await window.webContents.executeJavaScript("document.querySelector('.app-sidebar-toggle').click()");
    await waitFor(window, "document.querySelector('.app-sidebar-toggle').getAttribute('aria-expanded') === 'true'");
    assert.deepEqual(await sidebarState(), { left: true, right: false, empty: true, hidden: true });
    await window.webContents.executeJavaScript("document.querySelector('.app-right-sidebar-toggle').click()");
    await waitFor(window, "document.querySelector('.app-right-sidebar-toggle').getAttribute('aria-expanded') === 'true'");
    await window.webContents.executeJavaScript("document.querySelector('.app-right-sidebar-toggle').click()");
    await waitFor(window, "document.querySelector('.app-right-sidebar-toggle').getAttribute('aria-expanded') === 'false'");
    assert.deepEqual(await sidebarState(), { left: false, right: false, empty: true, hidden: true });
    await window.webContents.executeJavaScript("document.querySelector('.app-sidebar-toggle').click()");
    await waitFor(window, "document.querySelector('.app-sidebar-toggle').getAttribute('aria-expanded') === 'true'");
    console.log('PASS: mutually exclusive left/right sidebars, independent collapse and empty right panel.');
    const providerChecks = await window.webContents.executeJavaScript(`(async () => {
      const api = window.lingvoice;
      const created = await api.saveProvider({ name: 'IPC provider test', adapter: 'openai-compatible', baseUrl: 'https://provider.example/v1' });
      if (!created.ok) throw new Error(created.error);
      const translation = await api.translationConfig(); const speech = await api.asrConfig();
      if (!translation.ok || !speech.ok) throw new Error('Unable to load task settings');
      const savedTranslation = await api.saveTranslationConfig({ settings: { ...translation.data.settings, providerId: created.data.id } });
      const savedSpeech = await api.saveAsrConfig({ settings: { ...speech.data.settings, providerId: created.data.id } });
      const protectedRemoval = await api.removeProvider(created.data.id);
      const incompatibleChange = await api.saveProvider({ ...created.data, adapter: 'libretranslate' });
      await api.saveTranslationConfig({ settings: { ...translation.data.settings, providerId: '' } });
      await api.saveAsrConfig({ settings: { ...speech.data.settings, providerId: '' } });
      const removed = await api.removeProvider(created.data.id);
      return { savedTranslation: savedTranslation.ok, savedSpeech: savedSpeech.ok, protectedRemoval: !protectedRemoval.ok, incompatibleChange: !incompatibleChange.ok, removed: removed.ok, secretExposed: 'apiKey' in created.data };
    })()`);
    assert.deepEqual(providerChecks, { savedTranslation: true, savedSpeech: true, protectedRemoval: true, incompatibleChange: true, removed: true, secretExposed: false });
    console.log('PASS: real provider IPC, shared task bindings, deletion/capability guards and credential redaction.');
    const screenshot = await window.webContents.capturePage().catch(() => null);
    const artifacts = path.resolve(__dirname, '../../artifacts');
    await fs.mkdir(artifacts, { recursive: true });
    if (screenshot) await fs.writeFile(path.join(artifacts, 'desktop.png'), screenshot.toPNG());
    await inputUrl(window, 'https://example.com/video/test');
    await waitFor(window, "document.getElementById('error')?.textContent.includes('目前仅支持 B 站')");
    assert.equal(await window.webContents.executeJavaScript("document.getElementById('inspect').disabled"), false);
    await changeLanguage(window, 'en');
    assert.equal(await window.webContents.executeJavaScript('document.title'), 'LingVoice · Video Downloader');
    assert.match(await window.webContents.executeJavaScript("document.getElementById('error').textContent"), /Only Bilibili/);
    await changeLanguage(window, 'zh-CN');
    assert.match(await window.webContents.executeJavaScript("document.getElementById('error').textContent"), /目前仅支持 B 站/);

    // A separate sandboxed window exercises React state transitions with deterministic fixtures.
    const fixture = new BrowserWindow({ show: false, width: 1130, height: 850, webPreferences: {
      preload: path.join(__dirname, 'fixture-preload.js'), sandbox: true, contextIsolation: true, nodeIntegration: false,
    } });
    await fixture.loadFile(path.resolve(__dirname, '../renderer/index.html'));
    await waitFor(fixture, "!!document.getElementById('folder')?.textContent");
    await inputUrl(fixture, 'https://www.bilibili.com/video/BV1xx411c7mD');
    await waitFor(fixture, "document.getElementById('video-title')?.textContent.includes('React 测试视频')");
    assert.equal(await fixture.webContents.executeJavaScript("!!document.getElementById('video-card')"), false);
    assert.match(await fixture.webContents.executeJavaScript("document.querySelector('.platform-player').src"), /player\.bilibili\.com\/player\.html\?.*bvid=BV1xx411c7mD/);
    assert.equal(await fixture.webContents.executeJavaScript("document.querySelector('#video-title img')"), null);
    assert.equal(await fixture.webContents.executeJavaScript("document.getElementById('quality').options.length"), 3);
    await fixture.webContents.executeJavaScript(`
      const select = document.getElementById('quality');
      select.value = '720'; select.dispatchEvent(new Event('change', { bubbles: true }));
    `);
    await pause(100);
    await fixture.webContents.executeJavaScript("document.getElementById('download').click()");
    await waitFor(fixture, "document.getElementById('percentage')?.textContent === '50.0%'");
    await changeLanguage(fixture, 'en');
    assert.equal(await fixture.webContents.executeJavaScript("document.getElementById('quality').value"), '720');
    await waitFor(fixture, "!!document.getElementById('reveal')");
    assert.equal(await fixture.webContents.executeJavaScript("document.getElementById('percentage').textContent"), 'Completed');
    await changeLanguage(fixture, 'zh-CN');
    assert.equal(await fixture.webContents.executeJavaScript("document.getElementById('percentage').textContent"), '已完成');
    await fixture.webContents.executeJavaScript("document.getElementById('download').click()");
    await waitFor(fixture, "!!document.getElementById('cancel')");
    await fixture.webContents.executeJavaScript("document.getElementById('cancel').click()");
    await waitFor(fixture, "document.getElementById('error')?.textContent.includes('已取消任务')");
    assert.equal(await fixture.webContents.executeJavaScript("document.getElementById('download').disabled"), false);
    await changeLanguage(fixture, 'en');
    assert.equal(await fixture.webContents.executeJavaScript("document.getElementById('error').textContent"), 'Task cancelled.');
    await fixture.webContents.executeJavaScript("document.getElementById('choose-cookies').click()");
    await waitFor(fixture, "document.getElementById('cookie-label').textContent.includes('test-cookies.txt')");
    assert.equal(await fixture.webContents.executeJavaScript("document.getElementById('download').disabled"), true);
    // Exercise translation settings and subtitle playback without contacting any provider.
    await fixture.webContents.executeJavaScript("document.querySelector('.sidebar-settings').click()");
    await waitFor(fixture, "!!document.querySelector('.translation-fields') && !document.querySelector('.translation-fields').disabled");
    assert.equal(await fixture.webContents.executeJavaScript("document.querySelectorAll('.settings-section').length"), 4);
    await fixture.webContents.executeJavaScript("document.querySelector('.translation-save').click()");
    await waitFor(fixture, "document.querySelector('.settings-notice')?.textContent.includes('Settings saved')");
    fixture.showInactive();
    await pause(250); // A visible window is needed for a fresh compositor frame.
    const settingsScreenshot = await fixture.webContents.capturePage();
    await fs.writeFile(path.join(artifacts, 'settings.png'), settingsScreenshot.toPNG());
    await fixture.webContents.executeJavaScript("document.querySelector('.nav-item').click()");
    await fixture.webContents.executeJavaScript(`(() => {
      const input = document.querySelector('.player-actions input[type=file]');
      const data = new DataTransfer();
      data.items.add(new File(['offline fixture'], 'local-test.mp4', { type: 'video/mp4' }));
      input.files = data.files; input.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await waitFor(fixture, "!!document.querySelector('video')");
    await fixture.webContents.executeJavaScript(`(() => {
      const input = document.querySelector('.subtitle-toolbar input[type=file]');
      const data = new DataTransfer();
      data.items.add(new File(['1\\n00:00:00,000 --> 00:00:05,000\\nHello world'], 'example.srt', { type: 'text/plain' }));
      input.files = data.files; input.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await waitFor(fixture, "document.querySelector('.subtitle-hint')?.textContent.includes('example.srt')");
    await fixture.webContents.executeJavaScript(`(() => {
      const video = document.querySelector('video');
      Object.defineProperty(video, 'currentTime', { configurable: true, value: 1 });
      video.dispatchEvent(new Event('timeupdate', { bubbles: true }));
    })()`);
    await waitFor(fixture, "document.querySelector('.subtitle-overlay')?.textContent.includes('Hello world')");
    await fixture.webContents.executeJavaScript("document.querySelector('.subtitle-toolbar .primary').click()");
    await waitFor(fixture, "document.querySelector('.subtitle-translation')?.textContent.includes('译文：Hello world')");
    await fixture.webContents.executeJavaScript(`(() => {
      const select = document.querySelector('.subtitle-toolbar select');
      select.value = 'translated'; select.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await waitFor(fixture, "!!document.querySelector('.subtitle-translation') && !document.querySelector('.subtitle-original')");
    await fixture.webContents.executeJavaScript(`(() => {
      const select = document.querySelector('.subtitle-toolbar select');
      select.value = 'off'; select.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await waitFor(fixture, "!document.querySelector('.subtitle-overlay')");
    await fixture.webContents.executeJavaScript(`(() => {
      const select = document.querySelector('.subtitle-toolbar select');
      select.value = 'original'; select.dispatchEvent(new Event('change', { bubbles: true }));
      document.querySelector('.asr-start').click();
    })()`);
    await waitFor(fixture, "!!document.querySelector('.asr-consent')");
    await fixture.webContents.executeJavaScript("document.querySelector('.asr-confirm').click()");
    await waitFor(fixture, "document.querySelector('.subtitle-overlay')?.textContent.includes('Recognized speech')");
    console.log('PASS: ASR upload confirmation, provider task binding and generated timestamped subtitles (offline fixtures).');
    console.log('PASS: grouped translation settings, configuration saving, SRT import, translation overlay and subtitle mode switching (offline fixtures).');
    console.log('PASS: bilingual switching, persisted preferences, restored locale, document title/lang, live status and error translation.');
    console.log('PASS: real desktop startup, isolated typed bridge, backend URL validation and React error recovery.');
    console.log('PASS: React preview escaping, quality selection, progress, completion, cancellation and cookie invalidation (offline fixtures).');
    console.log('Screenshot: artifacts/desktop.png');
    clearTimeout(deadline); app.exit(0);
  } catch (error) { console.error(error); clearTimeout(deadline); app.exit(1); }
});
