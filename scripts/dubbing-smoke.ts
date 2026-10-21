// Offline UI smoke: uses an isolated sandboxed fixture and never contacts a cloud provider.
import { app, BrowserWindow } from 'electron';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { mkdtempSync } from 'node:fs';
const directory = mkdtempSync(path.join(os.tmpdir(), 'lingvoice-dubbing-ui-'));
app.setPath('userData', directory);
const deadline = setTimeout(() => { console.error('Dubbing UI test timed out'); app.exit(1); }, 30000);
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(window: BrowserWindow, expression: string) {
  for (let index = 0; index < 100; index++) {
    if (await window.webContents.executeJavaScript(expression)) return;
    await pause(40);
  }
  throw new Error(`Timed out: ${expression}`);
}
app.whenReady().then(async () => {
  const window = new BrowserWindow({ width: 1130, height: 850, show: false, webPreferences: {
    preload: path.join(__dirname, 'fixture-preload.js'), sandbox: true, contextIsolation: true, nodeIntegration: false,
  } });
  try {
    await window.loadFile(path.resolve(__dirname, '../renderer/index.html'));
    await waitFor(window, "!!document.querySelector('.dubbing-open-button') && !!document.querySelector('.player-actions input[type=file]')");
    assert.equal(await window.webContents.executeJavaScript("document.querySelector('.dubbing-consent input')"), null);
    await window.webContents.executeJavaScript(`(() => {
      document.querySelector('.app-right-sidebar-toggle').click();
      const input = document.querySelector('.player-actions input[type=file]');
      const files = new DataTransfer(); files.items.add(new File(['offline'], 'authorized-sample.mp4', { type: 'video/mp4' }));
      input.files = files.files; input.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await waitFor(window, "!!document.querySelector('video')");
    await window.webContents.executeJavaScript(`(() => {
      const input = document.querySelector('.subtitle-toolbar input[type=file]');
      const files = new DataTransfer(); files.items.add(new File(['1\\n00:00:00,000 --> 00:00:06,000\\nAuthorized original speech'], 'authorized.srt', { type: 'text/plain' }));
      input.files = files.files; input.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await waitFor(window, "!document.querySelector('.dubbing-open-button').disabled");
    await window.webContents.executeJavaScript("document.querySelector('.dubbing-open-button').click()");
    await waitFor(window, "!!document.querySelector('.dubbing-modal') && !document.querySelector('.dubbing-modal .translation-fields').disabled");
    assert.equal(await window.webContents.executeJavaScript("document.querySelector('.dubbing-modal .primary').disabled"), true);
    assert.match(await window.webContents.executeJavaScript("document.querySelector('.dubbing-modal').textContent"), /qwen-audio-3\.1-tts-plus/);
    await window.webContents.executeJavaScript(`(() => {
      const input = document.querySelector('.dubbing-cue textarea');
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, 'Editable spoken translation');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('.dubbing-consent input').click();
    })()`);
    await waitFor(window, "!document.querySelector('.dubbing-modal .primary').disabled");
    assert.equal(await window.webContents.executeJavaScript("document.querySelector('.transcript-cue-item').textContent.includes('Editable spoken translation')"), false);
    await window.webContents.executeJavaScript("document.querySelector('.dubbing-modal .primary').click()");
    await waitFor(window, "document.querySelector('.dubbing-modal .settings-error')?.textContent.includes('disabled in offline fixtures')");
    assert.equal(await window.webContents.executeJavaScript("document.querySelector('.dubbing-modal .primary').disabled"), false);
    await window.webContents.executeJavaScript("document.querySelector('.dubbing-modal .settings-actions .choose-file-button:nth-child(2)').click()");
    await waitFor(window, "document.querySelector('.dubbing-modal .settings-error')?.textContent.includes('Offline fixture')");
    window.showInactive(); await pause(200);
    const artifact = path.resolve(__dirname, '../../artifacts/dubbing.png');
    await fs.mkdir(path.dirname(artifact), { recursive: true }); await fs.writeFile(artifact, (await window.webContents.capturePage()).toPNG());
    console.log('PASS: isolated dubbing modal, trigger button, consent gating, independent speech text, error recovery and local environment check.');
    console.log('Screenshot: artifacts/dubbing.png');
    clearTimeout(deadline); window.destroy(); await fs.rm(directory, { recursive: true, force: true }).catch(() => {}); app.exit(0);
  } catch (error) { console.error(error); clearTimeout(deadline); app.exit(1); }
});
