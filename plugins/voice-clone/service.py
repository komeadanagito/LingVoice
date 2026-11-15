"""Safe local V5 CLI/server. Upstream model/control HTTP routes are never mounted."""
import argparse
from io import BytesIO
import json
import secrets
from pathlib import Path
import threading
import time
from local_runtime import ROOT, SOURCE_REVISION, configure, load_pipeline


class AudioQualityError(RuntimeError):
    """Bounded, user-safe acoustic validation failure (not a model crash)."""


def schema():
    from pydantic import BaseModel, ConfigDict, Field, field_validator
    from typing import Literal
    class Request(BaseModel):
        model_config = ConfigDict(extra='forbid', strict=True)
        text: str = Field(min_length=1, max_length=500)
        text_lang: Literal['zh', 'en', 'ja', 'yue', 'ko', 'all_zh', 'all_ja', 'all_yue', 'all_ko'] = 'zh'
        ref_audio_path: str = Field(min_length=1, max_length=240)
        prompt_text: str = Field(min_length=1, max_length=500)
        prompt_lang: Literal['zh', 'en', 'ja', 'yue', 'ko', 'all_zh', 'all_ja', 'all_yue', 'all_ko'] = 'zh'
        consent: Literal[True]

        @field_validator('consent', mode='before')
        @classmethod
        def require_explicit_consent(cls, value):
            if value is not True:
                raise ValueError('consent must be the literal JSON boolean true')
            return value

        speed_factor: float = Field(default=1.0, ge=0.75, le=1.25)
        seed: int = Field(default=42, ge=0, le=2147483647)
    return Request


def validate_reference(request):
    import soundfile as sf
    reference_root = (ROOT / 'references').resolve()
    supplied = Path(request.ref_audio_path)
    if supplied.is_absolute() or supplied.drive or ':' in request.ref_audio_path or request.ref_audio_path.startswith(('\\\\', '//')):
        raise ValueError('ref_audio_path must be a relative local path; URLs, drives and network shares are forbidden')
    path = (reference_root / supplied).resolve()
    if not path.is_relative_to(reference_root) or path.suffix.lower() != '.wav' or not path.is_file():
        raise ValueError('ref_audio_path must identify a WAV inside this plugin references directory')
    if path.stat().st_size > 10 * 1024 * 1024:
        raise ValueError('Reference WAV exceeds 10 MiB')
    info = sf.info(path)
    if not 3 <= info.duration <= 10 or info.channels != 1 or not 16000 <= info.samplerate <= 48000:
        raise ValueError('Reference must be mono WAV, 3–10 seconds, 16–48 kHz')
    return path


def _estimate_duration_bounds(text: str, text_lang: str, speed_factor: float):
    import re
    clean = text.strip()
    punct = len(re.findall(r'[,.;:!?，。！？；：、]', clean))
    lang = text_lang.replace('all_', '')
    if lang == 'en':
        words = re.findall(r"[A-Za-z0-9']+", clean)
        word_count = max(1, len(words))
        syllables = sum(max(1, len(re.findall(r'[aeiouyAEIOUY]+', w))) for w in words)
        min_dur = max(0.18, (word_count * 0.12) / speed_factor)
        ideal_dur = max(0.55, (syllables * 0.21 + punct * 0.12) / speed_factor)
        max_dur = max(2.20, (max(word_count * 0.48, syllables * 0.34) + punct * 0.25 + 0.85) / speed_factor)
    else:
        cjk_chars = len(re.findall(r'[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]', clean))
        latin_words = len(re.findall(r'[A-Za-z0-9]+', clean))
        units = max(1, cjk_chars + latin_words * 2)
        min_dur = max(0.28, (units * 0.10) / speed_factor)
        ideal_dur = max(0.55, (units * 0.21 + punct * 0.12) / speed_factor)
        max_dur = max(2.20, (units * 0.33 + punct * 0.25 + 0.85) / speed_factor)
    return min_dur, ideal_dur, max_dur


