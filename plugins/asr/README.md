# Local Qwen3 ASR plugin

Independent Python 3.12 runtime, native Hugging Face Transformers inference, no Ollama,
vLLM, flash-attn, model compilation, or runtime downloads. Files and installation are
confined to this plugin; the shared launcher is managed separately.

## Installation and model provisioning

Run `powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1` from this folder.
It uses `..\runtime\tools\uv.exe` with this plugin's absolute `.venv\Scripts\python.exe`,
installs matching `torch==2.10.0` / `torchaudio==2.10.0` CUDA 12.8 wheels from the official
PyTorch index and `transformers==5.23.0`. Other direct dependencies are in `requirements.in`.
`requirements.lock.txt` is generated only after dependency consistency and native model
class imports succeed. `install.ps1 -UseLock` installs that validated environment.
No global PATH, registry, or persistent environment variables are modified. Installation
requires internet; normal operation does not. An NVIDIA driver compatible with CUDA 12.8
is required; no separate CUDA compiler/toolkit is needed. Setup may use several GB of disk.

The parent provisioning process supplies complete local snapshots, including processors,
tokenizers, configs and all safetensors shards, at these exact locations:

- `models/qwen3-asr-1.7b`: `Qwen/Qwen3-ASR-1.7B-hf`, revision `bcd2b5b7f32b480ab5790554cfa8347f246a14f3`.
- `models/qwen3-forced-aligner-0.6b`: `Qwen/Qwen3-ForcedAligner-0.6B-hf`, revision `c07281df297b9905d24a508279258cccf987a064`.

This plugin never downloads weights. `check` distinguishes missing dependencies (exit 2,
`missing_dependencies`) from missing/incomplete weights (exit 3, `missing_weights`). Other
failures use exit 1 and an explicit JSON error. Presence checks are preliminary; `--load`
actually validates loading both model/processor pairs and detects corrupt weights/configs.
Model revision integrity is the provisioning process's responsibility.

## CLI and launcher contract

Use the absolute plugin interpreter with `-I` (isolated mode), not a global Python:

- `.\.venv\Scripts\python.exe -I .\server.py --port 9871`: foreground server, fixed `127.0.0.1` binding.
- `.\.venv\Scripts\python.exe -I .\server.py check --dependencies-only`: imports, versions and CUDA status; no weights needed.
- `.\.venv\Scripts\python.exe -I .\server.py check`: dependencies and local weight presence.
- `.\.venv\Scripts\python.exe -I .\server.py check --load`: sequential actual processor/model loading.
- `.\.venv\Scripts\python.exe -I .\server.py infer asr_en.wav --language English`: CUDA transcription and real word alignment.
- Add `--no-align` for ASR-only languages, `--device cpu` for explicit slow CPU fallback,
  `--chunk-seconds 20` (range 5–30), or `--max-new-tokens 512` (range 64–1024).

Launch with the venv's absolute executable and absolute `server.py` path; working directory
is irrelevant. Remove inherited `PYTHONPATH`/`PYTHONHOME` from the child environment and set
`PYTHONNOUSERSITE=1`. `-I` additionally ignores inherited Python settings before startup.
`server.py` sets offline Hugging Face flags and plugin-local HF, Torch, Numba, XDG, uv and
temporary paths before ML imports. The launcher should terminate the child normally;
there are deliberately no remote shutdown/reload/install/control endpoints.

## HTTP API

`GET http://127.0.0.1:9871/health` returns service liveness only (not model readiness).
`POST /infer` accepts `Content-Type: application/json` and at most 16 KiB, with fields:

- `audio_path` (required): filename relative to `inputs/`, or absolute path resolving
  inside that same directory. Escapes, remote URLs and paths elsewhere are rejected.
- `language`: optional supported ASR language name/code; null means detection.
- `align`: boolean, default true.
- `chunk_seconds`: finite number 5–30, default 20.
- `max_new_tokens`: integer 64–1024, default 512; reaching it fails rather than silently truncating.
- `prompt`: optional context/hotwords, maximum 2000 characters.
- `device`: `cuda` (default) or explicit `cpu`.

Example PowerShell native request (put the sample inside `inputs/` first):
`Invoke-RestMethod http://127.0.0.1:9871/infer -Method Post -ContentType application/json -Body '{"audio_path":"asr_en.wav","language":"English","align":true}'`

