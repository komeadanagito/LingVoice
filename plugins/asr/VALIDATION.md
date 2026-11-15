# Validation results (2026-11-14)

All implementation changes are confined to `plugins/asr/`.

## Passed

- `uv pip check`: all 69 installed packages compatible.
- Native model class imports: Qwen3ASRForConditionalGeneration and
  Qwen3ASRForTokenClassification, Transformers 5.23.0.
- torch 2.10.0+cu128 / torchaudio 2.10.0+cu128; CUDA 12.8 available.
- nagisa 0.2.11 and soynlp 0.0.493 imports passed.
- NVIDIA RTX 4070 Laptop GPU, driver 617.42, 8188 MiB total.
- Both local model/processor pairs loaded sequentially on CUDA using offline local files.
- 14/14 dependency-free HTTP/security/timestamp regression tests passed.
- End-to-end CUDA transcription and raw word alignment passed for the public LibriSpeech
  Quilter sample referenced by Qwen's official native Transformers model card.
  Assertion checks Quilter/middle/gospel, nonempty timestamps, and valid source bounds.
  `outputs/latest.json` contains the result. One adjacent-word overlap is preserved and
  explicitly reported; no snapping, interpolation, or proportional times were generated.
- The original Qwen public `asr_en.wav` conversational sample also transcribed/aligned
  successfully. It differs from the model card's Quilter reference, so the smoke fixture
  was corrected to use the explicitly referenced LibriSpeech recording.
- `requirements.lock.txt` generated after successful dependency checking and imports.

## Smoke fixture provenance

Primary: `inputs/librispeech_mr_quilter.wav`
- Source: https://huggingface.co/datasets/bezzam/audio_samples/resolve/main/librispeech_mr_quilter.wav
- SHA-256: `799f78ed4beb4de7ceae3a809262d4ce242394342ccd1d58cef7d49dbc2def46`
- Size: 187404 bytes.

Additional: `inputs/asr_en.wav`
- Source: https://qianwen-res.oss-cn-beijing.aliyuncs.com/Qwen3-ASR-Repo/asr_en.wav
- SHA-256: `f9b4440ac8393e47c14a6240e9739dea09b645bb1592b8f2dd48feb9666cea7f`
- Size: 2172458 bytes.

Sample downloads were explicit online setup actions. Runtime inference/model loading uses
local paths and offline settings only. Parent provisioning supplied model snapshots.

## Scope of validation

Validated English short recordings, CUDA model loading/inference, and dependency-free
request/safety/timestamp handling. Other languages, full-length 30-minute files, CPU
inference performance, and an external application's launcher integration were not
end-to-end tested here. Long-file offsets are implemented from source sample positions;
no full-length accuracy or speed guarantee is claimed.

## Re-run

Use this plugin's `.venv\Scripts\python.exe -I` for each:
- `server.py check --dependencies-only`
- `server.py check --load`
- `smoke.py --infer` (offline; fixture already present)
- `test_runtime.py`

Important timestamp guarantee: upstream Transformers' alignment decoder normally repairs
nonmonotonic predictions by snapping/interpolation. This plugin instead decodes the raw
learned timestamp classes, validates each word interval, and preserves/reports adjacent
word overlaps without inventing replacement timestamps.