def _score_generated_audio(samples, rate: int, min_dur: float, ideal_dur: float, max_dur: float):
    import numpy as np
    if samples.size == 0 or rate <= 0:
        return 1000.0, False
    wav = samples.astype(np.float32)
    if np.issubdtype(samples.dtype, np.integer):
        wav = wav / 32768.0
    hop = max(1, rate // 20)  # 50 ms frames
    n_frames = len(wav) // hop
    if n_frames < 2:
        return 500.0, False
    frames = wav[:n_frames * hop].reshape(n_frames, hop)
    rms = np.sqrt(np.mean(frames * frames, axis=1))
    peak = float(np.max(rms))
    if peak < 0.012:
        return 500.0, False
    active = np.where(rms > max(0.008, peak * 0.05))[0]
    if active.size == 0:
        return 500.0, False
    first_f, last_f = int(active[0]), int(active[-1])
    active_dur = (last_f - first_f + 1) * 0.05
    active_rms = float(np.mean(rms[first_f:last_f + 1]))

    # Similar timbre/vowels are common in ordinary speech. Low-resolution spectral
    # similarity cannot distinguish repeated words from a consistent speaker, so it
    # must not reject synthesis. The caller verifies actual words with local ASR.

    penalty = 0.0
    ok = True
    if active_rms < 0.012:
        penalty += 200.0
        ok = False
    if active_dur < min_dur:
        penalty += 50.0 + (min_dur - active_dur) * 20.0
        ok = False
    if active_dur > max_dur:
        penalty += 40.0 + (active_dur - max_dur) * 15.0
        ok = False
    penalty += abs(active_dur - ideal_dur) * 0.25
    return penalty, ok


def synthesize(pipeline, request):
    import re
    import numpy as np
    import soundfile as sf
    reference = validate_reference(request)
    if getattr(pipeline, 'prompt_cache', None) is not None:
        if pipeline.prompt_cache.get('prompt_lang') != request.prompt_lang:
            pipeline.prompt_cache['prompt_text'] = None
    clean_text = re.sub(r'\s+', ' ', request.text.replace('——', ', ').replace('—', ', ').replace('–', ', ')).strip()
    if not clean_text:
        clean_text = request.text.strip()
    min_dur, ideal_dur, max_dur = _estimate_duration_bounds(clean_text, request.text_lang, request.speed_factor)
    use_multi_chunk = len(clean_text) > 220
    split_method = 'cut5' if use_multi_chunk else 'cut0'
    # Single-chunk requests run ~33% faster with the unpadded KV-cache path (parallel_infer=False).
    use_parallel = use_multi_chunk and request.speed_factor == 1.0
    attempts = [
        dict(seed=request.seed, top_k=15, top_p=0.92, temperature=0.85, repetition_penalty=1.35),
        dict(seed=(request.seed + 101) % 2147483647, top_k=12, top_p=0.90, temperature=0.82, repetition_penalty=1.42),
        dict(seed=(request.seed + 307) % 2147483647, top_k=18, top_p=0.96, temperature=0.95, repetition_penalty=1.48),
    ]
    best_audio = None
    best_rate = 48000
    best_penalty = float('inf')
    for idx, params in enumerate(attempts):
        inputs = request.model_dump(exclude={'consent'})
        inputs.update(
            text=clean_text,
            ref_audio_path=str(reference),
            batch_size=4 if use_parallel else 1,
            parallel_infer=use_parallel,
            use_cuda_graph=False,
            streaming_mode=False,
            text_split_method=split_method,
            fragment_interval=0.05,
            sample_steps=4 if pipeline.configs.version == 'v5turbo' else 32,
            super_sampling=False,
            **params,
        )
        results = list(pipeline.run(inputs))
        if not results:
            continue
        rate = results[0][0]
        audio = np.concatenate([samples for _, samples in results])
        penalty, ok = _score_generated_audio(audio, rate, min_dur, ideal_dur, max_dur)
        if penalty < best_penalty:
            best_penalty = penalty
            best_audio = audio
            best_rate = rate
        if ok:
            best_audio, best_rate = audio, rate
            break
    if best_audio is None:
        raise RuntimeError('V5 returned no audio')
    if not ok:
        raise AudioQualityError('V5 failed audio quality checks after all attempts: silent output or abnormal speech duration. Try a different clean voice reference.')
    output = BytesIO()
    sf.write(output, best_audio, best_rate, format='WAV', subtype='PCM_16')
    return output.getvalue()


def create_app(pipeline, args):
    configure()
    from fastapi import FastAPI, HTTPException, Request, Response
    RequestModel = schema()
    token_path = ROOT / 'state/server.token'
    token_path.parent.mkdir(parents=True, exist_ok=True)
    if not token_path.exists():
        token_path.write_text(secrets.token_urlsafe(32), encoding='utf-8')
    token = token_path.read_text(encoding='utf-8').strip()
    if len(token) < 32:
        raise RuntimeError('Invalid local service token')
    lock = threading.Lock()
    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)

    @app.middleware('http')
    async def protect(request: Request, call_next):
        if request.headers.get('host') not in (f'127.0.0.1:{args.port}', f'localhost:{args.port}'):
            return Response(status_code=400)
        if request.headers.get('origin') is not None:
            return Response(status_code=403)
        if request.url.path != '/health':
            supplied = request.headers.get('authorization', '')
            if not secrets.compare_digest(supplied, 'Bearer ' + token):
                return Response(status_code=401)
        if request.method == 'POST':
            if request.headers.get('transfer-encoding') is not None:
                return Response(status_code=400)
            try:
                length = int(request.headers.get('content-length', '-1'))
            except ValueError:
                return Response(status_code=400)
            if length < 0:
                return Response(status_code=411)
            if length > 16384:
                return Response(status_code=413)
            if request.headers.get('content-type', '').split(';')[0] != 'application/json':
                return Response(status_code=415)
        return await call_next(request)

    @app.get('/health')
    def health():
        return dict(status='ready', service='voice-clone', engine='GPT-SoVITS',
                    version=args.variant, device=args.device, source_revision=SOURCE_REVISION)

    # Keep inference in FastAPI's thread pool, never block its event loop.
    @app.post('/tts')
    def tts(payload: dict):
        try:
            request = RequestModel.model_validate(payload)
            validate_reference(request)
        except Exception as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        if not lock.acquire(blocking=False):
            raise HTTPException(status_code=429, detail='One synthesis is already running')
        try:
            audio = synthesize(pipeline, request)
            return Response(content=audio, media_type='audio/wav')
        except AudioQualityError as exc:
            print(f'V5 audio validation failed: {exc}', flush=True)
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        except Exception as exc:
            import traceback
            diagnostic = ROOT / 'state/last-inference-error.log'
            diagnostic.parent.mkdir(parents=True, exist_ok=True)
            diagnostic.write_text(traceback.format_exc()[-16000:], encoding='utf-8')
            traceback.print_exc()
            raise HTTPException(status_code=500, detail=f'V5 inference failed ({type(exc).__name__}); see voice-clone/state/last-inference-error.log') from exc
        finally:
            lock.release()
    return app


