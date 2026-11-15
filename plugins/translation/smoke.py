"""Offline real-model translation smoke test; no audio or network access."""
import json
from pathlib import Path
import time
from service import Engine


def main():
    import torch
    root=Path(__file__).resolve().parent
    report={'service':'translation','download':False,'load':False,'inference':False}
    engine=Engine()
    start=time.monotonic()
    try:
        report['download']=engine.ready()
        if torch.cuda.is_available(): torch.cuda.reset_peak_memory_stats()
        engine.load()
        report['load']=True
        result=engine.infer({'task':'translate','texts':['Hello, welcome to this video.','Please keep the original timestamps.'],
                             'target_language':'Chinese','max_new_tokens':256})
        if not any('\u4e00'<=char<='\u9fff' for text in result['texts'] for char in text):
            raise ValueError('Expected Chinese output from the smoke request.')
        report.update(inference=True,result=result,environment=engine.status())
        report['peak_cuda_allocated_mib']=round(torch.cuda.max_memory_allocated()/1024**2,1)
    except Exception as exc:
        report['error']=f'{type(exc).__name__}: {exc}'
        raise
    finally:
        report['elapsed_seconds']=round(time.monotonic()-start,2)
        engine.unload()
        state=root/'.state'
        state.mkdir(exist_ok=True)
        (state/'validation.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),'utf-8')
        print(json.dumps(report,ensure_ascii=False,indent=2),flush=True)

if __name__=='__main__':main()