Response contains `status`, `text`, `duration`, `aligned`, `timestamp_source` and `segments`.
Each segment has absolute `start`/`end` seconds, `text`, `language`, and `words`; every word
has `text`, `start`, `end` in absolute source-audio seconds. Segment bounds are processing
chunk bounds, not claimed speech boundaries. ASR-only responses have empty word arrays
and `timestamp_source: "none"`. Successful results are also atomically written to fixed
`outputs/latest.json`, replacing the previous result. Audio itself is not exposed over HTTP.
Errors are JSON with `error` and `message` (400 invalid input/language, 503 missing runtime
requirements/CUDA, 500 inference errors). Endpoint and security errors have `error` only.

The synchronous stdlib server and inference lock serialize GPU work. It rejects browser
Origin/fetch headers and unexpected Host values, has no CORS, no static file serving, no
uploads and no control API. It is intended for trusted same-machine desktop clients, not
as an authenticated multi-user service. A client can wait for a long inference; use an
appropriate client timeout. HTTP input reads have a 15-second timeout.

## Resource limits and timestamps

Supported libsndfile audio (WAV recommended) must be at most 512 MiB, >0 and <=1800 seconds,
8–192 kHz, 1–8 channels. Metadata is checked before decoding. Audio is downmixed and
resampled to 16 kHz in bounded chunks, batch size one. Default chunks are 20 seconds.
Temporary WAV chunks live under `tmp/` and are deleted on success or exception.
ASR runs over chunks first, then all ASR tensors/model references are deleted, Python GC
runs, and the CUDA allocator cache is emptied before the aligner is loaded. The models
are never intentionally resident together. BF16 + SDPA targets the RTX 4070 8 GB; CPU uses
FP32. Reduce chunk length if GPU allocation fails. There is no automatic OOM retry.

Alignment supports exactly Chinese, English, Cantonese, French, German, Italian, Japanese,
Korean, Portuguese, Russian and Spanish (codes zh/en/yue/fr/de/it/ja/ko/pt/ru/es).
Japanese needs nagisa and Korean soynlp, included in installation. Unsupported requested
or detected alignment languages fail explicitly; use `align=false` instead. Timestamps
come only from learned timestamp-class predictions (using the processor's milliseconds-per-class
scale) plus each chunk's source sample offset. Transformers' upstream decoder normally
repairs outliers by snapping/interpolation; this plugin decodes the raw classes directly
instead. Each word must have a valid in-range start/end interval. Overlaps between adjacent
words are preserved without adjustment and counted in each segment's `alignment_overlap_count`.
`timestamp_postprocessing` is `none`. No proportional, interpolated or invented word timestamps
are produced.
Invalid model timestamps fail rather than being replaced. Hard chunk boundaries may
split words; chunking is bounded preprocessing, not a VAD-based quality guarantee.
Optional E2B original-text correction remains an external downstream operation; it is
not implemented here and does not enable networking or replace measured timestamps.

## Validation

- `.\.venv\Scripts\python.exe -I .\test_runtime.py`: dependency-free safety/HTTP tests.
- `.\.venv\Scripts\python.exe -I .\smoke.py --fetch-sample`: **explicit online setup only**;
  downloads the public `librispeech_mr_quilter.wav` recording referenced by Qwen's official
  model card to `inputs/`, recording URL, size,
  and SHA-256 in `inputs/librispeech_mr_quilter.source.json`. No weights are downloaded.
- `.\.venv\Scripts\python.exe -I .\smoke.py --load`: offline real loading.
- `.\.venv\Scripts\python.exe -I .\smoke.py --infer`: offline CUDA sample transcription
  and alignment, checks Quilter/middle/gospel and nonempty bounded model timestamps.

Native API references independently inspected during implementation:
https://huggingface.co/Qwen/Qwen3-ASR-1.7B-hf/blob/main/README.md and
https://huggingface.co/Qwen/Qwen3-ForcedAligner-0.6B-hf/blob/c07281df297b9905d24a508279258cccf987a064/README.md.
The older aligner card recommends source Transformers; the selected release is instead
verified by importing both native Qwen3 classes and actual offline model loading.
