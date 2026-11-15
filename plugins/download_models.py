"""Pinned official downloads supporting ModelScope (default) and Hugging Face.
Run with installer/.venv/Scripts/python.exe. Partial downloads are resumable.
"""
from __future__ import annotations
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import time
import urllib.parse
import urllib.request

ROOT = Path(__file__).resolve().parent
CACHE = ROOT / 'installer' / 'cache'
for key, suffix in {'HF_HOME':'huggingface', 'HF_HUB_CACHE':'huggingface/hub', 'HF_XET_CACHE':'huggingface/xet', 'TMP':'tmp', 'TEMP':'tmp'}.items():
    directory = CACHE / suffix
    directory.mkdir(parents=True, exist_ok=True)
    os.environ[key] = str(directory)
os.environ['HF_HUB_DISABLE_XET'] = '1'
os.environ['HF_HUB_DISABLE_TELEMETRY'] = '1'
os.environ['HF_HUB_DOWNLOAD_TIMEOUT'] = '120'
os.environ['HF_HUB_ETAG_TIMEOUT'] = '30'


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open('rb') as f:
        for chunk in iter(lambda: f.read(8 * 1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()


def modelscope_files(repo: str):
    url = f'https://www.modelscope.cn/api/v1/models/{repo}/repo/files?Revision=master&Recursive=True'
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
    with urllib.request.urlopen(req, timeout=30) as resp:
        payload = json.loads(resp.read().decode('utf-8'))
    files = (payload.get('Data') or {}).get('Files') or []
    result = []
    for item in files:
        if item.get('Type') != 'blob':
            continue
        name = item.get('Path') or item.get('Name') or ''
        if not name or name == '.gitattributes' or name.endswith(('.bin', '.pt', '.pth', '.ckpt')):
            continue
        result.append({
            'name': name,
            'size': int(item.get('Size') or 0),
            'sha256': (item.get('Sha256') or '').lower() or None,
        })
    return result


def download_url_resumable(url: str, dest: Path, expected_size: int | None = None):
    dest.parent.mkdir(parents=True, exist_ok=True)
    partial = dest.with_suffix(dest.suffix + '.part')
    curl = shutil.which('curl.exe') or shutil.which('curl')
    if curl:
        subprocess.run([
            curl, '--fail', '--location', '--retry', '6', '--retry-all-errors',
            '--connect-timeout', '45', '--continue-at', '-', '--silent', '--show-error',
            '--output', str(partial), url,
        ], check=True)
    else:
        req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
        with urllib.request.urlopen(req, timeout=120) as resp, partial.open('wb') as out:
            shutil.copyfileobj(resp, out, length=1024 * 1024)
    if expected_size is not None and expected_size > 0 and partial.stat().st_size != expected_size:
        raise ValueError(f'Size mismatch for {dest.name}: got {partial.stat().st_size}, expected {expected_size}')
    partial.replace(dest)


def download_from_modelscope(spec, target: Path, manifest_path: Path):
    repo = spec.get('modelscope_repo') or spec['repo']
    entries = modelscope_files(repo)
    if not entries:
        raise RuntimeError(f'ModelScope repository has no downloadable files: {repo}')
    total = sum(e['size'] for e in entries)
    remaining = sum(
        max(0, e['size'] - ((target / e['name']).stat().st_size if (target / e['name']).exists() else 0))
        for e in entries
    )
    if shutil.disk_usage(ROOT).free < remaining + 5 * 1024**3:
        raise OSError('Insufficient disk space (5 GiB safety reserve required)')
    print(f"DOWNLOAD {spec['id']} source=modelscope repo={repo} bytes={total} files={len(entries)} directory={target}", flush=True)
    manifest = {'repo': repo, 'source': 'modelscope', 'revision': spec.get('revision', 'master'), 'complete': False, 'files': []}
    for index, entry in enumerate(entries, start=1):
        name = entry['name']
        dest = (target / name).resolve()
        if not dest.is_relative_to(target):
            raise ValueError('Unsafe remote file path')
        expected = entry['sha256']
        size = entry['size']
        if dest.exists() and (size == 0 or dest.stat().st_size == size) and (not expected or sha256(dest) == expected):
            pass
        else:
            encoded = '/'.join(urllib.parse.quote(part, safe='') for part in name.split('/'))
            url = f'https://www.modelscope.cn/models/{repo}/resolve/master/{encoded}'
            for attempt in range(4):
                try:
                    download_url_resumable(url, dest, size if size > 0 else None)
                    break
                except Exception:
                    if attempt == 3:
                        raise
                    time.sleep(2 ** attempt)
        actual = sha256(dest)
        actual_size = dest.stat().st_size
        if (size > 0 and actual_size != size) or (expected and actual != expected):
            raise ValueError(f'Integrity failed: {name}')
        manifest['files'].append({'name': name, 'size': actual_size, 'sha256': actual, 'source_sha256': expected})
        manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), 'utf-8')
        print(f"FILE OK {spec['id']} {name} {actual_size} ({index}/{len(entries)})", flush=True)
    manifest['complete'] = True
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), 'utf-8')
    print(f"COMPLETE {spec['id']} verified_bytes={total}", flush=True)


