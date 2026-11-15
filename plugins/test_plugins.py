"""Offline control-plane tests. No model download, inference or CUDA allocation."""
import importlib.util
import json
from pathlib import Path
import socket
import subprocess
import sys
import time
import unittest
import urllib.error
import urllib.request

ROOT=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('translation_service',ROOT/'translation/service.py')
translation=importlib.util.module_from_spec(spec)
spec.loader.exec_module(translation)

class ValidationTests(unittest.TestCase):
    def test_invalid_payloads_fail_before_model_loading(self):
        engine=translation.Engine()
        for request in [None,{}, {'texts':['x'],'task':'arbitrary'}, {'texts':['x'],'path':'C:/secret'},
                        {'texts':['']},{'texts':['x']*11},{'texts':['x'],'max_new_tokens':True},
                        {'texts':['x'],'context':[]},{'texts':['x'],'target_language':42}]:
            with self.subTest(request=request), self.assertRaises(ValueError): engine.infer(request)
        self.assertIsNone(engine.model)

    def test_translation_rejects_empty_source_fallback_and_wrong_language(self):
        from contextlib import nullcontext
        from types import SimpleNamespace
        from unittest.mock import patch
        class Inputs(dict):
            def to(self, _): return self
        engine = translation.Engine()
        engine.load = lambda: None
        engine.model = SimpleNamespace(generate=lambda **_: [[0, 1]])
        for raw in ('[""]', '[null]', '[42]', '["他每天都画得特别开心。"]', 'unstructured prose'):
            engine.tokenizer = SimpleNamespace(
                apply_chat_template=lambda *a, **k: Inputs(input_ids=SimpleNamespace(shape=(1, 1))),
                decode=lambda *a, **k: raw)
            with self.subTest(raw=raw), patch.dict(sys.modules, {'torch': SimpleNamespace(inference_mode=nullcontext)}):
                with self.assertRaises(ValueError):
                    engine.infer({'texts': ['他喜欢画画。'], 'target_language': 'en'})

    def test_gpu_lease_excludes_another_process(self):
        from gpu_lease import gpu_lease
        code="from gpu_lease import gpu_lease\nwith gpu_lease(): print('acquired')"
        with gpu_lease():
            run=subprocess.run([sys.executable,'-s','-c',code],cwd=ROOT,capture_output=True,text=True)
            self.assertNotEqual(run.returncode,0)
            self.assertIn('Another local plugin',run.stderr)
        run=subprocess.run([sys.executable,'-s','-c',code],cwd=ROOT,capture_output=True,text=True)
        self.assertEqual(run.returncode,0,run.stderr)

class HttpTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with socket.socket() as sock:
            sock.bind(('127.0.0.1',0));cls.port=sock.getsockname()[1]
        cls.child=subprocess.Popen([sys.executable,'-s',str(ROOT/'translation/service.py'),'serve','--port',str(cls.port)],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        cls.base=f'http://127.0.0.1:{cls.port}'
        for _ in range(50):
            try:
                with urllib.request.urlopen(cls.base+'/health',timeout=1) as res: cls.health=json.load(res)
                break
            except OSError: time.sleep(.1)
        else:
            cls.child.terminate();cls.child.wait(timeout=5)
            raise RuntimeError('Test server failed to start')
        cls.token=(ROOT/'translation/.state/token').read_text('utf-8')

    @classmethod
    def tearDownClass(cls):
        cls.child.terminate();cls.child.wait(timeout=10)
        (ROOT/'translation/.state/token').unlink(missing_ok=True)

    def request(self,body,token=None,origin=None):
        headers={'Content-Type':'application/json'}
        if token:headers['Authorization']='Bearer '+token
        if origin:headers['Origin']=origin
        req=urllib.request.Request(self.base+'/infer',data=json.dumps(body).encode(),headers=headers)
        try:
            with urllib.request.urlopen(req,timeout=5) as res:return res.status,json.load(res)
        except urllib.error.HTTPError as res:return res.code,json.load(res)

    def test_health_is_not_model_readiness(self):
        self.assertEqual(self.health,{'service':'translation','running':True})

    def test_requests_require_token(self):
        self.assertEqual(self.request({'texts':['hello']})[0],403)

    def test_browser_origin_is_rejected_even_with_token(self):
        self.assertEqual(self.request({'texts':['hello']},self.token,'https://example.com')[0],403)

    def test_valid_auth_still_validates_payload(self):
        self.assertEqual(self.request({'texts':[]},self.token)[0],400)

if __name__=='__main__':unittest.main()
