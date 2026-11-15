"""Download only pinned V5 inference assets; verify Hub Git/LFS hashes.
No voice samples or training datasets are downloaded. Safe to rerun/resume.
"""
from __future__ import annotations
import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
import http.client
import json
from pathlib import Path
import shutil
import subprocess
import urllib.request
import urllib.parse
import re
import sys
import time
import zipfile

# Both installers use the same range/retry/hash-before-replace implementation.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from download_models import (atomic_json, safe_path, download_url_resumable,
                             valid_file, request_json)
from local_runtime import ROOT, UPSTREAM, SOURCE_REVISION, configure

MANIFEST = ROOT / 'models.manifest.json'
REPO = 'lj1995/GPT-SoVITS'


def api(url):
    return request_json(url)


def inventory(repo, revision=None):
    info = api(f'https://huggingface.co/api/models/{repo}/revision/{revision or "main"}')
    resolved = info['sha']
    if revision and revision != resolved:
        raise ValueError('Hub inventory revision mismatch')
    url = f'https://huggingface.co/api/models/{repo}/tree/{resolved}?recursive=true&limit=1000'
    files, visited = [], set()
    while url:
        if url in visited or not url.startswith('https://huggingface.co/'):
            raise ValueError('Unsafe or cyclic Hub pagination URL')
        visited.add(url)
        for attempt in range(4):
            try:
                with urllib.request.urlopen(url, timeout=60) as response:
                    page = json.load(response)
                    link = response.headers.get('Link', '')
                break
            except (OSError, ValueError, http.client.HTTPException):
                if attempt == 3:
                    raise
                time.sleep(2 ** attempt)
        if not isinstance(page, list):
            raise ValueError('Invalid Hub file inventory')
        files.extend(page)
        next_links = re.findall(r'<([^>]+)>;\s*rel="next"', link)
        url = next_links[0] if next_links else None
    names = [item['path'] for item in files]
    if len(names) != len(set(names)):
        raise ValueError('Duplicate Hub inventory paths')
    return resolved, files


def make_manifest():
    revision, files = inventory(REPO)
    base = 'upstream/GPT_SoVITS/pretrained_models/'
    wanted = {'s1v3.ckpt', 'gsv-v5-pretrained/s2Gv5turbo.pth',
              'gsv-v5-pretrained/s2Gv5dev.pth', 'gsv-v5-pretrained/vocoder.pth',
              'chinese-hubert-base/config.json', 'chinese-hubert-base/preprocessor_config.json',
              'chinese-hubert-base/pytorch_model.bin',
              'chinese-roberta-wwm-ext-large/config.json',
              'chinese-roberta-wwm-ext-large/pytorch_model.bin',
              'chinese-roberta-wwm-ext-large/tokenizer.json'}
    wanted.update(item['path'] for item in files if item['type'] == 'file'
                  and item['path'].startswith(('chinese-hubert-base/', 'chinese-roberta-wwm-ext-large/')))
    selected = []
    def add(item, repo, rev, destination):
        selected.append(dict(repo=repo, revision=rev, source=item['path'], destination=destination,
                             bytes=item['size'], sha256=item.get('lfs', {}).get('oid'),
                             git_blob_sha1=item['oid']))
    for item in files:
        if item['path'] in wanted:
            add(item, REPO, revision, base + item['path'])
    if len(selected) != len(wanted):
        raise RuntimeError('Incomplete pinned inference model inventory')
    auxrepo = 'XXXXRT/GPT-SoVITS-Pretrained'
    auxrev, auxfiles = inventory(auxrepo)
    item = next(item for item in auxfiles if item['path'] == 'G2PWModel.zip')
    add(item, auxrepo, auxrev, 'downloads/G2PWModel.zip')
    data = dict(source_repo='https://github.com/RVC-Boss/GPT-SoVITS',
                source_revision=SOURCE_REVISION, source_branch='cuda_graph_accel_v5',
                default_variant='v5turbo', assets=selected)
    atomic_json(MANIFEST, data)
    return data


def hashes(path):
    size = path.stat().st_size
    sha256 = hashlib.sha256()
    git = hashlib.sha1(f'blob {size}\0'.encode())
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(8 * 1024 * 1024), b''):
            sha256.update(block)
            git.update(block)
    return sha256.hexdigest(), git.hexdigest()


