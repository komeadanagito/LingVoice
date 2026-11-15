"""Offline Qwen3 ASR CLI and loopback-only JSON HTTP service (Python 3.12)."""
from __future__ import annotations

import argparse
import gc
import importlib.metadata
import json
import math
import os
from pathlib import Path
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT.parent))
from gpu_lease import gpu_lease
from functools import wraps
if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')
if hasattr(sys.stderr, 'reconfigure'):
    sys.stderr.reconfigure(encoding='utf-8')
for key in ('PYTHONPATH', 'PYTHONHOME'):
    os.environ.pop(key, None)
for key, value in {
    'PYTHONNOUSERSITE': '1', 'HF_HUB_OFFLINE': '1', 'TRANSFORMERS_OFFLINE': '1',
    'HF_HUB_DISABLE_TELEMETRY': '1', 'DO_NOT_TRACK': '1',
    'HF_HOME': str(ROOT / 'cache/huggingface'), 'TORCH_HOME': str(ROOT / 'cache/torch'),
    'HF_HUB_CACHE': str(ROOT / 'cache/huggingface/hub'),
    'HUGGINGFACE_HUB_CACHE': str(ROOT / 'cache/huggingface/hub'),
    'HF_DATASETS_CACHE': str(ROOT / 'cache/huggingface/datasets'),
    'HF_ASSETS_CACHE': str(ROOT / 'cache/huggingface/assets'),
    'XDG_CACHE_HOME': str(ROOT / 'cache'), 'UV_CACHE_DIR': str(ROOT / 'cache/uv'),
    'NUMBA_CACHE_DIR': str(ROOT / 'cache/numba'),
    'TEMP': str(ROOT / 'tmp'), 'TMP': str(ROOT / 'tmp'),
}.items():
    os.environ[key] = value
for name in ('inputs', 'outputs', 'tmp', 'cache'):
    (ROOT / name).mkdir(parents=True, exist_ok=True)
tempfile.tempdir = str(ROOT / 'tmp')
MODELS = {'asr': ROOT / 'models/qwen3-asr-1.7b', 'aligner': ROOT / 'models/qwen3-forced-aligner-0.6b'}
LANGUAGES = dict(zip(('zh', 'en', 'yue', 'fr', 'de', 'it', 'ja', 'ko', 'pt', 'ru', 'es'),
                     ('Chinese', 'English', 'Cantonese', 'French', 'German', 'Italian', 'Japanese', 'Korean', 'Portuguese', 'Russian', 'Spanish')))
LOCK = threading.Lock()
MAX_BODY = 16384


class PluginError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def fail(code, message):
    raise PluginError(code, message)


_DEPS_CACHE = None
_WEIGHTS_CACHE = None


def dependencies():
    global _DEPS_CACHE
    if _DEPS_CACHE is not None:
        return _DEPS_CACHE
    try:
        import torch
        import torchaudio
        import soundfile
        import scipy
        import nagisa
        import soynlp
        from transformers import AutoProcessor, Qwen3ASRForConditionalGeneration, Qwen3ASRForTokenClassification
        _DEPS_CACHE = {'torch': torch.__version__, 'torchaudio': torchaudio.__version__,
                       'nagisa': importlib.metadata.version('nagisa'), 'soynlp': importlib.metadata.version('soynlp'),
                       'transformers': importlib.metadata.version('transformers'),
                       'cuda_available': torch.cuda.is_available(), 'cuda_runtime': torch.version.cuda,
                       'gpu': torch.cuda.get_device_name(0) if torch.cuda.is_available() else None}
        return _DEPS_CACHE
    except Exception as exc:
        fail('missing_dependencies', f'{type(exc).__name__}: {exc}')


