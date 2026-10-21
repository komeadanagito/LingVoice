# 本地离线配音音频模块

这些模块只处理本地文件，不包含付费 API 调用，不通过 Base64 传输音频，不安装 Python 包，不选择或下载模型。主进程应把返回的本地路径保存在任务后端，渲染进程只接收任务状态或受控媒体 URL，不能直接提交任意文件系统路径执行任务。

## 准备环境（由用户或管理员完成）

1. 准备受信任的 Python 3.10 或更新环境，以及与之兼容的 `audio-separator`、PyTorch、ONNX Runtime 和该库的音频依赖。安装是独立的人工步骤；应用及检测函数从不执行 pip。建议使用专用虚拟环境，并向调用方提供其 `python.exe` 绝对路径，避免环境串用。
2. CPU 是默认且受支持的执行方式，无需 GPU。CUDA 为可选项；用户自行准备匹配的 GPU 驱动、PyTorch、ONNX Runtime CUDA 运行时。`device: 'cuda'` 在 PyTorch 无法使用 CUDA 时会给出诊断；ONNX 模型还需查看 `onnxProviders` 是否包含 `CUDAExecutionProvider`。`auto` 采用库自身的设备选择，`cpu` 强制 PyTorch 和 ONNX Runtime 使用 CPU。检测成功并不承诺特定 GPU 模型可以推理。
3. 显式配置现有 `ffmpeg-static` 可执行文件路径。Node 不需要 ffprobe。Python 子进程会临时把该可执行文件所在目录加入自己的 PATH，供库调用 `ffmpeg`，不会修改系统 PATH。
4. 从权重发布方**自行准备有权使用的、适合对白/背景两轨分离的本地模型**，保留发布方文件名，提供实际权重文件绝对路径；本模块没有默认权重，也没有“推荐但未经验证”的模型名。部分多权重/YAML 模型不适用“一个实际权重文件”入口，不能假定任意音源分离模型都兼容。
5. 在同一个模型目录准备该模型要求的完整配置、依赖权重和库的离线元数据缓存。当前适配的上游发现流程需要本地 `download_checks.json`；其他模型可能还需 YAML、hash 对应的参数或其他文件。请根据所用版本的上游说明人工准备这些文件。文件缺失时会报告路径并停止，**不会联网补全**。
6. 核对模型及所有配置来源、发布方 SHA-256、模型许可、训练数据或声音使用限制、商用与再分发权限。Windows 可用 `Get-FileHash -Algorithm SHA256 <权重路径>` 自行核验。调用时可传入 `expectedSha256`，不匹配即拒绝；如未传入，检测仍返回实际 SHA-256，但计算哈希并不等于建立可信来源。所有附属文件也需要独立核验。
7. `package.json` 的 Electron `build.extraResources` 已配置把 `scripts/audio-separation.py` 复制到应用资源目录的 `audio-separation.py`。打包后调用方应将 `helperPath` 指向 `path.join(process.resourcesPath, 'audio-separation.py')`，开发环境使用源脚本的绝对路径。ffmpeg/Python/脚本均需定位到真实可执行或可读取的磁盘文件，不要直接使用不可执行的 ASAR 内部路径。Python 环境和模型仍由用户另行准备。

模型文件和 Python 库必须受信任：某些 PyTorch 权重格式可在加载时执行代码，Python 网络防护不是针对恶意权重的安全沙箱。应使用低权限账户或额外操作系统隔离。

## 离线保证与兼容范围

Python 脚本在导入库之前启用 Python 网络审计阻断，设置常见离线环境变量，并把 `Separator.download_file_if_not_exists` 替换为“仅接受已存在且非空文件”的实现。缺少权重、元数据、参数或离线缓存时直接失败，既不安装也不下载。权重主文件在 Node 和 Python 两侧都检查存在，Python 对其计算 SHA-256。

