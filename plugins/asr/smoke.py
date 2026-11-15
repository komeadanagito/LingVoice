"""Explicit online fixture preparation; default checks and inference are offline."""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('asr_runtime', ROOT / 'server.py')
runtime = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runtime)
SAMPLE_URL = 'https://huggingface.co/datasets/bezzam/audio_samples/resolve/main/librispeech_mr_quilter.wav'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--fetch-sample', action='store_true', help='Explicitly allow downloading only the official public test audio')
    parser.add_argument('--infer', action='store_true', help='Transcribe and align the already downloaded sample on CUDA')
    parser.add_argument('--load', action='store_true')
    args = parser.parse_args()
    sample = ROOT / 'inputs/librispeech_mr_quilter.wav'
    if args.fetch_sample:
        from urllib.request import urlopen
        with urlopen(SAMPLE_URL, timeout=60) as response:
            data = response.read(10 * 1024 * 1024 + 1)
        if len(data) > 10 * 1024 * 1024:
            raise RuntimeError('Fixture exceeds 10 MiB')
        sample.write_bytes(data)
        metadata = {'source': SAMPLE_URL, 'sha256': hashlib.sha256(data).hexdigest(), 'bytes': len(data)}
        (ROOT / 'inputs/librispeech_mr_quilter.source.json').write_text(json.dumps(metadata, indent=2), encoding='utf-8')
        print(json.dumps({'fixture': metadata}))
        if not args.infer and not args.load:
            return
    try:
        result = runtime.check(load=args.load)
        if args.infer:
            if not sample.is_file():
                runtime.fail('missing_fixture', 'Run smoke.py --fetch-sample once during online setup')
            result['inference'] = runtime.infer({'audio_path': sample.name, 'language': 'English'})
            text = result['inference']['text'].lower()
            if not all(word in text for word in ('quilter', 'middle', 'gospel')):
                runtime.fail('smoke_transcription_mismatch', f'Unexpected official sample transcription: {text}')
            words = [w for s in result['inference']['segments'] for w in s['words']]
            if not words or not all(0 <= w['start'] <= w['end'] <= result['inference']['duration'] + 0.1 for w in words):
                runtime.fail('smoke_alignment_failed', 'Missing or out-of-range word timestamps')
            result['sample_assertions'] = 'passed (Quilter/middle/gospel and real bounded word timestamps)'
        print(json.dumps(result, ensure_ascii=False, indent=2))
    except runtime.PluginError as exc:
        print(json.dumps({'status': 'error', 'error': exc.code, 'message': str(exc)}))
        sys.exit(2 if exc.code == 'missing_dependencies' else 3 if exc.code == 'missing_weights' else 1)


if __name__ == '__main__':
    main()
