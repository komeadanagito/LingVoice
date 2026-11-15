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
$env:UV_DEFAULT_INDEX = $null
$env:UV_INDEX_URL = $null
$env:UV_HTTP_TIMEOUT = '300'
$pypiIndex = if ($env:LINGVOICE_PYPI_INDEX) { $env:LINGVOICE_PYPI_INDEX } else { 'https://pypi.org/simple/' }
$requirements = if ($Locked -or (Test-Path (Join-Path $PSScriptRoot 'requirements.lock.txt'))) { Join-Path $PSScriptRoot 'requirements.lock.txt' } else { Join-Path $PSScriptRoot 'requirements.txt' }
if ($requirements -like '*.lock.txt') {
  & $uv pip install --python $python --index-url $pypiIndex --extra-index-url https://download.pytorch.org/whl/cu128 --index-strategy unsafe-best-match -r $requirements
  if ($LASTEXITCODE -ne 0) { throw 'Translation dependencies failed.' }
} else {
  & $uv pip install --python $python 'torch==2.10.0+cu128' 'torchvision==0.25.0+cu128' --index-url https://download.pytorch.org/whl/cu128 --extra-index-url $pypiIndex --index-strategy unsafe-best-match
  if ($LASTEXITCODE -ne 0) { throw 'CUDA PyTorch installation failed.' }
  & $uv pip install --python $python --index-url $pypiIndex --extra-index-url https://download.pytorch.org/whl/cu128 --index-strategy unsafe-best-match -r $requirements
  if ($LASTEXITCODE -ne 0) { throw 'Translation dependencies failed.' }
}
& $uv pip check --python $python
if ($LASTEXITCODE -ne 0) { throw 'Translation dependency check failed.' }
& $uv pip freeze --python $python | Set-Content (Join-Path $PSScriptRoot 'requirements.lock.txt') -Encoding UTF8
