"""Verified, resumable model downloads. Existing files are replaced only after validation."""
from __future__ import annotations
import argparse
import hashlib
import http.client
import json
import os
from pathlib import Path, PurePosixPath, PureWindowsPath
import re
import shutil
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request

ROOT = Path(__file__).resolve().parent
CACHE = ROOT / 'installer' / 'cache'
for key, suffix in {'HF_HOME': 'huggingface', 'HF_HUB_CACHE': 'huggingface/hub', 'HF_XET_CACHE': 'huggingface/xet', 'TMP': 'tmp', 'TEMP': 'tmp'}.items():
    directory = CACHE / suffix
    directory.mkdir(parents=True, exist_ok=True)
    os.environ[key] = str(directory)
os.environ['HF_HUB_DISABLE_XET'] = '1'
os.environ['HF_HUB_DISABLE_TELEMETRY'] = '1'
os.environ['HF_HUB_DOWNLOAD_TIMEOUT'] = '120'
os.environ['HF_HUB_ETAG_TIMEOUT'] = '30'


def atomic_json(path: Path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    # Unique sibling temporary files also work when independent model jobs run together.
    fd, name = tempfile.mkstemp(prefix=path.name + '.', suffix='.tmp', dir=path.parent)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as stream:
            json.dump(value, stream, ensure_ascii=False, indent=2)
            stream.write('\n')
            stream.flush()
            os.fsync(stream.fileno())
        for attempt in range(4):
            try:
                os.replace(name, path)
                break
            except PermissionError:
                # Antivirus/indexers can briefly hold a Windows file without delete sharing.
                if attempt == 3:
                    raise
                time.sleep(0.2 * 2 ** attempt)
    finally:
        Path(name).unlink(missing_ok=True)


def safe_path(root: Path, name: str) -> Path:
    # Reject Windows drives, ADS, backslashes and traversal even on non-Windows test hosts.
    if not name or '\\' in name or ':' in name or PureWindowsPath(name).drive or PurePosixPath(name).is_absolute() or '..' in PurePosixPath(name).parts:
        raise ValueError(f'Unsafe remote file path: {name}')
    root = root.resolve()
    result = (root / name).resolve()
    if result == root or not result.is_relative_to(root):
        raise ValueError(f'Unsafe remote file path: {name}')
    return result


def sha256(path: Path) -> str:
    return file_hashes(path)[0]


def file_hashes(path: Path):
    sha = hashlib.sha256()
    git = hashlib.sha1(f'blob {path.stat().st_size}\0'.encode())
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(8 * 1024 * 1024), b''):
            sha.update(chunk)
            git.update(chunk)
    return sha.hexdigest(), git.hexdigest()


def valid_file(path, size=None, expected_sha256=None, git_blob_sha1=None, expected_md5=None):
    if not path.is_file() or (size is not None and path.stat().st_size != size):
        return False
    if expected_md5:
        digest = hashlib.md5()
        with path.open('rb') as stream:
            for block in iter(lambda: stream.read(8 * 1024 * 1024), b''):
                digest.update(block)
        if digest.hexdigest() != expected_md5:
            return False
    if expected_sha256 or git_blob_sha1:
        sha, git = file_hashes(path)
        return sha == expected_sha256 if expected_sha256 else git == git_blob_sha1
    return True


def request_json(url, attempts=4):
    for attempt in range(attempts):
        try:
            req = urllib.request.Request(url, headers={'User-Agent': 'LingVoice/1', 'Accept-Encoding': 'identity'})
            with urllib.request.urlopen(req, timeout=60) as response:
                return json.load(response)
        except (OSError, ValueError, http.client.HTTPException):
            if attempt == attempts - 1:
                raise
            time.sleep(2 ** attempt)


