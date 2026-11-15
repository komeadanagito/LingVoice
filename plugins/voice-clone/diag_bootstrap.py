"""Local reproduction: original Chinese reference versus verified English reference."""
from pathlib import Path
import json
import soundfile as sf
import service
from local_runtime import load_pipeline, ROOT
plan=json.loads((ROOT/'repair-plan.json').read_text('utf-8'))
pipeline=load_pipeline('cuda','v5turbo')
Request=service.schema()
prompt='当然，我不是说把别人的作品偷过来改个名字就是自己的，那不叫创作，那叫等律师函。'
def generate(index, ref, text, lang, output, seed=42):
    target=plan['groups'][index]['speechText'].replace('—', ', ')
    if target[-1] not in '.!?': target+='.'
    request=Request.model_validate(dict(text=target,text_lang='en',ref_audio_path=ref,prompt_text=text,prompt_lang=lang,consent=True,seed=seed))
    audio=service.synthesize(pipeline,request)
    (ROOT/output).write_bytes(audio)
    print('SAVED',index+1,output,len(audio),flush=True)
    return target
first=generate(0,'repair-source.wav',prompt,'zh','references/repair-english.wav')
generate(3,'repair-source.wav',prompt,'zh','repair-original-4.wav')
generate(3,'repair-english.wav',first,'en','repair-english-4.wav')