def download(item, download_source='modelscope'):
    path = safe_path(ROOT, item['destination'])
    path.parent.mkdir(parents=True, exist_ok=True)
    expected, git_hash = item.get('sha256'), item.get('git_blob_sha1')
    if not expected and not git_hash:
        raise ValueError(f'Missing source hash: {item["destination"]}')
    if not isinstance(item['bytes'], int) or item['bytes'] <= 0:
        raise ValueError('Invalid model size')
    if valid_file(path, item['bytes'], expected, git_hash):
        print(f'VERIFIED {item["source"]} {item["bytes"]}', flush=True)
        return dict(destination=item['destination'], bytes=item['bytes'], sha256=hashes(path)[0])
    source = urllib.parse.quote(item['source'], safe='/')
    if item.get('url'):
        url = item['url']
    else:
        revision = item['revision']
        if not re.fullmatch('[0-9a-fA-F]{40}', revision):
            raise ValueError('A pinned Hub commit is required')
        host = 'https://hf-mirror.com' if download_source == 'modelscope' else 'https://huggingface.co'
        official = f'{host}/{item["repo"]}/resolve/{revision}/{source}'
        if download_source == 'modelscope' and item['repo'] == 'XXXXRT/GPT-SoVITS-Pretrained':
            url = f'https://www.modelscope.cn/models/XXXXRT/GPT-SoVITS-Pretrained/resolve/master/{source}'
        elif download_source == 'modelscope' and item['repo'] == REPO and item['source'].startswith(('chinese-hubert-base/', 'chinese-roberta-wwm-ext-large/')):
            url = f'https://www.modelscope.cn/models/XXXXRT/GPT-SoVITS-Pretrained/resolve/master/pretrained_models/{source}'
        else:
            url = official
    print(f'DOWNLOAD {item["source"]} {item["bytes"]}', flush=True)
    candidates = [url]
    if not item.get('url') and url != official:
        # Mutable ModelScope mirrors may drift; fall back to the pinned Hub mirror.
        candidates.append(official)
    if url.startswith('https://raw.githubusercontent.com/nltk/nltk_data/'):
        rest = url[len('https://raw.githubusercontent.com/nltk/nltk_data/'):]
        rev, _, rel = rest.partition('/')
        cdn_url = f'https://cdn.jsdelivr.net/gh/nltk/nltk_data@{rev}/{rel}'
        candidates = [cdn_url, url] if download_source == 'modelscope' else [url, cdn_url]
    for index, candidate in enumerate(candidates):
        try:
            download_url_resumable(candidate, path, item['bytes'], expected, git_hash)
            break
        except (OSError, ValueError, http.client.HTTPException):
            if index == len(candidates) - 1:
                raise
            # Do not combine incomplete bytes from different mirrors.
            path.with_suffix(path.suffix + '.part').unlink(missing_ok=True)
    sha = hashes(path)[0]
    print(f'VERIFIED {item["source"]} sha256={sha}', flush=True)
    return dict(destination=item['destination'], bytes=item['bytes'], sha256=sha)


def extract_g2pw():
    target = UPSTREAM / 'GPT_SoVITS/text/G2PWModel'
    archive = ROOT / 'downloads/G2PWModel.zip'
    with zipfile.ZipFile(archive) as z:
        for member in z.infolist():
            # Validate the original name before stripping the official top-level folder.
            safe_path(target, member.filename.rstrip('/'))
            parts = Path(member.filename).parts
            relative = Path(*parts[1:]) if parts[0] == 'G2PWModel' else Path(*parts)
            if relative == Path('.'):
                continue
            output = safe_path(target, relative.as_posix())
            if member.is_dir():
                output.mkdir(parents=True, exist_ok=True)
            else:
                output.parent.mkdir(parents=True, exist_ok=True)
                temporary = output.with_name(output.name + '.extracting')
                try:
                    with z.open(member) as src, temporary.open('wb') as dst:
                        shutil.copyfileobj(src, dst)
                    temporary.replace(output)
                finally:
                    temporary.unlink(missing_ok=True)


