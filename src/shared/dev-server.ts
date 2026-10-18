// Vite 开发服务器地址，供 `npm run dev`（Electron）与 `npm run web`（浏览器预览）共用。
// 端口刻意避开 5173、3000 等常见开发端口，减少与其它项目冲突的可能。
export const devServer = { host: 'localhost', port: 45173 } as const;

export const devServerUrl = `http://${devServer.host}:${devServer.port}/`;