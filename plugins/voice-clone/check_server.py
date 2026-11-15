"""Start the real CPU service, verify readiness, and always stop it. No synthesis."""
import json
import subprocess
import sys
import time
import urllib.request
from local_runtime import ROOT

port = 19892
process = subprocess.Popen([sys.executable, str(ROOT / 'service.py'), 'serve', '--device', 'cpu', '--port', str(port)], cwd=ROOT)
try:
    deadline = time.monotonic() + 120
    while True:
        if process.poll() is not None:
            raise RuntimeError(f'Local service exited: {process.returncode}')
        try:
            with urllib.request.urlopen(f'http://127.0.0.1:{port}/health', timeout=1) as response:
                result = json.load(response)
            if result.get('version') != 'v5turbo' or result.get('status') != 'ready':
                raise RuntimeError(f'Unexpected readiness: {result}')
            break
        except (OSError, TimeoutError):
            if time.monotonic() > deadline:
                raise RuntimeError('Local service startup timeout')
            # A bounded readiness probe, not a long-lived background process.
            try:
                process.wait(timeout=0.5)
            except subprocess.TimeoutExpired:
                pass
    (ROOT / 'server.smoke.json').write_text(json.dumps(result, indent=2) + '\n', encoding='utf-8')
    print('REAL LOCALHOST SERVICE READY', json.dumps(result), flush=True)
finally:
    process.terminate()
    try:
        process.wait(timeout=15)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait()