def weights():
    global _WEIGHTS_CACHE
    if _WEIGHTS_CACHE is not None:
        return _WEIGHTS_CACHE
    missing = []
    for name, path in MODELS.items():
        if not (path / 'config.json').is_file() or not list(path.glob('*.safetensors')):
            missing.append(str(path))
            continue
        indexes = list(path.glob('*.safetensors.index.json'))
        for index in indexes:
            data = json.loads(index.read_text(encoding='utf-8'))
            if any(not (path / shard).is_file() for shard in set(data['weight_map'].values())):
                missing.append(str(path) + ' (incomplete shards)')
    if missing:
        fail('missing_weights', 'Local model weights missing/incomplete: ' + '; '.join(missing))
    _WEIGHTS_CACHE = {key: str(value) for key, value in MODELS.items()}
    return _WEIGHTS_CACHE


def check(dependencies_only=False, load=False):
    result = {'status': 'ok', 'dependencies': dependencies()}
    if not dependencies_only:
        result['models'] = weights()
    if load:
        for name in MODELS:
            load_probe(name)
        result['load'] = 'both models loaded sequentially'
    return result


def release():
    import torch
    gc.collect()
    if torch.cuda.is_available():
        torch.cuda.empty_cache()


_MODEL_CACHE = {'key': None, 'processor': None, 'model': None}
_RESIDENT_LEASE = None
KEEP_MODEL_RESIDENT = False


def unload_cached_model(drop_lease=False):
    global _RESIDENT_LEASE
    had_model = _MODEL_CACHE['model'] is not None or _MODEL_CACHE['processor'] is not None
    _MODEL_CACHE['key'] = None
    _MODEL_CACHE['processor'] = None
    _MODEL_CACHE['model'] = None
    if had_model:
        release()
    if drop_lease and _RESIDENT_LEASE is not None:
        try:
            _RESIDENT_LEASE.__exit__(None, None, None)
        finally:
            _RESIDENT_LEASE = None


def load_model(name, device):
    import torch
    from transformers import AutoProcessor, Qwen3ASRForConditionalGeneration, Qwen3ASRForTokenClassification
    cls = Qwen3ASRForConditionalGeneration if name == 'asr' else Qwen3ASRForTokenClassification
    path = str(MODELS[name])
    processor = AutoProcessor.from_pretrained(path, local_files_only=True, trust_remote_code=False)
    model = cls.from_pretrained(path, local_files_only=True, trust_remote_code=False,
                                dtype=torch.bfloat16 if device == 'cuda' else torch.float32,
                                attn_implementation='sdpa').to(device).eval()
    return processor, model


def get_model(name, device):
    if KEEP_MODEL_RESIDENT:
        key = (name, device)
        if _MODEL_CACHE['key'] == key and _MODEL_CACHE['model'] is not None:
            return _MODEL_CACHE['processor'], _MODEL_CACHE['model']
        unload_cached_model(drop_lease=False)
        processor, model = load_model(name, device)
        _MODEL_CACHE['key'] = key
        _MODEL_CACHE['processor'] = processor
        _MODEL_CACHE['model'] = model
        return processor, model
    return load_model(name, device)


def gpu_guard(action):
    @wraps(action)
    def guarded(*args, **kwargs):
        global _RESIDENT_LEASE
        if KEEP_MODEL_RESIDENT:
            if _RESIDENT_LEASE is None:
                lease = gpu_lease()
                try:
                    lease.__enter__()
                except RuntimeError as exc:
                    fail('gpu_busy', str(exc))
                _RESIDENT_LEASE = lease
            try:
                return action(*args, **kwargs)
            except Exception:
                if _MODEL_CACHE['model'] is None:
                    unload_cached_model(drop_lease=True)
                raise
        lease = gpu_lease()
        try:
            lease.__enter__()
        except RuntimeError as exc:
            fail('gpu_busy', str(exc))
        try:
            return action(*args, **kwargs)
        finally:
            lease.__exit__(None, None, None)
    return guarded


@gpu_guard
def load_probe(name):
    import torch
    processor = model = None
    try:
        processor, model = load_model(name, 'cuda' if torch.cuda.is_available() else 'cpu')
    finally:
        del processor, model
        release()


def bounded_number(value, name, low, high, integer=False):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        fail('invalid_request', f'{name} must be a finite number')
    if not low <= value <= high or (integer and not isinstance(value, int)):
        fail('invalid_request', f'{name} must be within {low}..{high}' + (' (integer)' if integer else ''))
    return value