def modelscope_files(repo: str, revision='master'):
    query = urllib.parse.urlencode({'Revision': revision, 'Recursive': 'True'})
    payload = request_json(f'https://www.modelscope.cn/api/v1/models/{repo}/repo/files?{query}')
    if payload.get('Success') is False or payload.get('Code', 200) not in (200, '200'):
        raise RuntimeError(f'ModelScope inventory failed: {payload.get("Message", repo)}')
    data = payload.get('Data') or {}
    # Refuse a truncated inventory instead of publishing a false complete marker.
    if data.get('IsTruncated') or data.get('HasMore') or data.get('NextPageToken'):
        raise RuntimeError('ModelScope inventory is paginated; refusing incomplete inventory')
    result = []
    for item in data.get('Files') or []:
        if item.get('Type') != 'blob':
            continue
        name = item.get('Path') or item.get('Name') or ''
        result.append({'name': name, 'size': int(item['Size']) if item.get('Size') is not None else None,
                       'sha256': (item.get('Sha256') or '').lower() or None})
    return result


def download_url_resumable(url: str, dest: Path, expected_size: int | None = None,
                           expected_sha256=None, git_blob_sha1=None, attempts=4, expected_md5=None):
    """Resume ranges, restart corrupt/unsupported ranges, validate before atomic promotion.

    urllib's socket timeout bounds stalled reads without imposing a short total deadline
    on multi-gigabyte files. A failed transfer keeps its partial for the next attempt.
    """
    dest.parent.mkdir(parents=True, exist_ok=True)
    partial = dest.with_suffix(dest.suffix + '.part')
    for attempt in range(attempts):
        try:
            offset = partial.stat().st_size if partial.exists() else 0
            if offset and expected_size is not None and offset >= expected_size:
                if valid_file(partial, expected_size, expected_sha256, git_blob_sha1, expected_md5):
                    partial.replace(dest)
                    return dest
                partial.unlink()
                offset = 0
            headers = {'User-Agent': 'LingVoice/1', 'Accept-Encoding': 'identity'}
            if offset:
                headers['Range'] = f'bytes={offset}-'
            req = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(req, timeout=120) as response:
                status = response.status
                if status == 206:
                    match = re.fullmatch(r'bytes (\d+)-(\d+)/(\d+|\*)', response.headers.get('Content-Range', ''))
                    if not match or int(match[1]) != offset or int(match[2]) < offset:
                        partial.unlink(missing_ok=True)
                        raise ValueError('Invalid Content-Range')
                    if expected_size is not None and match[3] != str(expected_size):
                        partial.unlink(missing_ok=True)
                        raise ValueError('Unexpected range total')
                elif status == 200:
                    offset = 0  # Server ignored Range: overwrite, never append.
                else:
                    raise ValueError(f'Unexpected HTTP status: {status}')
                with partial.open('ab' if offset else 'wb') as out:
                    shutil.copyfileobj(response, out, length=1024 * 1024)
                    out.flush()
                    os.fsync(out.fileno())
            if not valid_file(partial, expected_size, expected_sha256, git_blob_sha1, expected_md5):
                # A short response may resume. A complete but bad hash must restart.
                if expected_size is None or partial.stat().st_size >= expected_size:
                    partial.unlink(missing_ok=True)
                raise ValueError(f'Integrity failed: {dest.name}')
            partial.replace(dest)
            return dest
        except (OSError, ValueError, http.client.HTTPException) as exc:
            if isinstance(exc, urllib.error.HTTPError) and exc.code == 416:
                partial.unlink(missing_ok=True)
            if attempt == attempts - 1:
                raise
            time.sleep(2 ** attempt)


def select_files(entries, spec):
    names = [entry['name'] for entry in entries]
    if len(names) != len(set(names)):
        raise ValueError('Duplicate inventory paths')
    allowed = set(spec.get('files') or [])
    if allowed:
        missing = allowed - set(names)
        if missing:
            raise ValueError(f'Missing required remote files: {sorted(missing)}')
        selected = [entry for entry in entries if entry['name'] in allowed]
    else:
        # Prefer safetensors, but support repositories which have only bin/pt weights.
        has_safe = any(name.endswith('.safetensors') for name in names)
        selected = [entry for entry in entries if entry['name'] != '.gitattributes'
                    and not (has_safe and PurePosixPath(entry['name']).name.startswith('pytorch_model')
                             and entry['name'].endswith(('.bin', '.bin.index.json')))]
    if not selected:
        raise ValueError('Repository has no downloadable files')
    return selected


