import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { devServer } from './src/shared/dev-server';
import { browserBackend } from './scripts/browser-backend';

export default defineConfig(({ command }) => {
  const csp = command === 'serve'
    ? `default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: media: blob: https://* http://*; media-src 'self' media: blob: data: https://* http://*; connect-src 'self' ws://${devServer.host}:${devServer.port} media: blob:; frame-src https://player.bilibili.com https://www.youtube.com; object-src 'none'; base-uri 'none'; form-action 'none'`
    : "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: media: blob: https://* http://*; media-src 'self' media: blob: data:; connect-src 'self' media: blob:; frame-src https://player.bilibili.com https://www.youtube.com; object-src 'none'; base-uri 'none'; form-action 'none'";
  return {
    root: path.resolve(__dirname, 'src/renderer'),
    base: './',
    plugins: [react(), browserBackend(), { name: 'lingvoice-csp', transformIndexHtml: (html: string) => html.replace('__CSP__', csp) }],
    server: { host: devServer.host, port: devServer.port, strictPort: true },
    build: { outDir: path.resolve(__dirname, 'dist/renderer'), emptyOutDir: true },
  };
});
