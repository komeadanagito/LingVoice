# 另一声 LingVoice · 视频下载器

Windows 桌面原型，先适配哔哩哔哩普通投稿视频。技术栈为 **TypeScript + React 19 + Vite + Electron**，TypeScript 开启严格模式，界面使用项目中的百灵鸟图标。

- 前端：React 函数组件、自定义 Hook 管理状态，Vite 提供构建和开发热更新。
- 桌面主进程、预加载脚本、下载核心及测试：均使用 TypeScript。
- 主进程与前端共享接口、事件、视频信息等类型；通过隔离的进程间通信（IPC）访问本地能力。
- 视频解析与音视频合并继续使用 yt-dlp / FFmpeg 本地组件。

## 启动

开发环境需要 **Node.js 22.12+ 或更新的 LTS 版本**（含 npm），在项目目录执行：

```powershell
npm install
npm run dev
```

`npm run dev` 启动 Vite 和 Electron，前端修改可热更新；修改主进程或预加载脚本后需要停止并重新运行。开发服务器地址为 `http://localhost:45173`，主机名和端口集中在 `src/shared/dev-server.ts`，改动后 `npm run dev`、`npm run web` 与主进程同步生效。

`npm run web` 只启动同一个开发服务器并自动打开浏览器，用于在不启动 Electron 的情况下查看界面。浏览器里没有预加载脚本，解析、下载、选择目录等本机能力由前端假数据（`src/renderer/web-mock.ts`，仅开发环境且缺少预加载脚本时加载）顶替：不会连接 B 站，也不会真正写入文件，侧栏版本号显示为 `web`，点「开始下载」只会模拟一段进度。它适合检查布局、文案和各状态样式，不能代替真实下载验证。

`npm start` 会先构建 TypeScript 和 React，再启动本地构建版本，不依赖开发服务器。

也可双击 `启动下载器.bat`。首次安装需要下载 Electron 和 FFmpeg；首次解析视频会从 yt-dlp 官方 GitHub Release 下载 `yt-dlp.exe`，并核对官方 SHA-256 校验值。请确保网络能够访问 GitHub 及其文件下载域名。该组件存储于应用用户数据目录，不会重复下载。

如果 npm 提示阻止了安装脚本，执行 `npm approve-scripts`，仅审核允许 Electron、ffmpeg-static 等本项目所需组件后重新安装。请勿盲目允许陌生包的脚本。

## Provider、字幕翻译与语音识别

### 配置服务

1. 在桌面版「设置 → 服务提供商 · Providers」添加一个 Provider（服务连接配置），填写名称、接口适配器、服务器地址和 API Key，然后保存。可以添加多个同类型服务。
2. 在「字幕翻译」选择 Provider、模型、协议和目标语言；在「语音识别 · ASR」选择 Provider、识别模型和音频语言，分别保存。两种任务可共用同一个 Provider，也可使用不同服务，地址与密钥只维护一次。
3. OpenAI 兼容适配器提供 Chat Completions、Responses、`/v1/audio/transcriptions` 及模型列表；LibreTranslate 适配器只提供机器翻译。界面按能力筛选，不能将仅支持翻译的服务绑定给 ASR。服务商实际部署的接口、语言和模型仍以其文档为准。
4. 一般填写服务的基础地址，例如 `https://api.openai.com/v1`。任务勾选「Provider 地址是完整请求地址」后不拼接接口路径；若不同任务使用不同的自定义完整路径，可建立独立 Provider。

密钥通过 Electron `safeStorage` 加密保存在用户数据目录的 `providers.json`，前端只获取密钥是否存在，不回传密钥或密文。留空保留旧密钥，也可单独清除。旧版翻译 / ASR 配置会在首次升级时导入 Provider 列表，旧文件保留作为迁移备份。正在被任务绑定的 Provider 不能直接删除，需先修改绑定。

### 从视频识别并翻译

1. 打开本地或已下载的视频，点击播放器「识别音频」。
2. 确认上传提示后，本地 FFmpeg 提取单声道 16 kHz 音频，按 5 分钟分段上传到所选 ASR Provider；分段时间戳会自动还原到视频时间轴，最长支持 6 小时。
3. OpenAI 兼容 ASR 需要支持 `verbose_json` 和 `segments` 时间戳，建议先使用 `whisper-1`。仅返回纯文本的接口 / 模型不能生成同步字幕，应用会提示失败，不会编造时间轴。
4. 识别成功后原文字幕显示在视频上，再点击「翻译字幕」生成译文。也可以直接导入 SRT / VTT 跳过识别。
5. 支持双语、仅译文、仅原文或关闭字幕，调整字号和延迟，并导出 SRT。没有译文的字幕回退到原文；字幕保存在当前会话中，请导出以长期保存。

