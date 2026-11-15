# 本地模型插件

本目录保存独立 Python 服务、环境、模型和缓存，不使用 Ollama，不向系统 Python 安装模型依赖。目前尚未接入 Electron 界面或替换现有云端业务流程。

## 模型和隔离边界

- `asr/`：Qwen3-ASR-1.7B 和 Qwen3-ForcedAligner-0.6B。识别与强制对齐按阶段使用同一经过验证的独立环境，权重分别存放。对齐支持语言少于识别，详见该插件说明。
- `translation/`：Gemma 4 E2B 原始官方权重，通过 bitsandbytes 在加载时做 NF4 量化。下载大小不是运行时显存；原始权重不被覆盖。
- `voice-clone/`：最新 GPT-SoVITS V5；保持上游需要的资源布局，所有资源仍在项目目录内。参考该插件说明了解 v5turbo/v5dev 与推理状态。
- `runtime/`：经 SHA-256 校验的 uv、项目 Python 运行时和安装缓存。
- `installer/`：仅供下载、校验和管理进程的独立环境。

每个服务使用自己的 `.venv/Scripts/python.exe`，不能共用 `site-packages`。启动时禁用用户 site，清除继承的 PYTHONPATH/PYTHONHOME，并将模型缓存、Torch 缓存和临时文件写入项目。环境隔离避免依赖版本冲突，但不保证上游代码、驱动或模型本身没有错误，也不是恶意代码安全沙箱。系统 GPU 驱动和 Windows VC++ 运行库不由本项目隔离或修改。

## 安装与下载

在项目根目录的 PowerShell 执行，所有命令均可指定绝对脚本路径：

- 准备运行时：`powershell -NoProfile -ExecutionPolicy Bypass -File .\plugins\plugins.ps1 -Action bootstrap`
- 安装环境：`powershell -NoProfile -ExecutionPolicy Bypass -File .\plugins\plugins.ps1 -Action install`
- 下载并校验模型：`powershell -NoProfile -ExecutionPolicy Bypass -File .\plugins\plugins.ps1 -Action download`
- 仅操作单个服务：增加 `-Service asr`、`-Service translation` 或 `-Service voice-clone`。
- 检查当前实际状态：`powershell -NoProfile -ExecutionPolicy Bypass -File .\plugins\plugins.ps1 -Action check`

下载和安装阶段需要网络；推理阶段只加载本地文件。Qwen 和 Gemma 的官方仓库与固定 revision 在 `model-sources.json`。每个下载目录的 `download-manifest.json` 记录完整状态、文件大小、SHA-256 和上游 LFS 校验值。断网可重新执行同一下载命令续传；不应同时启动同一个模型的多份下载。

重新核对 Qwen/Gemma 已下载文件：`plugins\installer\.venv\Scripts\python.exe plugins\download_models.py --verify`。该操作只读本地文件，不联网。首次下载的三份主要权重及文本配置约 16.2 GB（十进制）；GPT-SoVITS 资源、Python 和 CUDA 依赖另计。请保留足够临时空间。

成功安装后各插件生成 `requirements.lock.txt`，用于记录实际通过依赖检查的版本。Torch CUDA wheel 索引在各安装脚本中明确指定，单独一份 freeze 清单不足以替代对应安装脚本。

## 启动和停止

服务以前台方式运行，终端关闭或 Ctrl+C 即停止；进程退出可可靠回收该服务持有的 GPU 显存。建议通过根管理入口启动，而不是同时手工运行多个服务：

- 启动翻译：`powershell -NoProfile -ExecutionPolicy Bypass -File .\plugins\plugins.ps1 -Action start -Service translation`
- 启动识别：同上，改为 `-Service asr`。
- 启动克隆：同上，改为 `-Service voice-clone`。
- 查看管理中的进程：`powershell -NoProfile -ExecutionPolicy Bypass -File .\plugins\plugins.ps1 -Action status`
- 在另一个终端停止：`powershell -NoProfile -ExecutionPolicy Bypass -File .\plugins\plugins.ps1 -Action stop -Service translation`

默认端口为识别 9871、翻译 9872、克隆 9873，仅监听 127.0.0.1。管理器记录进程创建时间和脚本路径，停止时验证身份，避免误杀复用 PID 的其他进程。各服务接口与鉴权请查看插件说明，不应直接暴露到局域网或公网。

8 GB 显存推荐执行顺序：分离（如需）→ ASR → 对齐 → 校对/翻译 → V5 合成；完成一个阶段后退出或卸载，再进入下一个阶段。虚拟环境隔离不会隔离 GPU 容量。`gpu_lease.py` 提供跨进程模型互斥，防止已接入该机制的服务同时加载；操作系统会在进程异常退出时释放锁。

## 翻译接口

翻译使用 `translation/service.py`：`check` 仅检查依赖和下载标记，`load` 才真正加载 GPU 模型，`infer --text "Hello" --target zh` 执行短文本推理，`serve --port 9872` 启动本地接口。

- `GET /health`：仅说明服务进程可响应，不表示模型已下载或可推理。
- `POST /status`：返回依赖、CUDA、下载和加载状态。
- `POST /infer`：JSON 包含 `task`（`translate`/`correct`）、`texts`（1–10 条），可选 `context`、`source_language`、`target_language`、`max_new_tokens`。
- `POST /unload`：卸载模型并释放 GPU 租约。

所有 POST 请求须有 `Authorization: Bearer <token>`，token 在启动后写入 `translation/.state/token`；拒绝携带 Origin 的浏览器请求。请求上限 64 KiB，文本总长上限 12000 字符，输入 token 预算 6144，输出上限 2048 token。接口串行执行，模型 JSON 输出不合格时报错，不静默丢句。

## 验证状态的含义

“下载完成”需要清单完整并通过哈希检查；“环境可用”需要依赖检查和实际 import；“加载通过”需要实际打开权重；“推理通过”还需真实输入和输出。不要将健康接口、模型配置读取或文件存在当作推理通过。

控制面离线测试：`plugins\installer\.venv\Scripts\python.exe plugins\test_plugins.py`。此测试不运行模型。

ASR 使用公开官方样例验证。GPT-SoVITS 的声音克隆推理需要有使用授权的参考音频和对应原文；缺少此类样本时只报告环境或模型加载状态，不擅自选取用户视频声音测试。

现有界面仍使用原服务配置；本轮插件部署不会自动改变应用的翻译、识别或声音克隆后端。
