"""Read-only deployment status; does not load models or download resources."""
from __future__ import annotations
import argparse
import json
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parent
PROBE = r'''
import json,sys,site
import torch,transformers
try:
    import bitsandbytes
    bnb=bitsandbytes.__version__
except ImportError:
    bnb=None
print(json.dumps({'executable':sys.executable,'python':sys.version.split()[0],
 'user_site_enabled':site.ENABLE_USER_SITE,'torch':torch.__version__,'transformers':transformers.__version__,
 'cuda':torch.cuda.is_available(),'gpu':torch.cuda.get_device_name(0) if torch.cuda.is_available() else None,
 'bitsandbytes':bnb}))
'''

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--service',choices=['all','asr','translation','voice-clone'],default='all')
    args=parser.parse_args()
    services=['asr','translation','voice-clone'] if args.service=='all' else [args.service]
    specs=json.loads((ROOT/'model-sources.json').read_text('utf-8'))['models']
    rows=[]
    for name in services:
        python=ROOT/name/'.venv/Scripts/python.exe'
        row={'service':name,'environment_exists':python.exists(),'models':[]}
        if python.exists():
            try:
                result=subprocess.run([str(python),'-s','-c',PROBE],cwd=ROOT/name,capture_output=True,text=True,encoding='utf-8',errors='replace',timeout=90)
                if result.returncode==0:
                    row['dependencies']=json.loads(result.stdout.strip().splitlines()[-1])
                else: row['dependency_error']=(result.stderr or result.stdout)[-1800:]
            except Exception as exc: row['dependency_error']=str(exc)
        for spec in specs:
            if not spec['directory'].startswith(name+'/'): continue
            directory=ROOT/spec['directory']
            manifest=directory/'download-manifest.json'
            model={'id':spec['id'],'revision':spec['revision'],'complete':False}
            if manifest.exists():
                data=json.loads(manifest.read_text('utf-8'))
                model.update(complete=data.get('complete',False),verified_bytes=sum(f['size'] for f in data.get('files',[])))
            model['partial_bytes']=sum(p.stat().st_size for p in directory.rglob('*.incomplete') if p.is_file())
            row['models'].append(model)
        if name=='voice-clone':
            complete = False
            verified_bytes = 0
            try:
                model_files = json.loads((ROOT/name/'models.verified.json').read_text('utf-8'))
                runtime_files = json.loads((ROOT/name/'runtime.manifest.json').read_text('utf-8'))
                complete = bool(model_files and runtime_files) and all(
                    (ROOT/name/f['destination']).is_file() and (ROOT/name/f['destination']).stat().st_size==f['bytes']
                    for f in model_files+runtime_files)
                verified_bytes = sum(f['bytes'] for f in model_files+runtime_files)
            except (OSError,ValueError,KeyError): pass
            row['models'].append({'id':'gpt-sovits-v5','complete':complete,'verified_bytes':verified_bytes})
            row['note']='Full V5 model load and cloning are separate smoke-test stages.'
        rows.append(row)
    print(json.dumps(rows,ensure_ascii=False,indent=2))
    return 0 if all('dependencies' in r and all(m['complete'] for m in r['models']) for r in rows) else 1

if __name__=='__main__': sys.exit(main())