def input_path(value):
    if not isinstance(value, str) or not value or len(value) > 1024:
        fail('invalid_request', 'audio_path must be a local path within inputs/')
    path = Path(value)
    path = (ROOT / 'inputs' / path).resolve() if not path.is_absolute() else path.resolve()
    if not path.is_relative_to((ROOT / 'inputs').resolve()) or not path.is_file():
        fail('invalid_request', 'audio_path must resolve to an existing file within inputs/')
    if path.stat().st_size > 512 * 1024 * 1024:
        fail('invalid_audio', 'Maximum audio file size is 512 MiB')
    return path


def decode_raw_word_times(classes, words, milliseconds):
    """Decode learned timestamp classes without upstream snapping/interpolation."""
    if not words or len(classes) != 2 * len(words):
        fail('alignment_failed', 'Aligner timestamp count does not match the word list')
    result = []
    overlaps = 0
    previous_end = 0.0
    for index, word in enumerate(words):
        begin = round(classes[2 * index] * milliseconds / 1000, 3)
        finish = round(classes[2 * index + 1] * milliseconds / 1000, 3)
        if not (math.isfinite(begin) and math.isfinite(finish) and 0 <= begin <= finish):
            fail('alignment_failed', 'Aligner predicted an invalid within-word interval; repair is disabled')
        if begin < previous_end:
            overlaps += 1
        result.append({'text': word, 'start_time': begin, 'end_time': finish})
        previous_end = finish
    return result, overlaps