def install_entries(spec, target, manifest_path, entries, source, revision, repo, url_for):
    target = target.resolve()
    # Invalidate the old completion claim before any network/file work can fail.
    manifest = {'repo': repo, 'source': source, 'revision': revision, 'complete': False, 'files': []}
    atomic_json(manifest_path, manifest)
    entries = select_files(entries, spec)
    paths = [safe_path(target, entry['name']) for entry in entries]
    for entry, path in zip(entries, paths):
        if not isinstance(entry['size'], int) or entry['size'] < 0:
            raise ValueError(f'Missing or invalid source size: {entry["name"]}')
        expected, git_hash = entry.get('sha256'), entry.get('git_blob_sha1')
        if not ((expected and re.fullmatch('[a-fA-F0-9]{64}', expected)) or
                (not expected and git_hash and re.fullmatch('[a-fA-F0-9]{40}', git_hash))):
            raise ValueError(f'Missing or invalid source integrity hash: {entry["name"]}')
        if path == manifest_path.resolve() or path.with_suffix(path.suffix + '.part') in paths:
            raise ValueError(f'Conflicting inventory path: {entry["name"]}')
    # Existing corrupt files must remain available until their verified replacements exist.
    remaining = sum((entry['size'] or 0) for entry, path in zip(entries, paths)
                    if not valid_file(path, entry['size'], entry.get('sha256'), entry.get('git_blob_sha1')))
    if shutil.disk_usage(target).free < remaining + 5 * 1024**3:
        raise OSError('Insufficient disk space (5 GiB safety reserve required)')
    for index, (entry, dest) in enumerate(zip(entries, paths), start=1):
        size, expected = entry['size'], entry.get('sha256')
        if not expected and not entry.get('git_blob_sha1'):
            raise ValueError(f'Missing source integrity hash: {entry["name"]}')
        if not valid_file(dest, size, expected, entry.get('git_blob_sha1')):
            download_url_resumable(url_for(entry['name']), dest, size, expected, entry.get('git_blob_sha1'))
        manifest['files'].append({'name': entry['name'], 'size': dest.stat().st_size,
                                  'sha256': sha256(dest), 'source_sha256': expected})
        atomic_json(manifest_path, manifest)
        print(f'FILE OK {spec["id"]} {entry["name"]} ({index}/{len(entries)})', flush=True)
    names = {entry['name'] for entry in entries}
    for entry, path in zip(entries, paths):
        if entry['name'].endswith(('.safetensors.index.json', '.bin.index.json')):
            index_data = json.loads(path.read_text(encoding='utf-8'))
            weights = index_data.get('weight_map')
            if not isinstance(weights, dict) or not weights:
                raise ValueError(f'Invalid model shard index: {entry["name"]}')
            for shard in weights.values():
                shard_path = (PurePosixPath(entry['name']).parent / shard).as_posix()
                safe_path(target, shard_path)
                if shard_path not in names:
                    raise ValueError(f'Missing model shard: {shard_path}')
    manifest['complete'] = True
    atomic_json(manifest_path, manifest)
    print(f'COMPLETE {spec["id"]} verified_bytes={sum(e["size"] for e in manifest["files"])}', flush=True)


def download_from_modelscope(spec, target: Path, manifest_path: Path):
    repo = spec.get('modelscope_repo') or spec['repo']
    # HF commit IDs are not ModelScope revision IDs. Record the actual MS revision.
    revision = spec.get('modelscope_revision', 'master')
    atomic_json(manifest_path, {'repo': repo, 'source': 'modelscope', 'revision': revision, 'complete': False, 'files': []})
    entries = modelscope_files(repo, revision)
    install_entries(spec, target, manifest_path, entries, 'modelscope', revision, repo,
                    lambda name: f'https://www.modelscope.cn/models/{repo}/resolve/{urllib.parse.quote(revision, safe="")}/{urllib.parse.quote(name, safe="/")}')


