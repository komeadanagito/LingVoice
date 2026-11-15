"""Project-local environment; import before any third-party libraries."""
from pathlib import Path
import os
import sys

ROOT = Path(__file__).resolve().parent
UPSTREAM = ROOT / 'upstream'
SOURCE_REVISION = 'e91506f1fba265e1841617c3042a1573206a7351'
_OFFLINE_GUARD_INSTALLED = False


def _offline_audit(event, args):
    if event == 'socket.connect':
        address = args[1]
        if isinstance(address, tuple) and address[0] in ('127.0.0.1', '::1', 'localhost'):
            return
        raise PermissionError('Inference is offline: outbound connections are disabled. Prepare missing resources with install.ps1.')
    if event == 'socket.getaddrinfo' and args[0] not in (None, '127.0.0.1', '::1', 'localhost'):
        raise PermissionError('Inference is offline: external DNS resolution is disabled.')


def configure(*, offline=True):
    global _OFFLINE_GUARD_INSTALLED
    if offline and not _OFFLINE_GUARD_INSTALLED:
        sys.addaudithook(_offline_audit)
        _OFFLINE_GUARD_INSTALLED = True
    for name in ('PYTHONPATH', 'PYTHONHOME'):
        os.environ.pop(name, None)
    paths = {
        'HF_HOME': ROOT / 'cache/huggingface',
        'HF_HUB_CACHE': ROOT / 'cache/huggingface/hub',
        'TORCH_HOME': ROOT / 'cache/torch',
        'TORCH_EXTENSIONS_DIR': ROOT / 'cache/torch-extensions',
        'CUDA_CACHE_PATH': ROOT / 'cache/cuda',
        'HF_DATASETS_CACHE': ROOT / 'cache/huggingface/datasets',
        'FTLANG_CACHE': UPSTREAM / 'GPT_SoVITS/pretrained_models/fast_langdetect',
        'XDG_CACHE_HOME': ROOT / 'cache',
        'TEMP': ROOT / 'tmp', 'TMP': ROOT / 'tmp',
        'NUMBA_CACHE_DIR': ROOT / 'cache/numba',
        'MPLCONFIGDIR': ROOT / 'cache/matplotlib',
        'NLTK_DATA': UPSTREAM / 'runtime/nltk_data',
    }
    for name, path in paths.items():
        path.mkdir(parents=True, exist_ok=True)
        os.environ[name] = str(path)
    os.environ['PYTHONNOUSERSITE'] = '1'
    os.environ['HF_HUB_DISABLE_TELEMETRY'] = '1'
    os.environ['HF_HUB_DISABLE_XET'] = '1'
    os.environ['DO_NOT_TRACK'] = '1'
    os.environ['G2PW'] = '1'
    os.environ['bert_path'] = str(UPSTREAM / 'GPT_SoVITS/pretrained_models/chinese-roberta-wwm-ext-large')
    os.environ['TOKENIZERS_PARALLELISM'] = 'false'
    os.environ['CUDAGraph'] = '0'  # Bounded 8 GB VRAM; no optional acceleration compilation.
    if offline:
        os.environ['HF_HUB_OFFLINE'] = '1'
        os.environ['TRANSFORMERS_OFFLINE'] = '1'
    sys.path.insert(0, str(UPSTREAM))
    sys.path.insert(0, str(UPSTREAM / 'GPT_SoVITS'))
    # No machine/user PATH modifications. Upstream may set process-local DLL paths.
    os.chdir(UPSTREAM)


def model_config(device='cuda', variant='v5turbo'):
    if variant not in ('v5turbo', 'v5dev'):
        raise ValueError('Only official V5 variants are allowed')
    base = UPSTREAM / 'GPT_SoVITS/pretrained_models'
    paths = dict(t2s_weights_path=base / 's1v3.ckpt',
                 vits_weights_path=base / f'gsv-v5-pretrained/s2G{variant}.pth',
                 bert_base_path=base / 'chinese-roberta-wwm-ext-large',
                 cnhuhbert_base_path=base / 'chinese-hubert-base')
    for path in [*paths.values(), base / 'gsv-v5-pretrained/vocoder.pth']:
        if not path.exists():
            raise FileNotFoundError(f'Required V5 inference model missing: {path}; run install.ps1')
    return {'custom': dict(version=variant, device=device, is_half=device == 'cuda',
                           **{key: str(value) for key, value in paths.items()})}


def load_pipeline(device='cuda', variant='v5turbo'):
    configure()
    import importlib.util
    required = ['jieba_fast', 'pyopenjtalk'] + (['eunjeon'] if os.name == 'nt' else [])
    for module in required:
        if importlib.util.find_spec(module) is None:
            raise RuntimeError(f'Missing local inference dependency {module}; run install.ps1. Runtime installation is forbidden.')
    for asset in (UPSTREAM / 'runtime/nltk_data/corpora/cmudict.zip',
                  UPSTREAM / 'runtime/nltk_data/taggers/averaged_perceptron_tagger.zip',
                  UPSTREAM / 'runtime/nltk_data/taggers/averaged_perceptron_tagger_eng.zip',
                  UPSTREAM / 'GPT_SoVITS/text/G2PWModel/g2pW.onnx',
                  UPSTREAM / 'GPT_SoVITS/pretrained_models/fast_langdetect/lid.176.bin'):
        if not asset.is_file():
            raise FileNotFoundError(f'Missing local text resource {asset}; run install.ps1 before starting the service')
    import torch
    if device == 'cuda' and not torch.cuda.is_available():
        raise RuntimeError('CUDA requested but unavailable; choose --device cpu explicitly')
    from tools.portable_runtime import activate
    activate(change_cwd=True)
    from GPT_SoVITS.TTS_infer_pack.TTS import TTS, TTS_Config
    config = TTS_Config(model_config(device, variant))
    (ROOT / 'state').mkdir(exist_ok=True)
    config.configs_path = str(ROOT / f'state/tts-{device}-{variant}.yaml')
    pipeline = TTS(config)
    if pipeline.configs.version != variant:
        raise RuntimeError('Upstream changed model version; refusing fallback')
    pipeline.init_vocoder(variant)  # Load the shared V5 vocoder before reporting readiness.
    return pipeline
