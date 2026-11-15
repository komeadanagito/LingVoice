# Local GPT-SoVITS V5 plugin

This directory is an isolated Python 3.10 inference plugin. It does not modify the Electron application, use Ollama, train models, or install anything globally.

## Pinned upstream and models

- Official repository: https://github.com/RVC-Boss/GPT-SoVITS
- Branch recommended by the current official V5 README: `cuda_graph_accel_v5`
- Revision: `e91506f1fba265e1841617c3042a1573206a7351`
- Default: **V5 Turbo** (`v5turbo`, four sampling steps). Optional `--variant v5dev` uses the official V5 Dev model with 32 steps. Neither falls back to V4/V2.
- `models.manifest.json` records immutable Hugging Face commits, exact files, byte counts, official LFS SHA-256 or Git blob hashes. `models.verified.json` records SHA-256 for every completed model download.
- Models are the two V5 inference checkpoints and shared vocoder, `s1v3.ckpt` (the semantic inference model required by V5 despite its filename), Chinese HuBERT, Chinese RoBERTa, and the G2PW archive referenced by the official README. No old full bundles, training checkpoints/datasets, speaker samples, ASR models, or super-resolution models are downloaded.
- Windows compatibility: `pyopenjtalk-plus==0.4.1.post10` supplies the compatible `pyopenjtalk` import from a CPython 3.10 Windows wheel. Upstream `pyopenjtalk==0.4.1` has only a source distribution and failed its MSVC build at this project's long local path. This explicit dependency substitution avoids changing Windows settings or installing build tools. `jieba-fast` built successfully in the local uv build cache.
- `requirements.in` is a reviewed inference-only subset of upstream requirements, retaining `transformers==4.51.3` (`<5`) and compatible PEFT. Training UI, FunASR, vLLM and FlashAttention are excluded. PyTorch/Torchaudio use official CUDA 12.6 Windows wheels.

## Installation and verification

First run the parent `plugins/bootstrap.ps1` to create the project-local Python 3.10 `.venv`. Then, from PowerShell:

    powershell -NoProfile -ExecutionPolicy Bypass -File D:\a_code\code_project\LingVoice\plugins\voice-clone\install.ps1

All package/model/temp/cache writes stay under this plugin. The only executable shared with other plugins is the project `../runtime/tools/uv.exe`. Installation fails on source revision, download hash or dependency errors. Re-running resumes incomplete downloads and verifies completed files. A successful install writes `requirements.lock` from the actual environment. Subsequent installations use that lock.

Model download can run separately with `.venv\Scripts\python.exe prepare_models.py --models-only`. `--runtime-only` installs the local FFmpeg binary, NLTK dictionaries and language detector without downloading the V5 weights. NLTK resources and FFmpeg hashes are recorded in `runtime.manifest.json`; `auxiliary.manifest.json` pins the NLTK Git commit and language-detector hashes. NLTK archives are fetched from immutable official GitHub raw URLs and verified against Git blob hashes, avoiding the package downloader's false-positive DNS guard on this machine's VPN. Runtime resource preflight prevents automatic package/model downloads while serving. Use `install.ps1 -RefreshLock` only when intentionally updating dependency inputs.

Load-only smoke tests, which do **not** clone a voice:

    .venv\Scripts\python.exe service.py smoke --device cuda
    .venv\Scripts\python.exe service.py smoke --device cpu

Each successful command writes `smoke-<device>-<variant>.json`. GPU loading uses float16 and batch size one; CPU uses float32 and must be explicitly selected. CUDA unavailability is an error, not a silent CPU fallback. CUDA graphs and optional compiled acceleration are disabled to bound VRAM use on an 8 GB RTX 4070 laptop. Close unrelated GPU applications before real synthesis if memory is tight. Model loading is not a guarantee of synthesis peak VRAM or real-time speed.

## Verified installation status

Installation and locked reinstallation passed on 2026-11-14. Both V5 variants loaded on the RTX 4070 Laptop GPU; Turbo also loaded on CPU. GPU model-loading peak allocation was 2,322,021,376 bytes (~2.16 GiB). Chinese, English, Japanese, Cantonese and Korean text-only checks passed. Seven safety tests and a real localhost startup/shutdown check passed. See `STATUS.md` and `smoke-*.json` for exact results. No voice was cloned and no synthesized audio was produced.

## Local service contract

    .venv\Scripts\python.exe service.py serve --device cuda --port 9873

- Binds **only `127.0.0.1`**; there is no configurable remote host.
- `GET /health` returns readiness, engine, V5 variant, device and source revision.
- `POST /tts` requires `Authorization: Bearer <contents of state/server.token>`, `Content-Type: application/json`, and `Content-Length` <= 16 KiB. It returns `audio/wav` directly.
- Browser Origin headers are rejected; Host must match the loopback service. No CORS, API docs, upstream model switching, restart/exit control, arbitrary paths, URL references, or arbitrary output endpoints are exposed.
- One synthesis at a time; concurrent synthesis receives HTTP 429. Requests have a 500-character bound, batch size one, no auxiliary references, no super-resolution, and no streaming.
- The token is a local secret; never commit or share `state/`. Stop the process to release GPU memory.
- The CLI shares only `../gpu_lease.py`, a standard-library OS file lock, with other plugins. Python environments and model dependencies remain independent.

Request fields:

- `text`: required, 1–500 characters.
- `text_lang`: `zh` (default), `en`, `ja`, `yue`, `ko`, `all_zh`, `all_ja`, `all_yue`, `all_ko`.
- `ref_audio_path`: required path **relative to this plugin's `references/` directory**. WAV only, mono, 3–10 seconds, 16–48 kHz, <=10 MiB. Resolved paths outside that directory are rejected, including symlinks.
- `prompt_text`: required accurate transcript of the authorized reference, 1–500 characters.
- `prompt_lang`: same choices as `text_lang`, default `zh`.
- `consent`: required literal JSON `true`. Only supply recordings you own or have explicit permission to clone. This is an assertion, not automated legal verification.
- `speed_factor`: optional 0.75–1.25, default 1.0.
- `seed`: optional nonnegative integer, default 42.
- All extra fields are rejected.

CLI synthesis takes the same JSON request file and writes only inside this plugin's `outputs/` directory:

    .venv\Scripts\python.exe service.py synthesize --input D:\path\to\authorized-request.json --output speech.wav

No reference recording is included and no voice-cloning quality test is performed without an approved sample. Model checkpoints contain Python pickle state and are loaded only from pinned, official-source, hash-verified assets; do not replace them with untrusted files. Refer to the upstream and model repositories for applicable licenses and permitted uses.
