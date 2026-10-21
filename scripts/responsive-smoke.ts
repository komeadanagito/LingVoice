import { app, BrowserWindow } from 'electron';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const deadline = setTimeout(() => app.exit(1), 60000);

app.whenReady().then(async () => {
  try {
    const window = new BrowserWindow({ show: false, useContentSize: true, width: 1024, height: 482, webPreferences: {
      preload: path.join(__dirname, 'fixture-preload.js'), sandbox: true, contextIsolation: true, nodeIntegration: false,
    } });
    if (process.env.LINGVOICE_RESPONSIVE_DEV) await window.loadURL('http://localhost:45173');
    else await window.loadFile(path.resolve(__dirname, '../renderer/index.html'));
    window.showInactive();
    await window.webContents.executeJavaScript('document.fonts.ready');
    await pause(200);
    assert.equal(await window.webContents.executeJavaScript(`
      !document.querySelector('.video-player-card .subtitle-workspace') &&
      !!document.querySelector('#right-sidebar .subtitle-toolbar') &&
      !document.querySelector('.subtitle-hint')
    `), true, 'Subtitle tools move to the right sidebar and default description is removed');
    const checkOpeningAnimation = async (label: string) => {
      const frames: { time: number; width: number; opacity: number }[] = await window.webContents.executeJavaScript(`(async () => {
        document.querySelector('.app-right-sidebar-toggle').click();
        const frames = [];
        const start = performance.now();
        while (performance.now() - start < 450) {
          await new Promise(resolve => requestAnimationFrame(resolve));
          frames.push({ time: performance.now() - start,
            width: document.getElementById('right-sidebar').getBoundingClientRect().width,
            opacity: Number(getComputedStyle(document.querySelector('.right-sidebar-tools')).opacity) });
        }
        return frames;
      })()`);
      const final = frames[frames.length - 1];
      assert.ok(final.width >= 320 && final.opacity === 1, `${label}: reaches expanded state`);
      const intermediate = frames.filter(frame => frame.width > 2 && frame.width < final.width - 2);
      assert.ok(new Set(intermediate.map(frame => Math.round(frame.width))).size >= 3, `${label}: width animates across multiple frames`);
      assert.ok(frames.some(frame => frame.time < 100 && frame.opacity > 0 && frame.opacity < 1), `${label}: controls fade in immediately rather than waiting`);
      assert.ok(frames.some(frame => frame.time > 150 && frame.opacity < 1), `${label}: fade remains perceptible`);
      console.log(`PASS: ${label}`);
    };
    await checkOpeningAnimation('first opening has visible width and opacity animation');
    for (const [width, height] of [[1427, 846], [1024, 482]]) {
      await window.webContents.executeJavaScript("document.querySelector('.app-right-sidebar-toggle').click()");
      await pause(500);
      window.setContentSize(width, height);
      await pause(150);
      await checkOpeningAnimation(`repeated opening at ${width}x${height}`);
    }
    await window.webContents.executeJavaScript("document.querySelector('.app-sidebar-toggle').click()");
    await pause(500);
    const checkLayout = async (label: string) => {
      const errors: string[] = await window.webContents.executeJavaScript(`(() => {
        const errors = [];
        const card = document.querySelector('.video-player-card').getBoundingClientRect();
        const viewport = document.querySelector('.player-viewport').getBoundingClientRect();
        const download = document.querySelector('.download-card').getBoundingClientRect();
        if (viewport.height < 24) errors.push('Viewport too short: ' + viewport.height);
        if (viewport.bottom > card.bottom - 4) errors.push('Viewport overflows player card');
        if (card.bottom > download.top) errors.push('Player overlaps download card');
        if (download.bottom > innerHeight) errors.push('Download card outside window');
        for (const selector of ['.main-content', '.video-player-card', '.download-card', '.url-box', '.video-player-card .subtitle-toolbar', '.player-controls']) {
          const element = document.querySelector(selector);
          if (element && element.getBoundingClientRect().width > 0 && !element.closest('.right-sidebar.collapsed') && element.scrollWidth > element.clientWidth + 1) errors.push(selector + ' overflows horizontally');
        }
        for (const element of document.querySelectorAll('*')) {
          const style = getComputedStyle(element);
          if (style.scrollbarWidth !== 'none') errors.push('Visible scrollbar style on ' + element.tagName);
        }
        return errors;
      })()`);
      assert.deepEqual(errors, [], label);
      console.log(`PASS: ${label}`);
    };
    const sizes = [[1440, 900], [1130, 740], [1024, 482], [880, 480], [768, 480], [640, 480], [640, 440], [390, 640]];
    for (const [width, height] of sizes) {
      window.setContentSize(width, height);
      await pause(120);
      await checkLayout(`empty ${width}x${height}`);
    }
    await window.webContents.executeJavaScript(`(() => {
      const input = document.querySelector('.player-actions input[type=file]');
      const data = new DataTransfer();
      data.items.add(new File(['fixture'], 'test.mp4', { type: 'video/mp4' }));
      input.files = data.files; input.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await pause(100);
    await window.webContents.executeJavaScript(`(() => {
      const input = document.querySelector('.subtitle-toolbar input[type=file]');
      const data = new DataTransfer();
      data.items.add(new File(['1\\n00:00:00,000 --> 00:00:05,000\\nHello world'], 'example.srt'));
      input.files = data.files; input.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await pause(150);
    for (const [width, height] of sizes) {
      window.setContentSize(width, height);
      await pause(120);
      await checkLayout(`video and subtitle controls ${width}x${height}`);
    }
    window.setContentSize(1024, 482);
    await window.webContents.executeJavaScript("document.querySelector('.app-right-sidebar-toggle').click()");
    await pause(500);
    await checkLayout('short window with right sidebar');
    assert.deepEqual(await window.webContents.executeJavaScript(`(() => {
      const toolbar = document.querySelector('#right-sidebar .subtitle-toolbar').getBoundingClientRect();
      const toggle = document.querySelector('.app-right-sidebar-toggle').getBoundingClientRect();
      return { top: toolbar.top, besideToggle: toolbar.right <= toggle.left + 1,
        hint: document.querySelector('.subtitle-hint')?.textContent };
    })()`), { top: 8, besideToggle: true, hint: 'example.srt · 1 条字幕' }, 'Toolbar sits beside the top toggle and retains imported subtitle state');
    for (const [width, height] of sizes) {
      window.setContentSize(width, height);
      await pause(120);
      await checkLayout(`expanded subtitle sidebar ${width}x${height}`);
      const ok = await window.webContents.executeJavaScript(`(async () => {
        const trigger = document.querySelector('#right-sidebar .subtitle-select .custom-select-trigger');
        trigger.click();
        await new Promise(resolve => requestAnimationFrame(resolve));
        const options = document.querySelectorAll('#right-sidebar .subtitle-select .custom-select-option');
        const labelsFit = [...options].every(option => {
          const label = option.querySelector('span');
          const style = getComputedStyle(label);
          return label.getBoundingClientRect().height <= parseFloat(style.lineHeight) + 1 &&
            label.scrollWidth <= label.clientWidth + 1;
        });
        const selected = document.querySelector('#right-sidebar .subtitle-select .custom-select-option.selected');
        const check = selected?.querySelector('.check-icon');
        const checkFits = !!check && check.getBoundingClientRect().width >= 13;
        const menu = document.querySelector('#right-sidebar .custom-select-dropdown')?.getBoundingClientRect();
        const triggerRect = trigger.getBoundingClientRect();
        const aligned = menu ? (Math.abs(menu.left - triggerRect.left) < 1 && Math.abs(menu.right - triggerRect.right) < 1) : false;
        const menuFits = menu ? (menu.left >= 0 && menu.right <= innerWidth) : false;
        const last = options[options.length - 1];
        const rect = last?.getBoundingClientRect();
        const hit = rect ? document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2) : null;
        const visible = last ? last.contains(hit) : false;
        last?.click();
        await new Promise(resolve => requestAnimationFrame(resolve));
        return aligned && labelsFit && checkFits && menuFits && visible && trigger.textContent.includes('关闭字幕') && !document.querySelector('#right-sidebar .custom-select-dropdown');
      })()`);
      assert.equal(ok, true, `Dropdown is fully visible and selectable at ${width}x${height}`);
    }
    window.setContentSize(1024, 482);
    await pause(150);
    assert.equal(await window.webContents.executeJavaScript(`(async () => {
      const toolbar = document.querySelector('#right-sidebar .subtitle-toolbar');
      const controls = [...toolbar.children].filter(element => !element.matches('input'));
      const measure = () => controls.map(element => {
        const rect = element.getBoundingClientRect();
        const parent = toolbar.getBoundingClientRect();
        return [rect.width, rect.x - parent.x, rect.y - parent.y];
      });
      const initialWidth = document.getElementById('right-sidebar').getBoundingClientRect().width;
      const baseline = measure();
      document.querySelector('.app-right-sidebar-toggle').click();
      await new Promise(resolve => requestAnimationFrame(resolve));
      if (getComputedStyle(document.getElementById('right-sidebar')).visibility !== 'visible') return false;
      if (document.getElementById('right-sidebar').getBoundingClientRect().width < initialWidth * 0.5) return false;
      for (let frame = 0; frame < 12; frame++) {
        await new Promise(resolve => requestAnimationFrame(resolve));
        if (measure().some((rect, index) => rect.some((value, axis) => Math.abs(value - baseline[index][axis]) > 1))) return false;
      }
      return true;
    })()`), true, 'Closing sidebar keeps control widths and relative positions stable');
    await pause(500);
    await checkOpeningAnimation('reopening has visible width and opacity animation');
    console.log('PASS: unclipped dropdown selection and stable sidebar collapse animation');
    for (let click = 0; click < 4; click++) {
      await window.webContents.executeJavaScript("document.querySelector('.app-right-sidebar-toggle').click()");
      await pause(55);
    }
    await pause(500);
    assert.equal(await window.webContents.executeJavaScript(`(() => {
      const panel = document.getElementById('right-sidebar');
      return panel.getBoundingClientRect().width >= 320 && getComputedStyle(panel).visibility === 'visible' &&
        getComputedStyle(document.querySelector('.right-sidebar-tools')).opacity === '1';
    })()`), true, 'Rapid reversals finish in the correct expanded state');
    window.webContents.debugger.attach('1.3');
    await window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    await pause(100);
    await window.webContents.executeJavaScript("document.querySelector('.app-right-sidebar-toggle').click()");
    await pause(50);
    assert.equal(await window.webContents.executeJavaScript(`(() => {
      const panel = document.getElementById('right-sidebar');
      return panel.getBoundingClientRect().width < 1 && getComputedStyle(panel).visibility === 'hidden';
    })()`), true, 'Reduced-motion preference closes immediately');
    await window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [] });
    window.webContents.debugger.detach();
    console.log('PASS: GSAP interruption, reversal and reduced-motion support');
    await window.webContents.executeJavaScript("document.querySelector('.app-sidebar-toggle').click()");
    await pause(500);
    await window.webContents.executeJavaScript("document.querySelector('.sidebar-settings').click()");
    await pause(200);
    assert.equal(await window.webContents.executeJavaScript(`(() => {
      const page = document.querySelector('.settings-page');
      page.scrollTop = 100;
      return page.scrollTop > 0 && getComputedStyle(page).scrollbarWidth === 'none';
    })()`), true, 'Settings remain scrollable without scrollbars');
    console.log('PASS: settings scroll without visible scrollbars');
    await window.webContents.executeJavaScript("document.querySelector('.translation-section .fetch-models').click()");
    await pause(150);
    for (const [width, height] of sizes) {
      window.setContentSize(width, height);
      await pause(120);
      const overflow: string[] = await window.webContents.executeJavaScript(`(() => {
        const selectors = ['.settings-page', '.settings-section', '.settings-form-grid', '.model-input', '.settings-actions', '.tts-text-field'];
        return selectors.filter(selector => [...document.querySelectorAll(selector)].some(element => element.clientWidth > 0 && element.scrollWidth > element.clientWidth + 1));
      })()`);
      assert.deepEqual(overflow, [], `Settings with shared model lists fit ${width}x${height}`);
    }
    window.setContentSize(1024, 482);
    console.log('PASS: translation, ASR and TTS settings fit all responsive sizes');
    await window.webContents.executeJavaScript("document.querySelector('.nav-item').click()");
    if (process.env.LINGVOICE_RESPONSIVE_DEV) await window.loadURL('http://localhost:45173');
    else await window.loadFile(path.resolve(__dirname, '../renderer/index.html'));
    window.showInactive();
    await pause(250);
    const artifacts = path.resolve(__dirname, '../../artifacts');
    await fs.mkdir(artifacts, { recursive: true });
    await fs.writeFile(path.join(artifacts, 'responsive-1024x482.png'), (await window.webContents.capturePage()).toPNG());
    clearTimeout(deadline);
    app.exit(0);
  } catch (error) {
    console.error(error);
    clearTimeout(deadline);
    app.exit(1);
  }
});