def download_from_huggingface(spec, target: Path, manifest_path: Path, endpoint: str | None = None):
    if endpoint:
        os.environ['HF_ENDPOINT'] = endpoint
    else:
        os.environ.pop('HF_ENDPOINT', None)
    from huggingface_hub import HfApi, hf_hub_download

    info = HfApi(endpoint=endpoint).model_info(spec['repo'], revision=spec['revision'], files_metadata=True)
    if info.sha != spec['revision']:
        raise ValueError('Revision mismatch')
    allowed = set(spec.get('files') or [])
    if allowed:
        files = [f for f in info.siblings if f.rfilename in allowed]
    else:
        files = [f for f in info.siblings if f.rfilename != '.gitattributes' and not f.rfilename.endswith(('.bin', '.pt', '.pth', '.ckpt'))]
    total = sum(f.size or 0 for f in files)
    remaining = sum(max(0, (f.size or 0) - ((target / f.rfilename).stat().st_size if (target / f.rfilename).exists() else 0)) for f in files)
    if shutil.disk_usage(ROOT).free < remaining + 5 * 1024**3:
        raise OSError('Insufficient disk space (5 GiB safety reserve required)')
    source_name = 'hf-mirror' if endpoint else 'huggingface'
    print(f"DOWNLOAD {spec['id']} source={source_name} revision={info.sha} bytes={total} files={len(files)} directory={target}", flush=True)
    manifest = {'repo': spec['repo'], 'source': source_name, 'revision': info.sha, 'complete': False, 'files': []}
    for index, entry in enumerate(files, start=1):
        name = entry.rfilename
        if not (target / name).resolve().is_relative_to(target):
            raise ValueError('Unsafe remote file path')
        expected = entry.lfs.sha256 if entry.lfs else None
        dest = target / name
        if dest.exists() and dest.stat().st_size == entry.size and (not expected or sha256(dest) == expected):
            result = dest
        else:
            for attempt in range(4):
                try:
                    result = Path(hf_hub_download(spec['repo'], name, revision=info.sha, local_dir=target, token=False, endpoint=endpoint))
                    break
                except Exception:
                    if attempt == 3:
                        raise
                    time.sleep(2 ** attempt)
        actual = sha256(result)
        if result.stat().st_size != entry.size or (expected and actual != expected):
            raise ValueError(f'Integrity failed: {name}')
        manifest['files'].append({'name': name, 'size': entry.size, 'sha256': actual, 'source_sha256': expected})
        manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), 'utf-8')
        print(f"FILE OK {spec['id']} {name} {entry.size} ({index}/{len(files)})", flush=True)
    manifest['complete'] = True
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), 'utf-8')
    print(f"COMPLETE {spec['id']} verified_bytes={total}", flush=True)


def download(spec, verify_only=False, source='modelscope'):
    target = (ROOT / spec['directory']).resolve()
    if not target.is_relative_to(ROOT) or not target.is_relative_to(ROOT / spec['directory'].split('/')[0] / 'models'):
        raise ValueError('Invalid destination')
    target.mkdir(parents=True, exist_ok=True)
    manifest_path = target / 'download-manifest.json'
    if verify_only:
        if manifest_path.exists():
            manifest = json.loads(manifest_path.read_text('utf-8'))
            for entry in manifest['files']:
                file = target / entry['name']
                if file.stat().st_size != entry['size'] or sha256(file) != entry['sha256']:
                    raise ValueError(f'Integrity failed: {file}')
            print(f"VERIFIED {spec['id']}: {len(manifest['files'])} files", flush=True)
            return
        if spec.get('files'):
            for name in spec['files']:
                file = target / name
                if not file.is_file() or file.stat().st_size == 0:
                    raise ValueError(f'Missing file: {file}')
            print(f"VERIFIED {spec['id']}: {len(spec['files'])} files", flush=True)
            return
        raise ValueError(f'Missing manifest: {manifest_path}')

    if source == 'modelscope':
        if spec.get('modelscope_repo'):
            download_from_modelscope(spec, target, manifest_path)
        else:
            # Repos not mirrored on ModelScope (e.g. separation) use the China HF mirror when ModelScope source is chosen.
            download_from_huggingface(spec, target, manifest_path, endpoint='https://hf-mirror.com')
    else:
        download_from_huggingface(spec, target, manifest_path, endpoint=None)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--model', choices=['all', 'qwen-asr', 'qwen-aligner', 'gemma-e2b', 'separation'], default='all')
    parser.add_argument('--source', choices=['modelscope', 'huggingface'], default='modelscope')
    parser.add_argument('--verify', action='store_true')
    args = parser.parse_args()
    specs = json.loads((ROOT / 'model-sources.json').read_text('utf-8'))['models']
    for spec in specs:
        if args.model in ('all', spec['id']):
            download(spec, args.verify, args.source)
