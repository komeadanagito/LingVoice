"""Dependency-free safety/HTTP contract tests; no model downloads or GPU use."""
import importlib.util
import json
from pathlib import Path
import threading
import unittest
from urllib.error import HTTPError
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('asr_runtime', ROOT / 'server.py')
runtime = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runtime)


class SafetyTests(unittest.TestCase):
    def test_path_escape(self):
        for path in ('../server.py', str(ROOT / 'server.py'), 'https://example.com/a.wav', ''):
            with self.subTest(path=path), self.assertRaises(runtime.PluginError):
                runtime.input_path(path)

    def test_values(self):
        for number in (True, float('nan'), float('inf'), -1, '20', 31):
            with self.subTest(number=number), self.assertRaises(runtime.PluginError):
                runtime.bounded_number(number, 'chunk_seconds', 5, 30)

    def test_unknown_fields(self):
        with self.assertRaisesRegex(runtime.PluginError, 'Unknown'):
            runtime.infer({'arbitrary_output': 'elsewhere'})

    def test_non_object(self):
        with self.assertRaises(runtime.PluginError):
            runtime.infer([])

    def test_raw_overlapping_timestamps_are_preserved(self):
        items, overlaps = runtime.decode_raw_word_times([13, 15, 13, 16], ['Quilter', 'is'], 80)
        self.assertEqual(items[0]['end_time'], 1.2)
        self.assertEqual(items[1]['start_time'], 1.04)
        self.assertEqual(overlaps, 1)

    def test_raw_reversed_word_timestamps_fail(self):
        with self.assertRaises(runtime.PluginError):
            runtime.decode_raw_word_times([15, 13], ['word'], 80)

    def test_raw_timestamp_count_mismatch_fails(self):
        with self.assertRaises(runtime.PluginError):
            runtime.decode_raw_word_times([1], ['word'], 80)

    def test_language_count(self):
        self.assertEqual(len(runtime.LANGUAGES), 11)


class HTTPTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = runtime.HTTPServer(('127.0.0.1', 0), runtime.Handler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.url = f'http://127.0.0.1:{cls.server.server_port}'

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()

    def test_health(self):
        with urlopen(self.url + '/health', timeout=5) as response:
            self.assertTrue(json.load(response)['offline'])

    def test_no_file_serving(self):
        with self.assertRaises(HTTPError) as error:
            urlopen(self.url + '/server.py', timeout=5)
        self.assertEqual(error.exception.code, 404)

    def test_browser_origin_rejected(self):
        with self.assertRaises(HTTPError) as error:
            urlopen(Request(self.url + '/health', headers={'Origin': 'https://evil.example'}), timeout=5)
        self.assertEqual(error.exception.code, 403)

    def test_rebinding_rejected(self):
        with self.assertRaises(HTTPError) as error:
            urlopen(Request(self.url + '/health', headers={'Host': 'evil.example'}), timeout=5)
        self.assertEqual(error.exception.code, 403)

    def test_body_limit(self):
        with self.assertRaises(HTTPError) as error:
            urlopen(Request(self.url + '/infer', data=b' ' * (runtime.MAX_BODY + 1), headers={'Content-Type': 'application/json'}), timeout=5)
        self.assertEqual(error.exception.code, 413)

    def test_path_rejected_before_model_import(self):
        with self.assertRaises(HTTPError) as error:
            urlopen(Request(self.url + '/infer', data=b'{"audio_path":"../server.py"}', headers={'Content-Type': 'application/json'}), timeout=5)
        self.assertEqual(error.exception.code, 400)
        self.assertEqual(json.load(error.exception)['error'], 'invalid_request')


if __name__ == '__main__':
    unittest.main(verbosity=2)