音频 / 字幕会发送到你配置的服务，可能收费；远程服务应使用 HTTPS。ASR 支持停止：中断提取 / 当前请求，清理临时音频并停止后续分段；已经发送的请求仍可能计费。翻译停止会忽略在途结果并停止后续批次。

**当前边界**：只支持本地 / 下载后的视频；平台 iframe 无法直接读取播放时间，暂不支持同步。尚未接入平台字幕自动提取、本地离线 ASR 和配音替换。浏览器预览可导入和显示原文字幕，服务配置与识别 / 翻译需要桌面版。

### 扩展 Provider

- 共享类型与能力描述位于 `src/shared/providers.ts`；服务连接管理、密钥保存和适配器注册位于 `src/main/providers.ts`。
- 新增适配器实现 `ProviderAdapter`，通过 `ProviderRegistry.register()` 注册；声明 `translation`、`asr`、`models` 中实际支持的能力，并提供对应请求构造与结果归一化函数。Provider 类型是注册标识字符串，不是固定服务商枚举。
- 适配器元数据的 `translationOptions` 决定模型和协议配置项；服务商选项和能力筛选从注册表动态生成，播放器不判断具体服务商名称。
- 字幕翻译服务负责分批 / 校验；ASR 服务负责本地音频提取、分段、取消和时间轴；适配器负责网络协议差异。第三方 ASR 返回结构须归一化为带时间戳的 `segments`，之后由公共时间轴校验处理。
- `test/provider-integration.test.ts` 使用自定义协议验证同一个新注册的 Provider 同时驱动翻译和 ASR，无需更改播放器。

## 国际化（i18n）

「设置 → 通用」中的语言选择器支持 **简体中文（zh-CN）** 和 **English（en）**。首次使用根据系统语言选择，其他语言回退到简体中文；手动切换后将偏好写入应用用户数据目录的 `settings.json`，下次启动继续使用。语言偏好与保存目录一起保存，兼容已有的设置文件。

- 使用 `i18next` / `react-i18next`，语言资源随应用本地打包，不依赖在线翻译服务。
- 界面、占位符、辅助功能标签、下载状态、应用错误和原生对话框均支持切换。
- 切换语言不会清空已解析的视频、画质选择或正在执行的任务；当前状态与应用错误会立即重新翻译。
- 视频标题、UP 主名称、路径和 yt-dlp / 操作系统返回的原始诊断信息保留原文。

### 添加新语言

1. 在 `src/shared/i18n/locales/` 新建语言文件，导出的词条对象使用 `satisfies MessageCatalog`（类型从 `zh-CN.ts` 导入），确保键完整。动态值使用 `{{name}}` 等插值，避免拼接翻译句子。
2. 在 `src/shared/i18n/catalog.ts` 的 `languages` 中注册语言代码、该语言的自称和词条对象；语言选择器及共享 `Locale` 类型自动扩展。
3. 运行 `npm run check`、`npm test`、`npm run test:desktop`，检查词条键、插值变量和实际界面布局。新增文案须同时更新所有已注册语言，缺失的运行时词条会回退到简体中文。

React 组件通过 `useI18n()` 使用类型化的词条；主进程通过 `translate()` 翻译原生对话框。跨进程的应用错误携带词条键及插值参数，避免把已翻译的字符串固定在旧语言中。

## 使用

1. 粘贴 `https://www.bilibili.com/video/BV…`、`/video/av…` 或 `https://b23.tv/…` 链接，也可粘贴包含链接的分享文本。
2. 点击「解析视频」，确认标题、UP 主、封面、时长与可用清晰度。
3. 选择清晰度和保存位置，点击「开始下载」。默认保存到系统「下载」目录下的 `LingVoice` 文件夹。
4. 下载完成后点击「查看文件」，在资源管理器中定位文件。

- 自动下载并合并音频、视频；优先使用 MP4 容器，无法兼容时由下载组件选择 MKV。不会强制转码，因此部分 HEVC/AV1 视频需要播放器支持相应编码。
- 进度显示的是**当前媒体流**的进度。音频和视频分开下载时，进度可能从头开始；全部合并成功后才显示完成。
- 一次只进行一个解析或下载任务。支持取消任务；部分文件会保留，相同链接、画质、目录下重新下载可尝试续传，能否续传取决于视频源。
- 多分 P 视频只下载链接指定的 `?p=N`，未指定时下载第 1 P；暂不提供分 P 列表选择。
- 保存位置会记住，Cookie 选择仅在本次应用会话有效。

## 登录和隐私

