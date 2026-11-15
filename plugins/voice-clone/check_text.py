"""Exercise installed text resources without generating speech or using a voice."""
import json
from local_runtime import ROOT, configure

configure()
from text.cleaner import clean_text

results = {}
for language, text in [('zh', '你好，这是本地语音插件的文字检查。'),
                       ('en', 'This is a local text resource check.'),
                       ('ja', 'こんにちは。'), ('yue', '你好。'), ('ko', '안녕하세요.')]:
    phones, word2ph, normalized = clean_text(text, language, version='v5turbo')
    if not phones:
        raise RuntimeError(f'No phonemes produced for {language}')
    results[language] = dict(status='ok', phoneme_count=len(phones), normalized=normalized)
    print(f'{language}: {len(phones)} phonemes', flush=True)
(ROOT / 'text-resources.smoke.json').write_text(json.dumps(results, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
