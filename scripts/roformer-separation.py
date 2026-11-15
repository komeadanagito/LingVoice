"""Offline-only BS-RoFormer / Mel-Band RoFormer vocal separation helper.
Separates foreground lead dialogue from backing vocals + instrumental BGM.
"""
import argparse
import contextlib
import json
import os
from pathlib import Path
import sys


def deny_network(event, args):
    if event in {"socket.connect", "socket.connect_ex", "socket.getaddrinfo", "socket.gethostbyname"}:
        raise RuntimeError("Network access is disabled for local audio separation.")


sys.addaudithook(deny_network)
os.environ.update(HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1", HF_DATASETS_OFFLINE="1")


def existing_file(value, name):
    if not isinstance(value, str) or not Path(value).is_absolute():
        raise ValueError(f"{name} must be an absolute local path.")
    result = Path(value).resolve(strict=True)
    if not result.is_file() or result.stat().st_size == 0:
        raise ValueError(f"{name} must be a nonempty local file: {result}")
    return result


def execute(request):
    if not isinstance(request, dict):
        raise ValueError("Invalid helper request.")
    source = existing_file(request.get("inputPath"), "Input audio")
    model_path = existing_file(request.get("modelPath"), "RoFormer model")
    config_path = existing_file(request.get("configPath"), "RoFormer config")
    output = Path(request["outputDir"]).resolve(strict=True)
    if not output.is_dir():
        raise ValueError("Output directory is missing.")
    device_pref = request.get("device", "auto")
    if device_pref not in {"cpu", "auto", "cuda"}:
        raise ValueError("Device must be cpu, auto or cuda.")

    uvr5_dir = existing_file(request.get("uvr5Dir") + "/bsroformer.py" if request.get("uvr5Dir") else "", "uvr5").parent
    plugins_dir = Path(request.get("pluginsDir", "")).resolve() if request.get("pluginsDir") else None

    sys.path.insert(0, str(uvr5_dir))
    if plugins_dir and (plugins_dir / "gpu_lease.py").is_file():
        sys.path.insert(0, str(plugins_dir))
        from gpu_lease import gpu_lease
    else:
        gpu_lease = None

    import numpy as np
    import soundfile as sf
    import soxr
    import torch
    import yaml
    from bs_roformer.bs_roformer import BSRoformer
    from bs_roformer.mel_band_roformer import MelBandRoformer
    from bsroformer import Roformer_Loader

    if device_pref == "cpu":
        device = "cpu"
    elif device_pref == "cuda":
        if not torch.cuda.is_available():
            raise RuntimeError("CUDA requested for RoFormer separation but unavailable.")
        device = "cuda"
    else:
        device = "cuda" if torch.cuda.is_available() else "cpu"

    cfg = yaml.load(config_path.read_text(encoding="utf-8"), Loader=yaml.FullLoader)
    model_sr = int(cfg.get("audio", {}).get("sample_rate", 44100))
    cfg.setdefault("inference", {})
    cfg["inference"]["num_overlap"] = min(2, int(cfg["inference"].get("num_overlap", 2)))
    cfg["inference"]["batch_size"] = 2 if device == "cuda" else 1
    model_cfg = dict(cfg["model"])
    is_mel = "num_bands" in model_cfg
    model_cfg["flash_attn"] = device == "cuda"

    mix, sr = sf.read(str(source), dtype="float32", always_2d=True)
    if mix.shape[1] == 1:
        mix = np.repeat(mix, 2, axis=1)
    elif mix.shape[1] > 2:
        mix = mix[:, :2]
    orig_frames = mix.shape[0]
    mix_model = soxr.resample(mix, sr, model_sr) if sr != model_sr else mix

    def run_separation():
        model = (MelBandRoformer if is_mel else BSRoformer)(**model_cfg)
        state = torch.load(str(model_path), map_location="cpu", weights_only=True)
        if isinstance(state, dict) and "state_dict" in state:
            state = state["state_dict"]
        model.load_state_dict(state)
        model = model.to(device).eval()

        loader = Roformer_Loader.__new__(Roformer_Loader)
        loader.config = cfg
        loader.model_type = "mel_band_roformer" if is_mel else "bs_roformer"
        loader.is_half = device == "cuda"

        mix_tensor = torch.from_numpy(mix_model.T.copy())
        res = loader.demix_track(model, mix_tensor, device)
        del model
        if device == "cuda":
            torch.cuda.empty_cache()
        return res

    if device == "cuda" and gpu_lease is not None:
        with gpu_lease():
            res = run_separation()
    else:
        res = run_separation()

    if "Vocals" in res:
        voc = res["Vocals"].T
    elif "vocals" in res:
        voc = res["vocals"].T
    else:
        voc = next(iter(res.values())).T

    if voc.shape[0] != mix_model.shape[0]:
        if voc.shape[0] > mix_model.shape[0]:
            voc = voc[: mix_model.shape[0]]
        else:
            voc = np.pad(voc, ((0, mix_model.shape[0] - voc.shape[0]), (0, 0)))

    if "Instrumental" in res:
        inst = res["Instrumental"].T
    elif "other" in res:
        inst = res["other"].T
    else:
        inst = mix_model - voc

    def match_frames(arr, target_sr, target_frames):
        out = soxr.resample(arr, model_sr, target_sr) if model_sr != target_sr else arr
        if out.shape[0] > target_frames:
            out = out[:target_frames]
        elif out.shape[0] < target_frames:
            out = np.pad(out, ((0, target_frames - out.shape[0]), (0, 0)))
        return np.clip(out, -1.0, 1.0)

    voc_out = match_frames(voc, sr, orig_frames)
    inst_out = match_frames(inst, sr, orig_frames)

    dialogue_path = output / "lingvoice-dialogue.wav"
    background_path = output / "lingvoice-background.wav"
    sf.write(str(dialogue_path), voc_out, sr, format="WAV", subtype="PCM_16")
    sf.write(str(background_path), inst_out, sr, format="WAV", subtype="PCM_16")

    return {
        "ok": True,
        "diagnostics": [],
        "dialoguePath": str(dialogue_path),
        "backgroundPath": str(background_path),
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--request", required=True)
    arguments = parser.parse_args()
    try:
        request_file = existing_file(arguments.request, "Request")
        if request_file.stat().st_size > 65536:
            raise ValueError("Request is too large.")
        with request_file.open(encoding="utf-8") as stream:
            request = json.load(stream)
        with contextlib.redirect_stdout(sys.stderr):
            result = execute(request)
    except Exception as error:
        result = {"ok": False, "diagnostics": [str(error)[:4000]]}
    encoded = json.dumps(result, ensure_ascii=True)
    if len(encoded.encode("utf-8")) > 65536:
        encoded = json.dumps({"ok": False, "diagnostics": ["Helper response exceeds its size limit."]})
    sys.stdout.write(encoded + "\n")
    sys.stdout.flush()


if __name__ == "__main__":
    main()