def runtime_assets(download_source='modelscope'):
    (ROOT / 'runtime.manifest.json').unlink(missing_ok=True)
    runtime = UPSTREAM / 'runtime'
    runtime.mkdir(exist_ok=True)
    ffmpeg_target = runtime / 'ffmpeg.exe'
    try:
        import imageio_ffmpeg
        shutil.copy2(imageio_ffmpeg.get_ffmpeg_exe(), ffmpeg_target)
    except ImportError:
        existing_ffmpeg = shutil.which('ffmpeg') or shutil.which('ffmpeg.exe')
        if existing_ffmpeg:
            shutil.copy2(existing_ffmpeg, ffmpeg_target)
        elif not ffmpeg_target.is_file():
            raise RuntimeError("Missing imageio_ffmpeg and system ffmpeg. Run plugins/voice-clone/install.ps1 first.")
    # NLTK >=3.10's DNS guard mistakes this machine's VPN synthetic IP for SSRF.
    # Use fixed official GitHub URLs, pin the commit and verify Git blob hashes;
    # no arbitrary URL is ever accepted from an inference request.
    manifest_path = ROOT / 'auxiliary.manifest.json'
    if manifest_path.exists():
        auxiliary = json.loads(manifest_path.read_text(encoding='utf-8'))
    else:
        source_checkout = ROOT / 'nltk-source'
        if not (source_checkout / '.git').exists():
            subprocess.run(['git', 'clone', '--filter=blob:none', '--depth', '1', '--no-checkout',
                            '--branch', 'gh-pages', 'https://github.com/nltk/nltk_data.git',
                            str(source_checkout)], check=True, timeout=300)
        revision = subprocess.check_output(['git', '-C', str(source_checkout), 'rev-parse', 'HEAD'], text=True).strip()
        assets = []
        for category, corpus in (('taggers', 'averaged_perceptron_tagger'),
                                 ('taggers', 'averaged_perceptron_tagger_eng'), ('corpora', 'cmudict')):
            source = f'packages/{category}/{corpus}.zip'
            entry = subprocess.check_output(['git', '-C', str(source_checkout), 'ls-tree', '-l', revision, '--', source], text=True).split()
            if len(entry) < 5 or entry[1] != 'blob':
                raise RuntimeError(f'Official NLTK file missing: {source}')
            assets.append(dict(source=source, destination=f'downloads/nltk/{corpus}.zip',
                               bytes=int(entry[3]), sha256=None, git_blob_sha1=entry[2], category=category,
                               url=f'https://raw.githubusercontent.com/nltk/nltk_data/{revision}/{source}'))
        auxiliary = dict(nltk_data_revision=revision, assets=assets)
        atomic_json(manifest_path, auxiliary)
    for item in auxiliary['assets']:
        download(item, download_source)
        destination = runtime / 'nltk_data' / item['category']
        destination.mkdir(parents=True, exist_ok=True)
        # g2p_en checks for the .zip itself even when the corpus is extracted.
        shutil.copy2(ROOT / item['destination'], destination / Path(item['destination']).name)
        with zipfile.ZipFile(ROOT / item['destination']) as archive:
            for name in archive.namelist():
                safe_path(destination, name.rstrip('/'))
            archive.extractall(destination)

    from fast_langdetect.infer import DEFAULT_FASTTEXT_LARGE_MODEL_URL, FASTTEXT_LARGE_MODEL_MD5
    language_model = UPSTREAM / 'GPT_SoVITS/pretrained_models/fast_langdetect/lid.176.bin'
    language_model.parent.mkdir(parents=True, exist_ok=True)
    previous = auxiliary.get('language_detector')
    pinned_sha = previous['sha256'] if previous else None
    pinned_size = previous['bytes'] if previous else None
    if not valid_file(language_model, pinned_size, pinned_sha, expected_md5=FASTTEXT_LARGE_MODEL_MD5):
        download_url_resumable(DEFAULT_FASTTEXT_LARGE_MODEL_URL, language_model,
                               pinned_size, pinned_sha, expected_md5=FASTTEXT_LARGE_MODEL_MD5)
    language_sha = hashes(language_model)[0]
    auxiliary['language_detector'] = dict(url=DEFAULT_FASTTEXT_LARGE_MODEL_URL,
        destination=language_model.relative_to(ROOT).as_posix(),
        md5=FASTTEXT_LARGE_MODEL_MD5, sha256=language_sha, bytes=language_model.stat().st_size)
    atomic_json(manifest_path, auxiliary)
    report = []
    for path in sorted(runtime.rglob('*')):
        if path.is_file():
            report.append(dict(destination=path.relative_to(ROOT).as_posix(), bytes=path.stat().st_size,
                               sha256=hashes(path)[0]))
    atomic_json(ROOT / 'runtime.manifest.json', report)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--runtime-only', action='store_true')
    parser.add_argument('--models-only', action='store_true')
    parser.add_argument('--source', choices=['modelscope', 'huggingface'], default='modelscope')
    args = parser.parse_args()
    if args.runtime_only and args.models_only:
        parser.error('--runtime-only and --models-only are mutually exclusive')
    configure(offline=False)
    if not args.runtime_only:
        report_path = ROOT / 'models.verified.json'
        report_path.unlink(missing_ok=True)
        data = json.loads(MANIFEST.read_text(encoding='utf-8')) if MANIFEST.exists() else make_manifest()
        if data.get('source_revision') != SOURCE_REVISION or not data.get('assets'):
            raise ValueError('Model manifest is empty or belongs to a different source revision')
        destinations = [item['destination'] for item in data['assets']]
        if len(destinations) != len(set(destinations)):
            raise ValueError('Duplicate model destinations')
        required = {'s1v3.ckpt', 'gsv-v5-pretrained/s2Gv5turbo.pth',
                    'gsv-v5-pretrained/s2Gv5dev.pth', 'gsv-v5-pretrained/vocoder.pth',
                    'chinese-hubert-base/config.json', 'chinese-hubert-base/preprocessor_config.json',
                    'chinese-hubert-base/pytorch_model.bin', 'chinese-roberta-wwm-ext-large/config.json',
                    'chinese-roberta-wwm-ext-large/pytorch_model.bin',
                    'chinese-roberta-wwm-ext-large/tokenizer.json', 'G2PWModel.zip'}
        if not required.issubset({item['source'] for item in data['assets']}):
            raise ValueError('Model manifest is missing required inference assets')
        for destination in destinations:
            safe_path(ROOT, destination)
        with ThreadPoolExecutor(max_workers=3) as pool:
            verified = list(pool.map(lambda item: download(item, args.source), data['assets']))
        extract_g2pw()
        atomic_json(report_path, verified)
    if not args.models_only:
        runtime_assets(args.source)


if __name__ == '__main__':
    main()
