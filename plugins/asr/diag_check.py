from pathlib import Path
import shutil,json
from server import infer
root=Path(__file__).resolve().parents[1]
for name,relative in [('first','voice-clone/references/repair-english.wav'),('old4','voice-clone/repair-original-4.wav'),('new4','voice-clone/repair-english-4.wav')]:
    target=root/'asr/inputs'/f'repair-{name}.wav'
    shutil.copyfile(root/relative,target)
    result=infer(dict(audio_path=target.name,align=False,chunk_seconds=20,max_new_tokens=1024,device='cuda'))
    print('RESULT',name,result['text'],flush=True)
