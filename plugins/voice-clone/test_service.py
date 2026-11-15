"""Validation tests; no voice samples and no synthesis calls."""
import argparse
import json
import unittest
from unittest.mock import patch
from local_runtime import ROOT, configure, model_config

configure()
from service import AudioQualityError, _estimate_duration_bounds, _score_generated_audio, create_app, schema, synthesize, validate_reference


class ValidationTests(unittest.TestCase):
    def setUp(self):
        self.Request = schema()
        self.valid = dict(text='Test.', text_lang='en', ref_audio_path='authorized.wav',
                          prompt_text='An authorized recording.', prompt_lang='en', consent=True)

    def test_explicit_consent(self):
        for value in (False, 'true', 1, None):
            with self.subTest(value=value), self.assertRaises(ValueError):
                self.Request.model_validate(dict(self.valid, consent=value))

    def test_no_control_or_model_parameters(self):
        for name in ('weights_path', 'command', 'aux_ref_audio_paths', 'sample_steps', 'batch_size'):
            with self.subTest(field=name), self.assertRaises(ValueError):
                self.Request.model_validate(dict(self.valid, **{name: 'untrusted'}))

    def test_bounded_text_and_speed(self):
        for change in (dict(text='x' * 501), dict(speed_factor=2.0), dict(text_lang='auto')):
            with self.assertRaises(ValueError):
                self.Request.model_validate(dict(self.valid, **change))

    def test_reference_scope(self):
        for value in ('../README.md', '../../other.wav', str(ROOT / 'outside.wav'), 'https://example.com/a.wav', r'\\server\share\voice.wav', 'C:secret.wav'):
            with self.subTest(path=value), self.assertRaises(ValueError):
                validate_reference(self.Request.model_validate(dict(self.valid, ref_audio_path=value)))

    def test_no_old_model_fallback(self):
        with self.assertRaises(ValueError):
            model_config('cpu', 'v4')

    def test_offline_network_guard(self):
        import socket
        with socket.socket() as connection:
            with self.assertRaises(PermissionError):
                connection.connect(('198.51.100.1', 443))
        with self.assertRaises(PermissionError):
            socket.getaddrinfo('example.com', 443)

    def test_http_boundaries_without_loading_models(self):
        from fastapi.testclient import TestClient
        args = argparse.Namespace(device='cpu', variant='v5turbo', port=9892)
        with patch('service.synthesize', side_effect=AssertionError('No synthesis should occur')):
            client = TestClient(create_app(None, args), base_url='http://127.0.0.1:9892')
            token = (ROOT / 'state/server.token').read_text(encoding='utf-8').strip()
            auth = {'Authorization': 'Bearer ' + token}
            self.assertEqual(client.get('/health').status_code, 200)
            self.assertEqual(client.post('/tts', json=self.valid).status_code, 401)
            self.assertEqual(client.post('/tts', json=self.valid, headers=dict(auth, Origin='http://evil.test')).status_code, 403)
            self.assertEqual(client.get('/health', headers={'Host': 'evil.test'}).status_code, 400)
            self.assertEqual(client.post('/tts', json=dict(self.valid, consent=False), headers=auth).status_code, 422)
            self.assertEqual(client.post('/tts', json=self.valid, headers=auth).status_code, 422)
            self.assertEqual(client.post('/tts', json=self.valid, headers=dict(auth, **{'Transfer-Encoding':'chunked'})).status_code, 400)
            self.assertEqual(client.post('/tts', content='x' * 16385, headers=auth).status_code, 413)
            self.assertEqual(client.post('/control', json={'command': 'exit'}, headers=auth).status_code, 404)
            self.assertEqual(client.get('/set_gpt_weights', headers=auth).status_code, 404)

    def test_quality_failure_has_actionable_http_error(self):
        from fastapi.testclient import TestClient
        args = argparse.Namespace(device='cpu', variant='v5turbo', port=9892)
        client = TestClient(create_app(None, args), base_url='http://127.0.0.1:9892')
        token = (ROOT / 'state/server.token').read_text(encoding='utf-8').strip()
        with patch('service.validate_reference', return_value=ROOT / 'references/authorized.wav'), patch('service.synthesize', side_effect=AudioQualityError('Silent output; try a different clean voice reference.')):
            response = client.post('/tts', json=self.valid, headers={'Authorization': 'Bearer ' + token})
        self.assertEqual(response.status_code, 422)
        self.assertIn('clean voice reference', response.json()['detail'])
        self.assertNotIn('inspect local process log', response.text)

    def test_all_bad_synthesis_attempts_are_rejected(self):
        import numpy as np
        from types import SimpleNamespace
        pipeline = SimpleNamespace(configs=SimpleNamespace(version='v5turbo'), run=lambda _: [(24000, np.zeros(24000, dtype=np.int16))])
        with patch('service.validate_reference', return_value=ROOT / 'references/authorized.wav'):
            with self.assertRaisesRegex(RuntimeError, 'failed audio quality'):
                synthesize(pipeline, self.Request.model_validate(self.valid))

    def test_audio_quality_and_repetition_guard(self):
        import numpy as np
        min_d, ideal_d, max_d = _estimate_duration_bounds("I can't paint, I don't have musical talent.", 'en', 1.0)
        self.assertTrue(0.5 < min_d < ideal_d < max_d < 8.0)
        rate = 24000
        # Silent output should fail
        _, ok_silent = _score_generated_audio(np.zeros(rate * 2, dtype=np.float32), rate, min_d, ideal_d, max_d)
        self.assertFalse(ok_silent)
        # Overlong runaway output should fail
        t_long = np.linspace(0, 12.0, rate * 12, endpoint=False, dtype=np.float32)
        wave_long = 0.25 * np.sin(2 * np.pi * 220 * t_long)
        _, ok_long = _score_generated_audio(wave_long, rate, min_d, ideal_d, max_d)
        self.assertFalse(ok_long)
        # Periodic timbre alone is not proof of repeated words; the caller's
        # ASR transcript validator is responsible for content repetition.
        t_unit = np.linspace(0, 1.5, int(rate * 1.5), endpoint=False, dtype=np.float32)
        unit = 0.25 * np.sin(2 * np.pi * (180 + 80 * np.sin(2 * np.pi * 3 * t_unit)) * t_unit)
        looped = np.concatenate([unit, unit, unit])
        _, ok_loop = _score_generated_audio(looped, rate, 0.5, 4.0, 6.0)
        self.assertTrue(ok_loop)


if __name__ == '__main__':
    unittest.main(verbosity=2)
