param([switch]$Locked)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$uv = Join-Path $root 'runtime/tools/uv.exe'
$python = Join-Path $PSScriptRoot '.venv/Scripts/python.exe'
$env:UV_CACHE_DIR = Join-Path $root 'runtime/cache/uv'
$env:TEMP = Join-Path $root 'runtime/tmp'
$env:TMP = $env:TEMP
$env:PYTHONNOUSERSITE = '1'
$env:PYTHONPATH = $null
$env:PYTHONHOME = $null
$env:HF_HOME = Join-Path $PSScriptRoot 'cache/huggingface'
& $uv pip install --python $python 'torch==2.10.0' 'torchvision==0.25.0' --index-url https://download.pytorch.org/whl/cu128
if ($LASTEXITCODE -ne 0) { throw 'CUDA PyTorch installation failed.' }
$requirements = if ($Locked) { Join-Path $PSScriptRoot 'requirements.lock.txt' } else { Join-Path $PSScriptRoot 'requirements.txt' }
& $uv pip install --python $python -r $requirements
if ($LASTEXITCODE -ne 0) { throw 'Translation dependencies failed.' }
& $uv pip check --python $python
if ($LASTEXITCODE -ne 0) { throw 'Translation dependency check failed.' }
& $uv pip freeze --python $python | Set-Content (Join-Path $PSScriptRoot 'requirements.lock.txt') -Encoding UTF8