@gpu_guard
def infer(request):
    if not isinstance(request, dict):
        fail('invalid_request', 'JSON object required')
    allowed = {'audio_path', 'language', 'align', 'chunk_seconds', 'max_new_tokens', 'prompt', 'device'}
    if set(request) - allowed:
        fail('invalid_request', 'Unknown request fields: ' + ', '.join(sorted(set(request) - allowed)))
    path = input_path(request.get('audio_path'))
    chunk_seconds = bounded_number(request.get('chunk_seconds', 20), 'chunk_seconds', 5, 30)
    max_tokens = bounded_number(request.get('max_new_tokens', 512), 'max_new_tokens', 64, 1024, True)
    align = request.get('align', True)
    if not isinstance(align, bool):
        fail('invalid_request', 'align must be boolean')
    language = request.get('language')
    if language is not None and (not isinstance(language, str) or len(language) > 40):
        fail('invalid_request', 'language must be null or a language name/code')
    language = LANGUAGES.get(language, language)
    if align and language and language not in LANGUAGES.values():
        fail('unsupported_alignment_language', 'Alignment supports only: ' + ', '.join(LANGUAGES.values()))
    prompt = request.get('prompt', '')
    if not isinstance(prompt, str) or len(prompt) > 2000:
        fail('invalid_request', 'prompt must be a string of at most 2000 characters')
    device = request.get('device', 'cuda')
    if device not in ('cuda', 'cpu'):
        fail('invalid_request', 'device must be cuda or cpu')
    dependencies()
    weights()
    import torch
    import numpy as np
    import soundfile as sf
    from scipy.signal import resample_poly
    if device == 'cuda' and not torch.cuda.is_available():
        fail('cuda_unavailable', 'CUDA is unavailable; use device=cpu explicitly for slow CPU inference')
    try:
        info = sf.info(str(path))
        duration = info.frames / info.samplerate
        if not 0 < duration <= 1800 or not 8000 <= info.samplerate <= 192000 or not 1 <= info.channels <= 8:
            fail('invalid_audio', 'Audio must be >0 and <=1800 seconds, 8-192 kHz, 1-8 channels')
    except PluginError:
        raise
    except Exception as exc:
        fail('invalid_audio', str(exc))
    segments = []
    processor = model = inputs = output = generated = None
    # Disk-backed chunks keep source audio and speech data inside the plugin.
    with tempfile.TemporaryDirectory(dir=ROOT / 'tmp') as tmp:
        chunks = []
        resampled_parts = []
        divisor = math.gcd(info.samplerate, 16000)
        up_rate = 16000 // divisor
        down_rate = info.samplerate // divisor
        with sf.SoundFile(str(path)) as source:
            block_frames = int(60 * info.samplerate)
            while True:
                block = source.read(block_frames, dtype='float32', always_2d=True)
                if not len(block):
                    break
                mono = block.mean(axis=1)
                if not np.isfinite(mono).all():
                    fail('invalid_audio', 'Audio contains nonfinite samples')
                if info.samplerate != 16000:
                    mono = resample_poly(mono, up_rate, down_rate).astype(np.float32, copy=False)
                resampled_parts.append(mono)
        full_audio = np.concatenate(resampled_parts) if resampled_parts else np.zeros(0, dtype=np.float32)
        del resampled_parts
        total_16k = len(full_audio)
        frame_samples = 800  # 50 ms at 16 kHz
        n_frames = total_16k // frame_samples
        target_max = min(float(chunk_seconds), 14.0) if align else float(chunk_seconds)
        min_chunk = min(5.5, target_max * 0.45)

        if n_frames >= 10:
            trimmed = full_audio[:n_frames * frame_samples].reshape(n_frames, frame_samples)
            rms = np.sqrt(np.mean(trimmed * trimmed, axis=1))
            noise_floor = float(np.percentile(rms, 10))
            speech_peak = float(np.percentile(rms, 90))
            silence_thresh = (
                max(0.003, noise_floor + (speech_peak - noise_floor) * 0.14)
                if speech_peak > max(0.004, noise_floor * 2.2)
                else 0.0
            )
        else:
            rms = np.zeros(0, dtype=np.float32)
            silence_thresh = 0.0

        def add_chunk(start_sample: int, end_sample: int):
            start_sample = max(0, min(total_16k, start_sample))
            end_sample = max(start_sample, min(total_16k, end_sample))
            if end_sample - start_sample < 160:
                return
            chunk_path = Path(tmp) / f'{len(chunks):04}.wav'
            sf.write(str(chunk_path), full_audio[start_sample:end_sample], 16000, subtype='FLOAT')
            chunks.append((chunk_path, round(start_sample / 16000, 4), round(end_sample / 16000, 4)))

        if silence_thresh > 0.0 and n_frames >= 10:
            is_voiced = rms >= silence_thresh
            pad_frames = 3  # 150 ms pre/post-roll around active speech
            max_frames = max(int(round(target_max * 20)), 100)
            min_frames = max(int(round(min_chunk * 20)), 40)
            pause_split_frames = 14  # 700 ms silence splits clean utterance chunks
            idx = 0
            while idx < n_frames:
                while idx < n_frames and not is_voiced[idx]:
                    idx += 1
                if idx >= n_frames:
                    break
                c_start = max(0, idx - pad_frames)
                last_voiced = idx
                silent_run = 0
                pos = idx + 1
                cut_frame = None
                while pos < n_frames:
                    if is_voiced[pos]:
                        last_voiced = pos
                        silent_run = 0
                    else:
                        silent_run += 1
                    span = pos - c_start + 1
                    if (silent_run >= pause_split_frames and (last_voiced - c_start + 1) >= min_frames) or (silent_run >= 24 and (last_voiced - c_start + 1) >= 8):
                        cut_frame = min(n_frames, last_voiced + 1 + pad_frames)
                        break
                    if span >= max_frames:
                        search_lo = max(c_start + min_frames, pos - 80)
                        best_pos = pos
                        best_energy = float('inf')
                        for cand in range(search_lo, pos - 2):
                            e = float(np.mean(rms[cand:cand + 4]))
                            if e < best_energy:
                                best_energy = e
                                best_pos = cand + 2
                        cut_frame = best_pos
                        break
                    pos += 1
                if cut_frame is None:
                    cut_frame = min(n_frames, last_voiced + 1 + pad_frames)
                    next_idx = n_frames
                else:
                    next_idx = max(cut_frame, pos) if silent_run >= pause_split_frames else cut_frame
                end_sample = total_16k if cut_frame >= n_frames and (total_16k - n_frames * frame_samples) > 0 and is_voiced[-1] else cut_frame * frame_samples
                add_chunk(c_start * frame_samples, end_sample)
                idx = next_idx
            if not chunks and total_16k > 0:
                add_chunk(0, total_16k)
        else:
            step = int(target_max * 16000)
            for s in range(0, total_16k, step):
                add_chunk(s, min(total_16k, s + step))
        del full_audio
        try:
            processor, model = get_model('asr', device)
            for chunk, start, end in chunks:
                inputs = processor.apply_transcription_request(audio=str(chunk), language=language, prompt=prompt).to(device, model.dtype)
                with torch.inference_mode():
                    output = model.generate(**inputs, max_new_tokens=max_tokens, do_sample=False)
                generated = output[:, inputs['input_ids'].shape[1]:]
                if generated.shape[1] >= max_tokens:
                    fail('generation_limit', 'Token limit reached; use shorter chunks or a larger max_new_tokens')
                parsed = processor.decode(generated, return_format='parsed')[0]
                segments.append({'start': start, 'end': end, 'text': parsed['transcription'],
                                 'language': language or parsed.get('language'), 'words': [], 'alignment_overlap_count': 0})
        finally:
            if KEEP_MODEL_RESIDENT:
                del processor, model, inputs, output, generated
            else:
                del processor, model, inputs, output, generated
                release()
        if align:
            for segment in segments:
                if segment['text'] and segment['language'] not in LANGUAGES.values():
                    fail('unsupported_alignment_language', f"Cannot align detected language {segment['language']!r}; request align=false for transcription only")
            processor = model = inputs = output = raw = mask = None
            try:
                processor, model = get_model('aligner', device)
                for (chunk, start, end), segment in zip(chunks, segments):
                    if not segment['text'].strip():
                        continue
                    inputs, word_lists = processor.prepare_forced_aligner_inputs(
                        audio=str(chunk), transcript=segment['text'], language=segment['language'])
                    if not word_lists or not word_lists[0]:
                        continue
                    inputs = inputs.to(device, model.dtype)
                    with torch.inference_mode():
                        output = model(**inputs)
                    # Adjacent words can overlap. Preserve those measured predictions
                    # rather than running the native decoder's interpolation repair.
                    mask = inputs['input_ids'][0] == model.config.timestamp_token_id
                    raw = output.logits.argmax(dim=-1)[0][mask]
                    try:
                        classes = raw.tolist()
                        try:
                            words, overlaps = decode_raw_word_times(classes, word_lists[0], processor.timestamp_segment_time)
                        except PluginError as first_exc:
                            if first_exc.code != 'alignment_failed' or len(classes) != 2 * len(word_lists[0]):
                                raise
                            # Rescue isolated minor within-word inversions (e.g. a 1-frame swap on a short particle)
                            # without discarding valid timestamps for the rest of the chunk.
                            repaired = list(classes)
                            repaired_count = 0
                            for wi in range(len(word_lists[0])):
                                b_cls, f_cls = repaired[2 * wi], repaired[2 * wi + 1]
                                if b_cls > f_cls and (b_cls - f_cls) * processor.timestamp_segment_time <= 600:
                                    repaired[2 * wi], repaired[2 * wi + 1] = f_cls, b_cls
                                    repaired_count += 1
                            if not repaired_count:
                                raise
                            words, overlaps = decode_raw_word_times(repaired, word_lists[0], processor.timestamp_segment_time)
                        parsed_words = []
                        for word in words:
                            begin, finish = float(word['start_time']), float(word['end_time'])
                            if not (math.isfinite(begin) and math.isfinite(finish) and 0 <= begin <= finish <= end-start+0.1):
                                fail('alignment_failed', 'Aligner returned an invalid timestamp; no synthetic replacement is used')
                            parsed_words.append({'text': word['text'], 'start': start+begin, 'end': start+finish})
                        segment['alignment_overlap_count'] = overlaps
                        segment['words'] = parsed_words
                    except PluginError as exc:
                        if exc.code != 'alignment_failed':
                            raise
                        segment['words'] = []
                        segment['alignment_error'] = str(exc)
            finally:
                if KEEP_MODEL_RESIDENT:
                    del processor, model, inputs, output, raw, mask
                else:
                    del processor, model, inputs, output, raw, mask
                    release()
    result = {'status': 'ok', 'text': ' '.join(s['text'] for s in segments), 'duration': duration,
              'aligned': align, 'segments': segments, 'timestamp_source': 'forced_aligner' if align else 'none',
              'timestamp_postprocessing': 'none'}
    # Fixed local filename; callers cannot choose arbitrary output paths.
    target = ROOT / 'outputs/latest.json'
    temporary = target.with_suffix('.tmp')
    temporary.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
    temporary.replace(target)
    return result


