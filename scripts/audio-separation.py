"""Offline-only audio-separator bridge. One bounded JSON response on stdout; logs on stderr.
No package installation, model selection, or model/metadata download is performed here.
"""
import argparse
import contextlib
import hashlib
import importlib.metadata
import inspect
import json
import logging
import os
from pathlib import Path
import sys


def deny_network(event, args):
    if event in {"socket.connect", "socket.connect_ex", "socket.getaddrinfo", "socket.gethostbyname"}:
        raise RuntimeError("Network access is disabled. Prepare all model weights, configuration and metadata locally before running separation.")


sys.addaudithook(deny_network)
os.environ.update(HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1", HF_DATASETS_OFFLINE="1")


def existing_file(value, name):
    if not isinstance(value, str) or not Path(value).is_absolute():
        raise ValueError(f"{name} must be an absolute local path.")
    result = Path(value).resolve(strict=True)
    if not result.is_file() or result.stat().st_size == 0:
        raise ValueError(f"{name} must be a nonempty local file: {result}")
    return result


def local_only_download(self, url, output_path):
    """The upstream loader can use a prepared cache, but can never populate it."""
    if not Path(output_path).is_file() or Path(output_path).stat().st_size == 0:
        raise RuntimeError(f"Offline model dependency is missing: {output_path}. Obtain this exact file from the model publisher, verify its license/checksum, and place it locally. Automatic download is disabled.")


def execute(request):
    if not isinstance(request, dict) or request.get("operation") not in {"probe", "separate"}:
        raise ValueError("Invalid helper operation.")
    model = existing_file(request.get("modelPath"), "Model")
    device = request.get("device", "cpu")
    if device not in {"cpu", "auto", "cuda"}:
        raise ValueError("Device must be cpu, auto or cuda.")
    if device == "cpu":
        os.environ["CUDA_VISIBLE_DEVICES"] = "-1"
    os.environ["AUDIO_SEPARATOR_MODEL_DIR"] = str(model.parent)
    checksum = hashlib.sha256()
    with model.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            checksum.update(chunk)
    digest = checksum.hexdigest()
    expected = request.get("expectedSha256")
    if expected is not None and (not isinstance(expected, str) or expected.lower() != digest):
        raise ValueError("Local model SHA-256 does not match the expected checksum. Do not use this model until its provenance is verified.")
    try:
        version = importlib.metadata.version("audio-separator")
        import torch
        import onnxruntime
        from audio_separator.separator import Separator
    except Exception as error:
        raise RuntimeError(f"Cannot import audio-separator and its inference dependencies in {sys.executable}: {error}. Prepare a compatible Python environment manually; this application never installs packages.") from error
    if not callable(getattr(Separator, "download_file_if_not_exists", None)):
        raise RuntimeError("Unsupported audio-separator API: offline cache guard is unavailable. Use a reviewed version exposing download_file_if_not_exists.")
    Separator.download_file_if_not_exists = local_only_download
    if "custom_output_names" not in inspect.signature(Separator.separate).parameters:
        raise RuntimeError("Unsupported audio-separator API: separate() must support custom_output_names. Prepare a compatible environment manually.")
    cuda = bool(torch.cuda.is_available())
    providers = list(onnxruntime.get_available_providers())
    environment = {"pythonVersion": sys.version.split()[0], "separatorVersion": version,
                   "cudaAvailable": cuda, "onnxProviders": providers, "modelSha256": digest}
    diagnostics = []
    # Current upstream model discovery requires this local cache even for existing weights.
    metadata = model.parent / "download_checks.json"
    if not metadata.is_file():
        diagnostics.append(f"Missing local model metadata: {metadata}. Prepare the audio-separator/UVR download_checks.json metadata and all model-specific config/cache files manually; no metadata is fetched by this helper.")
    else:
        try:
            with metadata.open(encoding="utf-8") as stream:
                cached_metadata = json.load(stream)
            if not isinstance(cached_metadata, dict) or not cached_metadata:
                raise ValueError("expected a nonempty metadata object")
        except Exception as error:
            diagnostics.append(f"Invalid local model metadata {metadata}: {error}. Restore verified metadata manually.")
    if device == "cuda" and not cuda:
        diagnostics.append("CUDA was requested but PyTorch cannot use it. Select device=cpu or manually prepare compatible GPU drivers and PyTorch.")
    if device == "cpu" and "CPUExecutionProvider" not in providers:
        diagnostics.append("ONNX Runtime CPUExecutionProvider is missing. Prepare a CPU-compatible inference environment manually.")
    if request["operation"] == "probe":
        diagnostics.append("Dependency/API/cache checks only; model compatibility and required auxiliary files are verified when loading the trusted local model. GPU is optional; CPU mode is supported.")
        return {"ok": len(diagnostics) == 1, "diagnostics": diagnostics, "environment": environment}
    if diagnostics:
        return {"ok": False, "diagnostics": diagnostics, "environment": environment}
    source = existing_file(request.get("inputPath"), "Input audio")
    output = Path(request["outputDir"]).resolve(strict=True)
    if not output.is_dir():
        raise ValueError("Output directory is missing.")
    kwargs = {"model_file_dir": str(model.parent), "output_dir": str(output),
              "output_format": "WAV", "sample_rate": 48000, "log_level": logging.ERROR}
    separator = Separator(**kwargs)
    if device == "cpu":
        separator.torch_device = torch.device("cpu")
        separator.torch_device_cpu = torch.device("cpu")
        separator.onnx_execution_provider = ["CPUExecutionProvider"]
    dialogue_stem = request.get("dialogueStem", "Vocals")
    background_stem = request.get("backgroundStem", "Instrumental")
    if not isinstance(dialogue_stem, str) or not isinstance(background_stem, str) or dialogue_stem.casefold() == background_stem.casefold():
        raise ValueError("Two distinct model stem labels are required.")
    # basename + model_file_dir selects only the explicitly provided local weight.
    # The patched cache method and socket audit hook prevent loader downloads.
    separator.load_model(model_filename=model.name)
    files = separator.separate(str(source), custom_output_names={dialogue_stem: "lingvoice-dialogue", background_stem: "lingvoice-background"})
    if not isinstance(files, list) or len(files) != 2:
        raise RuntimeError("The selected model must emit exactly two stems (dialogue and background). Use an appropriate local two-stem model and correct stem labels.")
    resolved = []
    for value in files:
        candidate = Path(value)
        candidate = (output / candidate).resolve(strict=True) if not candidate.is_absolute() else candidate.resolve(strict=True)
        if not candidate.is_relative_to(output) or not candidate.is_file():
            raise RuntimeError("Separator returned a file outside its output directory.")
        resolved.append(candidate)
    def stem(name):
        matches = [file for file in resolved if file.name.casefold() == f"lingvoice-{name}.wav"]
        if len(matches) != 1:
            raise RuntimeError(f"Cannot identify {name} stem. Check model stem labels and audio-separator output naming compatibility.")
        return str(matches[0])
    return {"ok": True, "diagnostics": [], "environment": environment,
            "dialoguePath": stem("dialogue"), "backgroundPath": stem("background")}


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