公开内容通常可直接解析；平台可能对匿名用户限制画质或触发风控。你可在「登录选项」里选择自己账号导出的 **Netscape 格式 `.txt` Cookie 文件**，仅用于账号本身已经拥有访问权限的内容。没有 Cookie 时不会自动读取浏览器登录信息。

Cookie 等同账号凭证，请自行评估导出工具的可信度，并妥善保管，勿上传、分享或提交到版本库。文件路径仅保存在应用当前内存中，yt-dlp 在本机读取文件，也可能刷新、写回原 Cookie 文件。请求会连接 B 站及其视频、图片服务器；首次准备组件会连接 GitHub。应用没有自建上传服务器、遥测或账号系统。

本软件不绕过付费、会员、版权、地区限制或数字版权管理（DRM）。请仅下载你拥有版权或已获授权的内容，并遵守平台服务条款。

## 当前范围

- 适配 Windows x64；尚未验证 ARM64。
- 支持普通 B 站投稿链接和短链接。
- 暂不支持批量队列、合集、番剧、直播、平台字幕自动提取和弹幕；本地视频支持字幕导入、云端 ASR 与字幕翻译。
- 实际能否下载以及可用画质受平台接口、网络、账号权限和 yt-dlp 适配状况影响。
- 页面或接口变更后，可关闭应用，删除用户数据目录中的 `tools/yt-dlp.exe`，下次解析时重新获取官方最新版。

## 测试与打包

```powershell
npm run check        # 主进程、共享类型、React、测试与工具脚本的严格 TypeScript 类型检查
npm test             # 下载核心与前端格式化函数的离线自动化测试
npm run build        # 编译 TypeScript 并构建 React 前端到 dist
npm run test:desktop # 真实桌面、隔离通信、React 交互和错误恢复；请先关闭已启动的应用
npm run dist         # 构建并在 release 中生成 Windows 便携版 exe
npm run icon         # 从现有 SVG 重新生成 Windows 图标
```

桌面测试会在 `artifacts/desktop.png` 和 `artifacts/desktop-en.png` 保存中英文界面截图，并使用临时用户数据目录，避免改变你实际保存的语言与目录偏好。它既验证真实主进程的链接校验与错误恢复，也使用独立的离线测试窗口验证 React 视频预览、清晰度选择、下载进度、完成、取消与 Cookie 切换后的状态重置，以及语言切换、持久化与界面重载恢复。测试不会连接 B 站或下载视频，不能代替真实链接的端到端下载验证。测试脚本与模拟接口不会打包进发布程序。

便携版不需要安装 Node.js，但第一次使用仍需联网获取 yt-dlp。当前打包未配置代码签名，Windows 可能显示未知发布者提示。分发包含 FFmpeg 的软件前，请核对 FFmpeg 构建的 GPL 授权及源码提供义务；本项目尚未配置正式发布许可或完成发行合规准备。

## 文件结构

- `src/main/index.ts`：Electron 主进程、原生对话框与类型化 IPC 接口。
- `src/main/downloader.ts`：链接校验、组件准备、yt-dlp 子进程与下载管理。
- `src/main/preload.ts`：隔离的类型化界面接口，不向页面暴露 Node.js。
- `src/shared/contracts.ts`：前后端共享的请求、返回值与事件类型。
- `src/shared/dev-server.ts`：Vite 开发服务器的主机名与端口，`npm run dev` 和 `npm run web` 共用。
- `src/shared/i18n/`：共享语言注册表、中英文词条、主进程翻译及可本地化错误。
- `src/main/settings.ts`：保存目录与语言偏好的串行、原子持久化。
- `src/renderer/i18n.ts`：React 国际化实例与类型化 `useI18n()` Hook。
- `src/renderer/web-mock.ts`：浏览器预览模式的假接口，仅开发环境且没有预加载脚本时加载。
- `src/renderer/components/LanguageSwitcher.tsx`：语言切换入口。
- `src/renderer/App.tsx`、`components/`：React 主界面与组件。
- `src/renderer/hooks/useDownloader.ts`：解析、下载、进度、取消等 React 状态管理。
- `src/renderer/utils/format.ts`：前端时长与文件大小格式化。
- `src/styles.css`：桌面界面样式。
- `test/*.test.ts`：TypeScript 离线测试。
- `scripts/smoke.ts`、`scripts/fixture-preload.ts`：桌面集成测试及独立测试接口。
- `vite.config.ts`：React 开发服务器、构建与内容安全策略配置。
- `tsconfig.electron.json`、`tsconfig.renderer.json`：主进程及前端 TypeScript 严格模式配置。
- `dist/`：自动生成的编译产物，请修改 `src/` 而非该目录。