@gpu_guard
def infer_batch(request):
    if not isinstance(request, dict):
        fail('invalid_request', 'JSON object required')
    allowed = {'audio_paths', 'language', 'max_new_tokens', 'prompt', 'device'}
    if set(request) - allowed:
        fail('invalid_request', 'Unknown request fields: ' + ', '.join(sorted(set(request) - allowed)))
    raw_paths = request.get('audio_paths')
    if not isinstance(raw_paths, list) or not 1 <= len(raw_paths) <= 16:
        fail('invalid_request', 'audio_paths must be a list of 1..16 paths within inputs/')
    paths = [input_path(item) for item in raw_paths]
    max_tokens = bounded_number(request.get('max_new_tokens', 512), 'max_new_tokens', 64, 1024, True)
    language = request.get('language')
    if language is not None and (not isinstance(language, str) or len(language) > 40):
        fail('invalid_request', 'language must be null or a language name/code')
    language = LANGUAGES.get(language, language)
    prompt = request.get('prompt', '')
    if not isinstance(prompt, str) or len(prompt) > 2000:
        fail('invalid_request', 'prompt must be a string of at most 2000 characters')
    device = request.get('device', 'cuda')
    if device not in ('cuda', 'cpu'):
        fail('invalid_request', 'device must be cuda or cpu')
    dependencies()
    weights()
    import torch
    import numpy as np
    import soundfile as sf
    from scipy.signal import resample_poly
    if device == 'cuda' and not torch.cuda.is_available():
        fail('cuda_unavailable', 'CUDA is unavailable; use device=cpu explicitly for slow CPU inference')
    arrays = []
    for path in paths:
        try:
            info = sf.info(str(path))
            duration = info.frames / info.samplerate
            if not 0 < duration <= 60 or not 8000 <= info.samplerate <= 192000 or not 1 <= info.channels <= 8:
                fail('invalid_audio', 'Batch audio must be >0 and <=60 seconds, 8-192 kHz, 1-8 channels')
            data, sr = sf.read(str(path), dtype='float32', always_2d=True)
            mono = data.mean(axis=1)
            if not np.isfinite(mono).all():
                fail('invalid_audio', 'Audio contains nonfinite samples')
            if sr != 16000:
                divisor = math.gcd(sr, 16000)
                mono = resample_poly(mono, 16000 // divisor, sr // divisor).astype(np.float32, copy=False)
            arrays.append(mono)
        except PluginError:
            raise
        except Exception as exc:
            fail('invalid_audio', str(exc))
    processor = model = inputs = output = generated = None
    try:
        processor, model = get_model('asr', device)
        inputs = processor.apply_transcription_request(audio=arrays, language=language, prompt=prompt).to(device, model.dtype)
        with torch.inference_mode():
            output = model.generate(**inputs, max_new_tokens=max_tokens, do_sample=False)
        generated = output[:, inputs['input_ids'].shape[1]:]
        decoded = processor.batch_decode(generated, skip_special_tokens=True)
        parsed = processor.parse_output(decoded)
        if not isinstance(parsed, list):
            parsed = [parsed]
        results = [{'text': item.get('transcription', ''), 'language': language or item.get('language')} for item in parsed]
        return {'status': 'ok', 'results': results}
    finally:
        if KEEP_MODEL_RESIDENT:
            del processor, model, inputs, output, generated
        else:
            del processor, model, inputs, output, generated
            release()


class Handler(BaseHTTPRequestHandler):
    server_version = 'LingVoiceASR/1'

    def setup(self):
        super().setup()
        self.connection.settimeout(15)

    def reply(self, status, result):
        body = json.dumps(result, ensure_ascii=False).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Connection', 'close')
        self.end_headers()
        self.wfile.write(body)

    def trusted(self):
        # Reject browser-origin calls and DNS rebinding. Local native clients use no Origin.
        return (self.headers.get('Host') in (f'127.0.0.1:{self.server.server_port}', f'localhost:{self.server.server_port}')
                and self.headers.get('Origin') is None and self.headers.get('Sec-Fetch-Site') is None)

    def do_GET(self):
        if not self.trusted():
            return self.reply(403, {'error': 'forbidden_origin'})
        if self.path != '/health':
            return self.reply(404, {'error': 'not_found'})
        self.reply(200, {'status': 'ok', 'service': 'lingvoice-asr', 'offline': True})

    def do_POST(self):
        if not self.trusted():
            return self.reply(403, {'error': 'forbidden_origin'})
        if self.path not in ('/infer', '/infer_batch'):
            return self.reply(404, {'error': 'not_found'})
        if self.headers.get('Transfer-Encoding') or self.headers.get_content_type() != 'application/json':
            return self.reply(415, {'error': 'json_required'})
        try:
            length = int(self.headers.get('Content-Length', '0'))
            if not 0 < length <= MAX_BODY:
                return self.reply(413, {'error': 'body_limit', 'max_bytes': MAX_BODY})
            request = json.loads(self.rfile.read(length))
            with LOCK:
                result = infer_batch(request) if self.path == '/infer_batch' else infer(request)
            self.reply(200, result)
        except (ValueError, UnicodeError) as exc:
            self.reply(400, {'error': 'invalid_json', 'message': str(exc)})
        except PluginError as exc:
            self.reply(400 if exc.code.startswith(('invalid', 'unsupported')) else 503,
                       {'error': exc.code, 'message': str(exc)})
        except Exception as exc:
            self.reply(500, {'error': 'inference_failed', 'message': f'{type(exc).__name__}: {exc}'})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', type=int, default=9871)
    sub = parser.add_subparsers(dest='command')
    checker = sub.add_parser('check')
    checker.add_argument('--dependencies-only', action='store_true')
    checker.add_argument('--load', action='store_true')
    runner = sub.add_parser('infer')
    runner.add_argument('audio_path')
    runner.add_argument('--language')
    runner.add_argument('--no-align', action='store_true')
    runner.add_argument('--device', choices=('cuda', 'cpu'), default='cuda')
    runner.add_argument('--chunk-seconds', type=float, default=20)
    runner.add_argument('--max-new-tokens', type=int, default=512)
    args = parser.parse_args()
    try:
        if args.command == 'check':
            result = check(args.dependencies_only, args.load)
        elif args.command == 'infer':
            with LOCK:
                result = infer({'audio_path': args.audio_path, 'language': args.language, 'align': not args.no_align,
                                'device': args.device, 'chunk_seconds': args.chunk_seconds, 'max_new_tokens': args.max_new_tokens})
        else:
            if not 1024 <= args.port <= 65535:
                fail('invalid_request', 'port must be 1024..65535')
            global KEEP_MODEL_RESIDENT
            KEEP_MODEL_RESIDENT = True
            server = HTTPServer(('127.0.0.1', args.port), Handler)
            print(json.dumps({'status': 'listening', 'url': f'http://127.0.0.1:{args.port}'}), flush=True)
            try:
                server.serve_forever()
            finally:
                unload_cached_model(drop_lease=True)
                server.server_close()
            return
        print(json.dumps(result, ensure_ascii=False, indent=2))
    except PluginError as exc:
        print(json.dumps({'status': 'error', 'error': exc.code, 'message': str(exc)}))
        sys.exit(2 if exc.code == 'missing_dependencies' else 3 if exc.code == 'missing_weights' else 1)
    except Exception as exc:
        print(json.dumps({'status': 'error', 'error': 'runtime_failed', 'message': f'{type(exc).__name__}: {exc}'}))
        sys.exit(1)


if __name__ == '__main__':
    main()