def download_from_huggingface(spec, target: Path, manifest_path: Path, endpoint: str | None = None):
    from huggingface_hub import HfApi
    source = 'hf-mirror' if endpoint else 'huggingface'
    atomic_json(manifest_path, {'repo': spec['repo'], 'source': source, 'revision': spec['revision'], 'complete': False, 'files': []})
    # Pass the endpoint explicitly; an earlier model's environment must not leak here.
    endpoint = endpoint or 'https://huggingface.co'
    for attempt in range(4):
        try:
            info = HfApi(endpoint=endpoint, token=False).model_info(spec['repo'], revision=spec['revision'], files_metadata=True, timeout=60)
            break
        except Exception:
            # huggingface_hub versions use either requests or httpx exceptions.
            if attempt == 3:
                raise
            time.sleep(2 ** attempt)
    if info.sha != spec['revision']:
        raise ValueError('Revision mismatch')
    entries = []
    for entry in info.siblings:
        lfs = entry.lfs
        expected = (lfs.get('sha256') if isinstance(lfs, dict) else lfs.sha256) if lfs else None
        entries.append({'name': entry.rfilename, 'size': entry.size, 'sha256': expected,
                        'git_blob_sha1': None if lfs else entry.blob_id})
    install_entries(spec, target, manifest_path, entries, source, info.sha, spec['repo'],
                    lambda name: f'{endpoint}/{spec["repo"]}/resolve/{info.sha}/{urllib.parse.quote(name, safe="/")}')


def download(spec, verify_only=False, source='modelscope'):
    target = safe_path(ROOT, spec['directory'])
    model_root = (ROOT / spec['directory'].split('/')[0] / 'models').resolve()
    if not target.is_relative_to(model_root) or target == model_root:
        raise ValueError('Invalid destination')
    target.mkdir(parents=True, exist_ok=True)
    manifest_path = target / 'download-manifest.json'
    if verify_only:
        if not manifest_path.is_file():
            raise ValueError(f'Missing manifest: {manifest_path}; run a verified download first')
        manifest = json.loads(manifest_path.read_text('utf-8'))
        entries = manifest.get('files') or []
        if manifest.get('complete') is not True or not entries:
            raise ValueError('Download manifest is incomplete')
        expected_repo = spec.get('modelscope_repo') if manifest.get('source') == 'modelscope' else spec['repo']
        if manifest.get('repo') != expected_repo:
            raise ValueError('Manifest repository mismatch')
        if manifest.get('source') == 'modelscope':
            if manifest.get('revision') != spec.get('modelscope_revision', 'master'):
                raise ValueError('Manifest ModelScope revision mismatch')
        elif manifest.get('source') not in ('huggingface', 'hf-mirror') or manifest.get('revision') != spec['revision']:
            raise ValueError('Manifest revision/source mismatch')
        names = [e['name'] for e in entries]
        if len(set(names)) != len(names) or not set(spec.get('files') or []).issubset(names):
            raise ValueError('Manifest missing required files or has duplicate entries')
        for entry in entries:
            file = safe_path(target, entry['name'])
            if not re.fullmatch('[a-fA-F0-9]{64}', entry.get('sha256', '')) or not valid_file(file, entry['size'], entry['sha256']):
                raise ValueError(f'Integrity failed: {file}')
        print(f'VERIFIED {spec["id"]}: {len(entries)} files', flush=True)
        return
    if source == 'modelscope':
        if spec.get('modelscope_repo'):
            download_from_modelscope(spec, target, manifest_path)
        else:
            download_from_huggingface(spec, target, manifest_path, endpoint='https://hf-mirror.com')
    else:
        download_from_huggingface(spec, target, manifest_path)


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
