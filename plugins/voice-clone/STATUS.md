# Installed V5 validation status (2026-11-14)

## Completed

- Official V5 branch pinned at `e91506f1fba265e1841617c3042a1573206a7351` (`cuda_graph_accel_v5`, the branch linked in upstream README). Main's HEAD was deliberately not substituted.
- Isolated project Python 3.10 environment uses `torch==2.6.0+cu126`, `torchaudio==2.6.0+cu126`, `transformers==4.51.3`, `peft==0.17.1`, `numpy==1.26.4`. `requirements.lock` records 133 installed packages; `uv pip check` passes.
- All 11 pinned primary assets downloaded and hash-verified, total **3,175,002,462 bytes** including the archived G2PW dependency. GPT-SoVITS model repository commit: `8f8857563c040d542de108a2c18b0425abd6c9c5`; README-linked G2PW repository commit: `0c47645e02a7bc3688d7b263b0042c81e3cd82cd`.
- Both V5 Dev and V5 Turbo, shared vocoder, semantic model, BERT and HuBERT loaded successfully on the RTX 4070 Laptop GPU. Both V5 checkpoints reported all keys matched. Peak PyTorch allocation during loading: **2,322,021,376 bytes** (~2.16 GiB), which does not predict synthesis peak memory. Warm GPU load times: V5 Dev 11.44 seconds, V5 Turbo 10.27 seconds.
- V5 Turbo CPU float32 loading also passed. Per-run JSON files record device/version/timings and explicitly state that no audio was synthesized.
- G2PW, NLTK taggers/CMU dictionary, Japanese dictionary, Korean analyzer and language detector are installed locally. Text-only Chinese/English/Japanese/Cantonese/Korean frontends all passed (32/26/11/5/15 phonemes respectively). No reference voice was involved.
- Real service started on `127.0.0.1:19892`, returned `ready` with V5 Turbo/CPU from `/health`, and was stopped by the validation script. Nothing is intentionally left serving.
- Seven safety tests passed (including the offline outbound-network guard): consent must be literal true, bounded input, unknown/control fields rejected, reference paths constrained, old-version fallback prohibited, and HTTP auth/Origin/Host/body-size/control-route checks.

## Commands that succeeded

Commands below are run from this directory with its `.venv/Scripts/python.exe` and the project `../runtime/tools/uv.exe` (full absolute paths were used during execution):

- `powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1` — complete install, primary model verification and NLTK resources; after the documented dependency/resource fixes.
- `powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1 -RefreshLock -SkipModels` — explicitly add Windows Korean analyzer, validate dependencies and freeze the actual environment.
- `.venv/Scripts/python.exe prepare_models.py --models-only` — all primary assets verified and G2PW extracted.
- `.venv/Scripts/python.exe prepare_models.py --runtime-only` — local FFmpeg, verified NLTK archives, and language detector.
- `.venv/Scripts/python.exe service.py smoke --device cuda --variant v5dev` — passed.
- `.venv/Scripts/python.exe service.py smoke --device cuda --variant v5turbo` — passed.
- `.venv/Scripts/python.exe service.py smoke --device cpu` — passed.
- `.venv/Scripts/python.exe check_text.py` — all five text frontends passed.
- `.venv/Scripts/python.exe check_server.py` — real localhost readiness passed and child process stopped.
- `.venv/Scripts/python.exe test_service.py` — six tests passed, no synthesis.
- `uv pip check --python .venv/Scripts/python.exe` — all installed packages compatible.

## Compatibility issues resolved

1. Official `pyopenjtalk==0.4.1` only publishes source and failed in MSVC due the deeply nested project-local build path. Replaced explicitly with the compatible `pyopenjtalk-plus==0.4.1.post10` Windows wheel, which provides the same import. No system settings or build tools were changed. `jieba-fast` and `eunjeon` did build successfully inside the plugin's uv cache.
2. Upstream imports Matplotlib even for inference. Added it explicitly instead of installing the entire training/UI requirements set.
3. NLTK's latest downloader blocked the VPN's synthetic DNS IP as an SSRF precaution. The installer now downloads only fixed official NLTK raw URLs at pinned Git commit `550b6625bcef1f2abff2ff770a5a0d272c9c6b2a`, verifies Git blob hashes, and records SHA-256s. Archives are retained alongside extracted resources because g2p_en tests for the ZIP filenames.
4. Upstream Korean initialization tries an unqualified `pip install eunjeon` when missing. Eunjeon is now an explicit isolated install dependency, and service preflight rejects missing dependencies/resources before model initialization. No global pip installation occurred.

## Service contract / limitations

`service.py serve --device cuda --port 9873` is a standalone safe wrapper around upstream's TTS inference classes, not its unrestricted API. Only `/health` and `/tts` exist. `/tts` requires the local `state/server.token` Bearer token and explicit per-request `consent: true`; reference WAVs must be inside `references/`. Unknown fields and arbitrary model/control paths are rejected. See README for request fields and CLI contract. The CLI uses the parent's standard-library `gpu_lease.py` for cross-process GPU exclusion; dependencies stay isolated and there is no main-app wiring.

All changes, environments, downloads, caches, temporary files and generated resources from this task are under `plugins/voice-clone`. Upstream may adjust only the current process's DLL search/PATH while importing its Windows portable runtime; user/system PATH and global installations were untouched. No Ollama, vLLM, FlashAttention, training models, external reference recordings or synthesized/cloned voice outputs were installed/generated. Harmless warnings remain for jieba's deprecated pkg_resources use (setuptools is pinned below 81), the CPU ONNX runtime's CUDA preload notice, and Starlette's deprecated httpx TestClient adapter. Actual synthesis quality, latency and peak VRAM remain untested until an authorized reference recording is provided.
