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
    await waitFor(window, "!!document.querySelector('.dubbing-main-button') && !!document.querySelector('.player-actions input[type=file]')");
    assert.equal(await window.webContents.executeJavaScript("document.querySelector('.dubbing-main-button').disabled"), true);
    await window.webContents.executeJavaScript(`(() => {
      document.querySelector('.app-right-sidebar-toggle').click();
      const input = document.querySelector('.player-actions input[type=file]');
      const files = new DataTransfer(); files.items.add(new File(['offline'], 'authorized-sample.mp4', { type: 'video/mp4' }));
      input.files = files.files; input.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await waitFor(window, "!!document.querySelector('video') && !document.querySelector('.asr-start').disabled");
    await window.webContents.executeJavaScript("document.querySelector('.asr-start').click()");
    await waitFor(window, "document.querySelector('.subtitle-hint')?.textContent.includes('transcription.srt') && !document.querySelector('.subtitle-translate').disabled");
    assert.equal(await window.webContents.executeJavaScript("document.querySelector('.dubbing-main-button').disabled"), true);
    await window.webContents.executeJavaScript("document.querySelector('.subtitle-translate').click()");
    await waitFor(window, "!!document.querySelector('.transcript-cue-translation') && !document.querySelector('.dubbing-main-button').disabled");
    await window.webContents.executeJavaScript("document.querySelector('.dubbing-main-button').click()");
    await waitFor(window, "document.querySelector('#right-sidebar .settings-error')?.textContent.includes('disabled in offline fixtures')");
    assert.equal(await window.webContents.executeJavaScript("document.querySelector('.dubbing-main-button').disabled"), false);
    window.showInactive(); await pause(200);
    const artifact = path.resolve(__dirname, '../../artifacts/dubbing.png');
    await fs.mkdir(path.dirname(artifact), { recursive: true }); await fs.writeFile(artifact, (await window.webContents.capturePage()).toPNG());
    console.log('PASS: 3-stage dubbing trigger, prerequisite gating, error recovery and UI state.');
    console.log('Screenshot: artifacts/dubbing.png');
    clearTimeout(deadline); window.destroy(); await fs.rm(directory, { recursive: true, force: true }).catch(() => {}); app.exit(0);
  } catch (error) { console.error(error); clearTimeout(deadline); app.exit(1); }
});
