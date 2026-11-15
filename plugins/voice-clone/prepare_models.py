"""Download only pinned V5 inference assets; verify Hub Git/LFS hashes.
No voice samples or training datasets are downloaded. Safe to rerun/resume.
"""
from __future__ import annotations
import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import urllib.request
import zipfile
from local_runtime import ROOT, UPSTREAM, SOURCE_REVISION, configure

MANIFEST = ROOT / 'models.manifest.json'
REPO = 'lj1995/GPT-SoVITS'


def api(url):
    with urllib.request.urlopen(url, timeout=90) as response:
        return json.load(response)


def inventory(repo, revision=None):
    info = api(f'https://huggingface.co/api/models/{repo}/revision/{revision or "main"}')
    revision = info['sha']
    files = api(f'https://huggingface.co/api/models/{repo}/tree/{revision}?recursive=true&limit=1000')
    return revision, files


def make_manifest():
    revision, files = inventory(REPO)
    base = 'upstream/GPT_SoVITS/pretrained_models/'
    wanted = {'s1v3.ckpt', 'gsv-v5-pretrained/s2Gv5turbo.pth',
              'gsv-v5-pretrained/s2Gv5dev.pth', 'gsv-v5-pretrained/vocoder.pth'}
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
    MANIFEST.write_text(json.dumps(data, indent=2) + '\n', encoding='utf-8')
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
    path = ROOT / item['destination']
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists() and path.stat().st_size == item['bytes']:
        sha, git = hashes(path)
        if (sha == item['sha256'] if item['sha256'] else git == item['git_blob_sha1']):
            print(f'VERIFIED {item["source"]} {item["bytes"]}', flush=True)
            return dict(destination=item['destination'], bytes=item['bytes'], sha256=sha)
    partial = path.with_suffix(path.suffix + '.part')
    if item.get('url'):
        url = item['url']
    elif download_source == 'modelscope':
        if item['repo'] == 'XXXXRT/GPT-SoVITS-Pretrained':
            url = f'https://www.modelscope.cn/models/XXXXRT/GPT-SoVITS-Pretrained/resolve/master/{item["source"]}'
        elif item['repo'] == 'lj1995/GPT-SoVITS' and item['source'].startswith(('chinese-hubert-base/', 'chinese-roberta-wwm-ext-large/')):
            url = f'https://www.modelscope.cn/models/XXXXRT/GPT-SoVITS-Pretrained/resolve/master/pretrained_models/{item["source"]}'
        else:
            url = f'https://hf-mirror.com/{item["repo"]}/resolve/{item["revision"]}/{item["source"]}'
    else:
        url = f'https://huggingface.co/{item["repo"]}/resolve/{item["revision"]}/{item["source"]}'
    print(f'DOWNLOAD {item["source"]} {item["bytes"]}', flush=True)
    candidates = [url]
    if url.startswith('https://raw.githubusercontent.com/nltk/nltk_data/'):
        rest = url[len('https://raw.githubusercontent.com/nltk/nltk_data/'):]
        rev, _, rel = rest.partition('/')
        cdn_url = f'https://cdn.jsdelivr.net/gh/nltk/nltk_data@{rev}/{rel}'
        candidates = [cdn_url, url] if download_source == 'modelscope' else [url, cdn_url]
    last_err = None
    for candidate in candidates:
        try:
            subprocess.run(['curl.exe', '--fail', '--location', '--retry', '4', '--retry-all-errors',
                            '--connect-timeout', '30', '--continue-at', '-', '--silent', '--show-error',
                            '--output', str(partial), candidate], check=True)
            last_err = None
            break
        except Exception as exc:
            last_err = exc
    if last_err is not None:
        raise last_err
    if partial.stat().st_size != item['bytes']:
        raise RuntimeError(f'Incorrect size: {path}')
    sha, git = hashes(partial)
    if not (sha == item['sha256'] if item['sha256'] else git == item['git_blob_sha1']):
        raise RuntimeError(f'Official source hash mismatch: {path}')
    partial.replace(path)
    print(f'VERIFIED {item["source"]} sha256={sha}', flush=True)
    return dict(destination=item['destination'], bytes=item['bytes'], sha256=sha)


