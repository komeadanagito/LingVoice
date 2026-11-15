"""Offline regression tests: python -m unittest discover -s plugins -p test_downloads.py -v."""
import hashlib
import http.client
import importlib.util
import io
import json
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import patch
import urllib.error

PLUGINS = Path(__file__).resolve().parent
sys.path.insert(0, str(PLUGINS))
sys.path.insert(0, str(PLUGINS / 'voice-clone'))
import download_models as downloads
spec = importlib.util.spec_from_file_location('voice_prepare_models', PLUGINS / 'voice-clone/prepare_models.py')
voice = importlib.util.module_from_spec(spec)
spec.loader.exec_module(voice)


class Response(io.BytesIO):
    def __init__(self, content=b'', status=200, headers=None):
        super().__init__(content)
        self.status = status
        self.headers = headers or {}


class DownloadTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.path = self.root / 'model.bin'
        self.data = b'official model contents'
        self.sha = hashlib.sha256(self.data).hexdigest()
        self.git = hashlib.sha1(f'blob {len(self.data)}\0'.encode() + self.data).hexdigest()
        self.sleep = patch.object(downloads.time, 'sleep')
        self.sleep.start()
        self.addCleanup(self.sleep.stop)
        network = patch.object(downloads.urllib.request, 'urlopen', side_effect=AssertionError('Unexpected network access in offline test'))
        network.start()
        self.addCleanup(network.stop)

    def fetch(self, responses, **kwargs):
        with patch.object(downloads.urllib.request, 'urlopen', side_effect=responses) as request:
            downloads.download_url_resumable('https://example/model', self.path,
                                             len(self.data), self.sha, **kwargs)
            return request

    def partial(self, content):
        self.path.with_suffix('.bin.part').write_bytes(content)

    def test_resumes_partial_with_valid_range(self):
        self.partial(self.data[:5])
        req = self.fetch([Response(self.data[5:], 206, {'Content-Range': f'bytes 5-{len(self.data)-1}/{len(self.data)}'})])
        self.assertEqual(req.call_args.args[0].get_header('Range'), 'bytes=5-')
        self.assertEqual(self.path.read_bytes(), self.data)

    def test_ignored_range_restarts_without_appending(self):
        self.partial(b'bad prefix')
        self.fetch([Response(self.data)])
        self.assertEqual(self.path.read_bytes(), self.data)

    def test_complete_corrupt_partial_restarts(self):
        self.partial(b'x' * len(self.data))
        req = self.fetch([Response(self.data)])
        self.assertIsNone(req.call_args.args[0].get_header('Range'))

    def test_corrupt_prefix_recovers_after_hash_failure(self):
        self.partial(b'xxxxx')
        req = self.fetch([Response(self.data[5:], 206, {'Content-Range': f'bytes 5-{len(self.data)-1}/{len(self.data)}'}), Response(self.data)])
        self.assertEqual(req.call_count, 2)
        self.assertIsNone(req.call_args.args[0].get_header('Range'))
        self.assertEqual(self.path.read_bytes(), self.data)

    def test_bad_content_range_restarts(self):
        self.partial(self.data[:5])
        self.fetch([Response(self.data[5:], 206, {'Content-Range': 'bytes 0-2/3'}), Response(self.data)])
        self.assertEqual(self.path.read_bytes(), self.data)

    def test_range_416_restarts(self):
        self.partial(b'123')
        self.fetch([urllib.error.HTTPError('url', 416, 'range', {}, None), Response(self.data)])
        self.assertEqual(self.path.read_bytes(), self.data)

    def test_hash_failure_preserves_existing_model(self):
        self.path.write_bytes(b'old usable model')
        with self.assertRaises(ValueError):
            self.fetch([Response(b'x' * len(self.data))] * 2, attempts=2)
        self.assertEqual(self.path.read_bytes(), b'old usable model')
        self.assertFalse(self.path.with_suffix('.bin.part').exists())

    def test_timeout_retries_and_sets_timeout(self):
        req = self.fetch([TimeoutError('stall'), Response(self.data)])
        self.assertEqual(req.call_count, 2)
        self.assertEqual(req.call_args.kwargs['timeout'], 120)

    def test_incomplete_http_read_retries(self):
        self.fetch([http.client.IncompleteRead(b'', 2), Response(self.data)])
        self.assertEqual(self.path.read_bytes(), self.data)

    def test_short_response_resumes(self):
        self.fetch([Response(self.data[:5]), Response(self.data[5:], 206, {'Content-Range': f'bytes 5-{len(self.data)-1}/{len(self.data)}'})])
        self.assertEqual(self.path.read_bytes(), self.data)

    def test_git_hash_and_md5_validation(self):
        with patch.object(downloads.urllib.request, 'urlopen', return_value=Response(self.data)):
            downloads.download_url_resumable('https://example/model', self.path, len(self.data), git_blob_sha1=self.git,
                                             expected_md5=hashlib.md5(self.data).hexdigest())
        self.assertEqual(self.path.read_bytes(), self.data)

    def test_safe_paths(self):
        for name in ('../evil', '/evil', 'C:/evil', 'folder\\evil', 'file:ads', '.'):
            with self.subTest(name=name), self.assertRaises(ValueError):
                downloads.safe_path(self.root, name)

    def test_missing_explicit_remote_file_fails(self):
        with self.assertRaisesRegex(ValueError, 'Missing required'):
            downloads.select_files([{'name': 'one'}], {'files': ['one', 'two']})

    def test_bin_only_repository_keeps_weights(self):
        entries = [{'name': 'config.json'}, {'name': 'pytorch_model.bin'}]
        self.assertEqual(downloads.select_files(entries, {}), entries)

    def test_metadata_failure_invalidates_old_completion(self):
        manifest = self.root / 'download-manifest.json'
        downloads.atomic_json(manifest, {'complete': True})
        with patch.object(downloads, 'modelscope_files', side_effect=OSError('offline')):
            with self.assertRaises(OSError):
                downloads.download_from_modelscope({'repo': 'a/b'}, self.root, manifest)
        self.assertFalse(json.loads(manifest.read_text())['complete'])

    def test_modelscope_revision_is_not_hf_commit(self):
        manifest = self.root / 'download-manifest.json'
        with patch.object(downloads, 'modelscope_files', return_value=[]) as inventory, patch.object(downloads, 'install_entries') as install:
            downloads.download_from_modelscope({'repo': 'a/b', 'revision': 'hf-commit'}, self.root, manifest)
        inventory.assert_called_once_with('a/b', 'master')
        self.assertEqual(install.call_args.args[5], 'master')

    def test_manifest_not_complete_when_required_file_missing(self):
        manifest = self.root / 'download-manifest.json'
        with self.assertRaises(ValueError):
            downloads.install_entries({'id': 'test', 'files': ['missing']}, self.root, manifest, [],
                                      'huggingface', 'rev', 'a/b', lambda n: n)
        self.assertFalse(json.loads(manifest.read_text())['complete'])

    def test_atomic_manifest_failure_preserves_previous(self):
        manifest = self.root / 'manifest.json'
        downloads.atomic_json(manifest, {'old': True})
        with patch.object(downloads.os, 'replace', side_effect=OSError('locked')):
            with self.assertRaises(OSError):
                downloads.atomic_json(manifest, {'new': True})
        self.assertEqual(json.loads(manifest.read_text()), {'old': True})
        self.assertEqual(list(self.root.glob('*.tmp')), [])

    def test_atomic_manifest_retries_transient_windows_lock(self):
        manifest = self.root / 'manifest.json'
        original = downloads.os.replace
        calls = []
        def replace(source, target):
            calls.append(source)
            if len(calls) == 1:
                raise PermissionError('scanner temporarily holds manifest')
            original(source, target)
        with patch.object(downloads.os, 'replace', side_effect=replace):
            downloads.atomic_json(manifest, {'complete': True})
        self.assertEqual(len(calls), 2)
        self.assertTrue(json.loads(manifest.read_text())['complete'])

    def test_verify_rejects_incomplete_empty_unsafe_and_missing_files(self):
        target = self.root / 'asr/models/test'
        target.mkdir(parents=True)
        model = {'id': 'test', 'directory': 'asr/models/test', 'repo': 'a/b', 'revision': 'rev', 'files': ['required']}
        base = {'complete': True, 'repo': 'a/b', 'source': 'huggingface', 'revision': 'rev'}
        variants = [dict(base, complete=False, files=[]), dict(base, files=[]),
                    dict(base, files=[{'name': '../evil', 'size': 1, 'sha256': 'a'*64}]),
                    dict(base, files=[{'name': 'required', 'size': 1, 'sha256': 'a'*64}])]
        with patch.object(downloads, 'ROOT', self.root):
            for variant in variants:
                downloads.atomic_json(target / 'download-manifest.json', variant)
                with self.subTest(variant=variant), self.assertRaises(ValueError):
                    downloads.download(model, verify_only=True)

    def test_huggingface_requires_every_allowlisted_file(self):
        info = types.SimpleNamespace(sha='pinned', siblings=[])
        api = types.SimpleNamespace(model_info=lambda *a, **kw: info)
        sdk = types.SimpleNamespace(HfApi=lambda **kw: api)
        with patch.dict(sys.modules, {'huggingface_hub': sdk}):
            with self.assertRaisesRegex(ValueError, 'Missing required'):
                downloads.download_from_huggingface({'id': 'test', 'repo': 'a/b', 'revision': 'pinned', 'files': ['weights.ckpt']},
                                                    self.root, self.root / 'manifest.json')

    def test_successful_install_writes_complete_hashed_manifest(self):
        manifest = self.root / 'manifest.json'
        self.path.write_bytes(self.data)
        entry = {'name': 'model.bin', 'size': len(self.data), 'sha256': self.sha}
        with patch.object(downloads.shutil, 'disk_usage', return_value=types.SimpleNamespace(free=10**12)), patch.object(downloads, 'download_url_resumable') as fetch:
            downloads.install_entries({'id': 'test'}, self.root, manifest, [entry], 'huggingface', 'rev', 'a/b', lambda n: n)
        fetch.assert_not_called()
        result = json.loads(manifest.read_text())
        self.assertTrue(result['complete'])
        self.assertEqual(result['files'][0]['sha256'], self.sha)

    def test_missing_shard_prevents_complete_manifest(self):
        data = json.dumps({'weight_map': {'weight': 'missing.safetensors'}}).encode()
        index = self.root / 'model.safetensors.index.json'
        index.write_bytes(data)
        manifest = self.root / 'manifest.json'
        entries = [{'name': index.name, 'size': len(data), 'sha256': hashlib.sha256(data).hexdigest()}]
        with patch.object(downloads.shutil, 'disk_usage', return_value=types.SimpleNamespace(free=10**12)), self.assertRaisesRegex(ValueError, 'Missing model shard'):
            downloads.install_entries({'id': 'test'}, self.root, manifest, entries, 'huggingface', 'rev', 'a/b', lambda n: n)
        self.assertFalse(json.loads(manifest.read_text())['complete'])

    def test_safetensors_selection_keeps_tokenizer_bin(self):
        entries = [{'name': name} for name in ['model.safetensors', 'tokenizer.bin', 'pytorch_model.bin', 'pytorch_model.bin.index.json']]
        self.assertEqual([e['name'] for e in downloads.select_files(entries, {})], ['model.safetensors', 'tokenizer.bin'])

    def test_modelscope_truncated_inventory_rejected(self):
        with patch.object(downloads, 'request_json', return_value={'Data': {'HasMore': True, 'Files': []}}), self.assertRaisesRegex(RuntimeError, 'paginated'):
            downloads.modelscope_files('a/b')

    def test_missing_source_hash_preserves_existing_model(self):
        self.path.write_bytes(self.data)
        with self.assertRaisesRegex(ValueError, 'integrity hash'):
            downloads.install_entries({'id': 'test'}, self.root, self.root / 'manifest.json',
                                      [{'name': 'model.bin', 'size': len(self.data), 'sha256': None}],
                                      'modelscope', 'master', 'a/b', lambda n: n)
        self.assertEqual(self.path.read_bytes(), self.data)

    def test_voice_archive_traversal_rejected(self):
        import zipfile
        archive = self.root / 'downloads/G2PWModel.zip'
        archive.parent.mkdir()
        with zipfile.ZipFile(archive, 'w') as stream:
            stream.writestr('G2PWModel/../../evil', b'bad')
        with patch.object(voice, 'ROOT', self.root), patch.object(voice, 'UPSTREAM', self.root / 'upstream'), self.assertRaises(ValueError):
            voice.extract_g2pw()
        self.assertFalse((self.root / 'evil').exists())

    def voice_item(self):
        return {'repo': 'lj1995/GPT-SoVITS', 'source': 'chinese-hubert-base/config.json',
                'revision': 'a'*40, 'destination': 'model.bin', 'bytes': len(self.data),
                'sha256': self.sha, 'git_blob_sha1': None}

    def test_voice_preserves_verified_existing_file_offline(self):
        self.path.write_bytes(self.data)
        with patch.object(voice, 'ROOT', self.root), patch.object(voice, 'download_url_resumable') as fetch:
            result = voice.download(self.voice_item())
        fetch.assert_not_called()
        self.assertEqual(result['sha256'], self.sha)

    def test_voice_modelscope_falls_back_to_pinned_mirror(self):
        urls = []
        def fetch(url, dest, *args):
            urls.append(url)
            if len(urls) == 1:
                raise ValueError('mirror drift')
            dest.write_bytes(self.data)
        with patch.object(voice, 'ROOT', self.root), patch.object(voice, 'download_url_resumable', side_effect=fetch):
            voice.download(self.voice_item())
        self.assertIn('modelscope.cn', urls[0])
        self.assertIn('/resolve/' + 'a'*40 + '/', urls[1])
        self.assertIn('hf-mirror.com', urls[1])

    def test_voice_hf_source_never_uses_modelscope(self):
        with patch.object(voice, 'ROOT', self.root), patch.object(voice, 'download_url_resumable', side_effect=lambda url, dest, *args: dest.write_bytes(self.data)) as fetch:
            voice.download(self.voice_item(), 'huggingface')
        self.assertTrue(fetch.call_args.args[0].startswith('https://huggingface.co/'))

    def test_voice_inventory_follows_pagination(self):
        pages = [Response(json.dumps([{'path': 'first'}]).encode(), headers={'Link': '<https://huggingface.co/page2>; rel="next"'}),
                 Response(json.dumps([{'path': 'second'}]).encode())]
        with patch.object(voice, 'api', return_value={'sha': 'a'*40}), patch.object(voice.urllib.request, 'urlopen', side_effect=pages):
            revision, entries = voice.inventory('a/b')
        self.assertEqual([e['path'] for e in entries], ['first', 'second'])

    def test_voice_manifest_missing_encoder_is_rejected(self):
        files = [{'path': p, 'type': 'file', 'size': 1, 'oid': 'a'*40} for p in
                 ['s1v3.ckpt', 'gsv-v5-pretrained/s2Gv5turbo.pth', 'gsv-v5-pretrained/s2Gv5dev.pth', 'gsv-v5-pretrained/vocoder.pth']]
        with patch.object(voice, 'inventory', return_value=('a'*40, files)), self.assertRaisesRegex(RuntimeError, 'Incomplete'):
            voice.make_manifest()


if __name__ == '__main__':
    unittest.main()