由于 audio-separator API 和模型清单随版本变化，脚本检查 `download_file_if_not_exists` 及 `separate(custom_output_names=...)` API。与这些接口不兼容的版本会明确拒绝。环境检测检查导入、API、主权重校验、基本元数据和 CPU/GPU 状态，**不是一次实际模型加载或质量验证**；其他模型相关缓存缺失只能在真正加载时发现。检测不会试跑分离或消耗付费接口。建议集成方在自己的部署环境中固定并验证 Python 依赖版本。

默认 stem 标签为 `Vocals` / `Instrumental`，仅是库的轨道标签，不代表指定权重。可通过 `dialogueStem` / `backgroundStem` 提供所选模型的确切英文标签。模型必须实际产出两个轨道。分离人声并不保证只保留说话声：背景歌声、混响、音效泄漏或对白损失属于模型质量问题；请在正式配音前试听两轨，背景中残留原对白会造成双声。

## 主进程接口

所有路径均为绝对本地路径。输出文件或分离输出目录必须尚不存在。函数返回 Promise；通过 `signal` 取消。时间单位为秒，限制最长 7 天。

### `src/main/audio-process.ts`

- `runAudioProcess(executable, args, options?) → { stdout, stderr }`：参数数组，`shell: false`。默认超时 30 分钟，合计标准输出/错误上限 1 MiB；可配置 `timeoutMs`、`maxOutputBytes`、`signal`、`cwd`、`env`。取消/超时/超量时 Windows 使用无 shell 的 `taskkill /t /f` 终止进程树，Unix 使用独立进程组；等管道关闭再返回。输出上限最大 16 MiB。
- `readWavInfo(file) → WavInfo`：不加载完整 PCM，读取 RIFF/RF64、未知长度 FFmpeg 流式 RIFF、LIST/JUNK、PCM/IEEE float/WAVE_FORMAT_EXTENSIBLE；返回 `duration, sampleRate, channels, bitsPerSample, frames, dataBytes`。对截断、无 PCM 和不合法格式拒绝。不是任意压缩 WAV 解码器。
- `extractAudio(inputPath, outputPath, options) → WavInfo`：提取第一条音轨为 **48 kHz、双声道、16-bit PCM WAV**。
- `extractVoiceReference(dialoguePath, outputPath, start, duration, options) → WavInfo`：从分离后的对白 WAV 选取 **5–20 秒**（推荐 **10–20 秒**），生成 **24 kHz、单声道、16-bit PCM WAV**；越界拒绝。调用者应选择连续、单一说话人、低噪声的片段，模块不会自动识别说话人或判断声纹质量。
- `assertDuration(actual, expected, tolerance = 0.05)`：检查时长，单位秒。
- `atomicAudioFile(outputPath, signal, work)`：辅助函数，同文件系统私有暂存后以硬链接原子发布且不覆盖。需要支持硬链接的本地文件系统（典型为 NTFS）；不支持时失败并清理，不降级为暴露半成品的复制。
- 公共辅助类型/函数：`AudioOptions`（必填 `ffmpegPath`，其他继承 `ProcessOptions`）、`ProcessOptions`、`WavInfo`、`localFile`、`finiteSeconds`、`checkCancelled`、`ffmpegBase`。

### `src/main/audio-separation.ts`

- `detectSeparationEnvironment(options: SeparationOptions) → SeparationEnvironment`：返回 `ready, diagnostics`，可用时包括 `pythonVersion, separatorVersion, cudaAvailable, onnxProviders, modelSha256`。缺失程序、库、权重或缓存给出可操作诊断。调用取消仍抛出。
- `separateAudio(inputPath, outputDirectory, options) → { dialoguePath, backgroundPath, duration }`：输入为已提取 WAV。两轨分别检查原始时长与归一化后时长，误差超过 **50 ms** 拒绝；输出统一为 48 kHz 双声道 16-bit PCM。只在两个轨道都完成且校验通过后原子发布整个新目录。
- `SeparationOptions extends AudioOptions`：必填 `pythonPath, helperPath, modelPath`，可选 `expectedSha256, device: 'cpu' | 'auto' | 'cuda', dialogueStem, backgroundStem`。默认 CPU；默认环境检测 90 秒，分离 2 小时。外层可设置 `timeoutMs` 覆盖每次子进程的期限。

