"""Foreground process supervisor. Starts/stops only recognized plugin processes."""
from __future__ import annotations
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import psutil

ROOT = Path(__file__).resolve().parent
STATE = ROOT / '.state'
SERVICES = {'asr':('server.py',9871),'translation':('service.py',9872),'voice-clone':('service.py',9873)}


def environment(service):
    env = dict(os.environ)
    for key in ('PYTHONPATH','PYTHONHOME','VIRTUAL_ENV'):
        env.pop(key,None)
    cache = ROOT/service/'cache'
    for key, name in {'HF_HOME':'huggingface','HF_HUB_CACHE':'huggingface/hub','TORCH_HOME':'torch','TEMP':'tmp','TMP':'tmp','XDG_CACHE_HOME':'xdg','NLTK_DATA':'nltk_data','NUMBA_CACHE_DIR':'numba'}.items():
        path = cache/name
        path.mkdir(parents=True,exist_ok=True)
        env[key]=str(path)
    env.update(PYTHONNOUSERSITE='1',PYTHONUTF8='1',PYTHONIOENCODING='utf-8',HF_HUB_OFFLINE='1',TRANSFORMERS_OFFLINE='1',HF_HUB_DISABLE_TELEMETRY='1')
    return env


def identity(state):
    try:
        process=psutil.Process(state['pid'])
        cmd=process.cmdline()
        return process if (abs(process.create_time()-state['created'])<0.1 and
            any(Path(a).resolve()==Path(state['script']).resolve() for a in cmd[1:] if not a.startswith('-'))) else None
    except (psutil.Error,KeyError,OSError): return None


def active():
    for file in STATE.glob('*.json'):
        try: state=json.loads(file.read_text('utf-8'))
        except (OSError,ValueError): continue
        process=identity(state)
        if process is not None: yield file,state,process


def start(service):
    STATE.mkdir(exist_ok=True)
    running=list(active())
    if running: raise RuntimeError(f"Stop active plugin first: {running[0][1]['service']}")
    filename,port=SERVICES[service]
    python=ROOT/service/'.venv/Scripts/python.exe'
    script=ROOT/service/filename
    if not python.is_file() or not script.is_file(): raise RuntimeError('Environment or entrypoint not ready.')
    args=[str(python),'-s',str(script)]
    if service in ('translation','voice-clone'): args+=['serve']
    args+=['--port',str(port)]
    state_file=STATE/f'{service}.json'
    child=subprocess.Popen(args,cwd=ROOT/service,env=environment(service))
    state={'service':service,'pid':child.pid,'created':psutil.Process(child.pid).create_time(),'script':str(script),'port':port}
    state_file.write_text(json.dumps(state,indent=2),'utf-8')
    print(f'{service} PID {child.pid}; foreground supervisor, Ctrl+C to stop.',flush=True)
    try: return child.wait()
    except KeyboardInterrupt:
        terminate(psutil.Process(child.pid))
        return child.wait()
    finally:
        state_file.unlink(missing_ok=True)


def terminate(process):
    children=process.children(recursive=True)
    for child in reversed(children):
        try: child.terminate()
        except psutil.NoSuchProcess: pass
    try: process.terminate()
    except psutil.NoSuchProcess: pass
    _,alive=psutil.wait_procs([process,*children],timeout=10)
    for child in alive:
        try: child.kill()
        except psutil.NoSuchProcess: pass


def main():
    p=argparse.ArgumentParser()
    p.add_argument('command',choices=['start','stop','status'])
    p.add_argument('service',choices=[*SERVICES,'all'],default='all',nargs='?')
    args=p.parse_args()
    if args.command=='start':
        if args.service=='all': p.error('Choose one service; simultaneous GPU residency is disabled.')
        return start(args.service)
    rows=[]
    for file,state,process in active():
        if args.service not in ('all',state['service']): continue
        if args.command=='stop': terminate(process); file.unlink(missing_ok=True)
        rows.append({**state,'stopped':args.command=='stop'})
    print(json.dumps(rows,ensure_ascii=False,indent=2))
    return 0

if __name__=='__main__':
    try: sys.exit(main())
    except Exception as exc: print(str(exc),file=sys.stderr); sys.exit(1)
