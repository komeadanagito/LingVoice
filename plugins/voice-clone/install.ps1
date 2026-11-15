param([switch]$SkipModels, [switch]$RefreshLock)
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$python = Join-Path $root '.venv/Scripts/python.exe'
$uv = Join-Path $root '../runtime/tools/uv.exe'
if (!(Test-Path $python) -or !(Test-Path $uv)) { throw 'Run plugins/bootstrap.ps1 first (project Python 3.10 required).' }
$env:UV_CACHE_DIR = Join-Path $root 'cache/uv'
$env:PIP_CACHE_DIR = Join-Path $root 'cache/pip'
$env:TEMP = Join-Path $root 'tmp'
$env:TMP = $env:TEMP
$env:PYTHONNOUSERSITE = '1'
$env:PYTHONPATH = $null
$env:PYTHONHOME = $null
[IO.Directory]::CreateDirectory($env:TEMP) | Out-Null
$upstream = Join-Path $root 'upstream'
$revision = 'e91506f1fba265e1841617c3042a1573206a7351'
if (!(Test-Path (Join-Path $upstream '.git'))) {
  & git clone --filter=blob:none --no-checkout https://github.com/RVC-Boss/GPT-SoVITS.git $upstream
  if ($LASTEXITCODE -ne 0) { throw 'Official source clone failed.' }
  & git -C $upstream checkout $revision
  if ($LASTEXITCODE -ne 0) { throw 'Pinned checkout failed.' }
}
$actual = & git -C $upstream rev-parse HEAD
if ($actual -ne $revision) { throw 'Upstream revision mismatch; refusing a silent model/API change.' }
& $uv pip install --python $python --index-url https://download.pytorch.org/whl/cu126 'torch==2.6.0+cu126' 'torchaudio==2.6.0+cu126'
if ($LASTEXITCODE -ne 0) { throw 'PyTorch CUDA wheels installation failed.' }
$lock = Join-Path $root 'requirements.lock'
$requirements = if ((Test-Path $lock) -and !$RefreshLock) { $lock } else { Join-Path $root 'requirements.in' }
& $uv pip install --python $python -r $requirements --extra-index-url https://download.pytorch.org/whl/cu126 --index-strategy unsafe-best-match
if ($LASTEXITCODE -ne 0) { throw 'Inference dependencies installation failed.' }
& $uv pip check --python $python
if ($LASTEXITCODE -ne 0) { throw 'Dependency validation failed.' }
& $python (Join-Path $root 'prepare_models.py') $(if ($SkipModels) { '--runtime-only' })
if ($LASTEXITCODE -ne 0) { throw 'Model/runtime preparation failed.' }
# Lock only a completely installed environment, never a guessed dependency set.
& $uv pip freeze --python $python | Set-Content -Encoding UTF8 $lock
if ($LASTEXITCODE -ne 0) { throw 'Environment lock failed.' }