def extract_g2pw():
    target = UPSTREAM / 'GPT_SoVITS/text/G2PWModel'
    archive = ROOT / 'downloads/G2PWModel.zip'
    with zipfile.ZipFile(archive) as z:
        for member in z.infolist():
            parts = Path(member.filename).parts
            if '..' in parts or Path(member.filename).is_absolute():
                raise RuntimeError('Unsafe archive member')
            # Official archive has one top-level G2PWModel directory.
            relative = Path(*parts[1:]) if parts[0].startswith('G2PWModel') else Path(*parts)
            output = target / relative
            if member.is_dir():
                output.mkdir(parents=True, exist_ok=True)
            else:
                output.parent.mkdir(parents=True, exist_ok=True)
                with z.open(member) as src, output.open('wb') as dst:
                    shutil.copyfileobj(src, dst)


def runtime_assets():
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
                            str(source_checkout)], check=True)
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
        manifest_path.write_text(json.dumps(auxiliary, indent=2) + '\n', encoding='utf-8')
    for item in auxiliary['assets']:
        download(item)
        destination = runtime / 'nltk_data' / item['category']
        destination.mkdir(parents=True, exist_ok=True)
        # g2p_en checks for the .zip itself even when the corpus is extracted.
        shutil.copy2(ROOT / item['destination'], destination / Path(item['destination']).name)
        with zipfile.ZipFile(ROOT / item['destination']) as archive:
            for name in archive.namelist():
                if not (destination / name).resolve().is_relative_to(destination.resolve()):
                    raise RuntimeError('Unsafe NLTK archive member')
            archive.extractall(destination)

    from fast_langdetect.infer import ModelDownloader, DEFAULT_FASTTEXT_LARGE_MODEL_URL, FASTTEXT_LARGE_MODEL_MD5
    language_model = UPSTREAM / 'GPT_SoVITS/pretrained_models/fast_langdetect/lid.176.bin'
    language_model.parent.mkdir(parents=True, exist_ok=True)
    ModelDownloader.download(DEFAULT_FASTTEXT_LARGE_MODEL_URL, language_model,
                             expected_md5=FASTTEXT_LARGE_MODEL_MD5)
    language_sha = hashes(language_model)[0]
    previous = auxiliary.get('language_detector')
    if previous and previous['sha256'] != language_sha:
        raise RuntimeError('Pinned language detector SHA256 mismatch')
    auxiliary['language_detector'] = dict(url=DEFAULT_FASTTEXT_LARGE_MODEL_URL,
        destination=language_model.relative_to(ROOT).as_posix(),
        md5=FASTTEXT_LARGE_MODEL_MD5, sha256=language_sha, bytes=language_model.stat().st_size)
    manifest_path.write_text(json.dumps(auxiliary, indent=2) + '\n', encoding='utf-8')
    report = []
    for path in sorted(runtime.rglob('*')):
        if path.is_file():
            report.append(dict(destination=path.relative_to(ROOT).as_posix(), bytes=path.stat().st_size,
                               sha256=hashes(path)[0]))
    (ROOT / 'runtime.manifest.json').write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--runtime-only', action='store_true')
    parser.add_argument('--models-only', action='store_true')
    parser.add_argument('--source', choices=['modelscope', 'huggingface'], default='modelscope')
    args = parser.parse_args()
    configure(offline=False)
    if not args.runtime_only:
        data = json.loads(MANIFEST.read_text(encoding='utf-8')) if MANIFEST.exists() else make_manifest()
        with ThreadPoolExecutor(max_workers=3) as pool:
            verified = list(pool.map(lambda item: download(item, args.source), data['assets']))
        extract_g2pw()
        (ROOT / 'models.verified.json').write_text(json.dumps(verified, indent=2) + '\n', encoding='utf-8')
    if not args.models_only:
        runtime_assets()


if __name__ == '__main__':
    main()