### `src/main/audio-alignment.ts`

- `AudioSegment = { filePath: string; start: number; end: number }`，`start/end` 是**原视频绝对时间**，不把前一段结束时间累加为后一段起点。
- `planAlignment(sourceDuration, start, end) → { start, end, duration, tempo, padding }`：短于槽位只尾补静音，不减速。超长不超过 **15%** 时使用保音高 `atempo`；恰好 15% 允许，超过即拒绝，要求重新生成较短语音或修改时间。不会通过删掉超长语音末尾来掩盖问题。
- `alignAudio(segment, outputPath, options) → AudioSegment & { info, plan }`：输入为 PCM WAV，输出为槽位长度的 48 kHz 双声道 16-bit PCM WAV。按照 48 kHz 采样边界四舍五入；转换后的 `apad/atrim` 只用于得到精确目标样本数。FFmpeg 的 atempo 有窗口边界/尾部行为，应对转换后的语音试听。

### `src/main/audio-mix.ts`

- `buildAudioTimeline(segments, duration) → TimelinePiece[]`：排序并验证不重叠、不超出总时长，显式生成前导、段间及末尾静音。最多 10000 段，时间量化到 48 kHz 采样边界。
- `mixDubbedVideo(request, options) → { outputPath, duration }`，其中 request 为 `{ videoPath, backgroundPath, segments, duration, outputPath, backgroundGain?, dialogueGain? }`。`segments` 必须为 `alignAudio` 的输出，包含与槽位严格匹配的帧数；`duration` 应来自原始提取 WAV，背景与其时长误差最多 50 ms。增益范围 0–4，默认各 1。
- 使用私有安全相对文件名与 ffconcat 清单构造完整配音轨，使用滤镜脚本混合背景与配音，避免随段数增长的 Windows 命令行参数。没有段落时生成全静音配音轨。PCM 混音以 `alimiter` 限制峰值至 0.95，关闭自动补增益，并补偿限制器延迟。
- 输出必须为 `.mkv`：仅映射第一条视频流并 `-c:v copy`，新配音编码为 AAC 192 kbps。不复制原音轨、字幕、附件或其他视频流。限定总时长但视频帧不重新编码，时间精度受原视频帧/时间基约束。MKV 提高常见视频编码的兼容性，但不是对任意损坏或特殊流的承诺。AAC 编码可能产生微小延迟或重建峰值，限制器不等同于成品真峰值/响度母带处理。

## 调用顺序

主进程为一次任务建立独立、非共享的本地输出目录并维护同一个 `AbortController`：先 `detectSeparationEnvironment`，通过后 `extractAudio` → `separateAudio` → `extractVoiceReference`；语音合成在本模块之外完成，随后逐段 `alignAudio`，最后 `mixDubbedVideo`。输出成功后再更新任务状态和对外的媒体路径，失败/取消不发布暂存文件。输出路径与任务身份、导出目录的权限检查由调用方完成；不要让不同任务竞争同一输出目录。

中间文件保留/清理由任务管理层决定。每个函数会清理自己创建的私有暂存目录，但不会删除调用方先前已成功产生的 WAV 或分离目录。没有自动磁盘配额：长媒体的 PCM、分段复制与混音暂存需要较大空间，请在调度层检查可用空间并限制并发。每次子进程都有期限；整个多段任务的总期限应由外层 AbortSignal 管理。

## 验证

`npx tsx --test test/audio-processing.test.ts` 包含参数/时间边界、15% 阈值、绝对时间线、PCM/流式 WAV/RF64、失败原子清理、已有输出不覆盖、日志上限、超时、取消及真实 ffmpeg 小样本的参考音频 5/20 秒边界、9 秒合法输入、低于 5 秒与高于 20 秒拒绝、提取/参考/保音高加速/补静音/视频复制混音验证。真实分离需要用户已准备且许可允许的模型，不在单元测试中下载或执行未经授权的权重。
