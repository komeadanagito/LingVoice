import { app, BrowserWindow } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';

app.whenReady().then(async () => {
  try {
    const iconDir = path.resolve(__dirname, '../../icon');
    const svg = await fs.readFile(path.join(iconDir, 'lingvoice-logo.svg'), 'utf8');
    const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true } });
    await window.loadURL('data:text/html,<canvas id="icon" width="256" height="256"></canvas>');
    const dataUrl = await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => {
        const canvas = document.getElementById('icon');
        canvas.getContext('2d').drawImage(image, 0, 0, 256, 256);
        resolve(canvas.toDataURL('image/png'));
      };
      image.onerror = () => reject(new Error('SVG rendering failed'));
      image.src = ${JSON.stringify(`data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`)};
    })`) as string;
    const png = Buffer.from(dataUrl.split(',')[1], 'base64');
    const header = Buffer.alloc(22);
    header.writeUInt16LE(1, 2);
    header.writeUInt16LE(1, 4);
    header.writeUInt16LE(1, 10);
    header.writeUInt16LE(32, 12);
    header.writeUInt32LE(png.length, 14);
    header.writeUInt32LE(22, 18);
    await fs.writeFile(path.join(iconDir, 'lingvoice-logo.png'), png);
    await fs.writeFile(path.join(iconDir, 'lingvoice-logo.ico'), Buffer.concat([header, png]));
    console.log('Generated Windows icon from existing SVG.');
    app.exit(0);
  } catch (error) { console.error(error); app.exit(1); }
});