def serve(args):
    import uvicorn
    pipeline = load_pipeline(args.device, args.variant)
    orig_empty = getattr(pipeline, 'empty_cache', None)
    if callable(orig_empty):
        calls = 0
        def throttled_empty_cache():
            nonlocal calls
            calls += 1
            if calls % 25 == 0:
                orig_empty()
        pipeline.empty_cache = throttled_empty_cache
    app = create_app(pipeline, args)
    print(f'Local V5 service http://127.0.0.1:{args.port}; token file: {ROOT / "state/server.token"}', flush=True)
    uvicorn.run(app, host='127.0.0.1', port=args.port, workers=1, access_log=False,
                timeout_keep_alive=5, limit_concurrency=8)


def smoke(args):
    start = time.monotonic()
    pipeline = load_pipeline(args.device, args.variant)
    import torch
    result = dict(status='loaded', version=pipeline.configs.version, device=str(pipeline.configs.device),
                  torch=torch.__version__, cuda=torch.version.cuda,
                  gpu=torch.cuda.get_device_name(0) if torch.cuda.is_available() else None,
                  peak_allocated_bytes=torch.cuda.max_memory_allocated() if args.device == 'cuda' else 0,
                  seconds=round(time.monotonic() - start, 2), synthesized_audio=False,
                  source_revision=SOURCE_REVISION)
    out = ROOT / f'smoke-{args.device}-{args.variant}.json'
    out.write_text(json.dumps(result, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(result, indent=2))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=('serve', 'smoke', 'synthesize'))
    parser.add_argument('--device', choices=('cuda', 'cpu'), default='cuda')
    parser.add_argument('--variant', choices=('v5turbo', 'v5dev'), default='v5turbo')
    parser.add_argument('--port', type=int, default=9873)
    parser.add_argument('--input', type=Path)
    parser.add_argument('--output', default='speech.wav')
    args = parser.parse_args()
    if not 1024 <= args.port <= 65535:
        parser.error('port must be 1024–65535')
    if args.command == 'serve':
        serve(args)
    elif args.command == 'smoke':
        smoke(args)
    else:
        input_path = args.input.resolve() if args.input is not None else None
        configure()
        if input_path is None:
            parser.error('--input is required for synthesize')
        request = schema().model_validate_json(input_path.read_text(encoding='utf-8'))
        validate_reference(request)
        destination = (ROOT / 'outputs' / args.output).resolve()
        if not destination.is_relative_to((ROOT / 'outputs').resolve()) or destination.suffix.lower() != '.wav':
            parser.error('--output must be a WAV path inside this plugin outputs directory')
        audio = synthesize(load_pipeline(args.device, args.variant), request)
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(audio)
        print(destination)


if __name__ == '__main__':
    import sys
    sys.path.insert(0, str(ROOT.parent))
    from gpu_lease import gpu_lease
    with gpu_lease():
        main()
