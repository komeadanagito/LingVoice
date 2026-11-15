param([switch]$SkipModels, [switch]$RefreshLock, [switch]$NoModels)
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
if (!(Test-Path (Join-Path $upstream 'tools/uvr5/bsroformer.py'))) {
  if (Test-Path $upstream) { Remove-Item -Recurse -Force $upstream -ErrorAction SilentlyContinue }
  $cloned = $false
  $gitCmd = Get-Command git -ErrorAction SilentlyContinue
  if ($gitCmd) {
    try {
      & git clone --filter=blob:none --no-checkout https://github.com/RVC-Boss/GPT-SoVITS.git $upstream
      if ($LASTEXITCODE -eq 0) {
        & git -C $upstream checkout $revision
        if ($LASTEXITCODE -eq 0) { $cloned = $true }
      }
    } catch {}
  }
  if (!$cloned) {
    if (Test-Path $upstream) { Remove-Item -Recurse -Force $upstream -ErrorAction SilentlyContinue }
    $archiveZip = Join-Path $env:TEMP "GPT-SoVITS-$revision.zip"
    $extractTmp = Join-Path $env:TEMP "GPT-SoVITS-extract-$revision"
    if (Test-Path $extractTmp) { Remove-Item -Recurse -Force $extractTmp }
    & curl.exe --fail --location --retry 4 --connect-timeout 30 --output $archiveZip "https://github.com/RVC-Boss/GPT-SoVITS/archive/$revision.zip"
    if ($LASTEXITCODE -ne 0) { throw 'Official GPT-SoVITS source download failed.' }
    Expand-Archive -LiteralPath $archiveZip -DestinationPath $extractTmp -Force
    $inner = Get-ChildItem -Path $extractTmp -Directory | Select-Object -First 1
    if (!$inner) { throw 'Extracted GPT-SoVITS source archive is empty.' }
    Move-Item -LiteralPath $inner.FullName -Destination $upstream
    Remove-Item -Force $archiveZip -ErrorAction SilentlyContinue
    Remove-Item -Recurse -Force $extractTmp -ErrorAction SilentlyContinue
  }
}
if (Test-Path (Join-Path $upstream '.git')) {
  $actual = & git -C $upstream rev-parse HEAD
  if ($actual -ne $revision) { throw 'Upstream revision mismatch; refusing a silent model/API change.' }
} elseif (!(Test-Path (Join-Path $upstream 'tools/uvr5/bsroformer.py'))) {
  throw 'Upstream GPT-SoVITS source is incomplete.'
}
$env:UV_DEFAULT_INDEX = $null
$env:UV_INDEX_URL = $null
$env:UV_HTTP_TIMEOUT = '300'
$pypiIndex = if ($env:LINGVOICE_PYPI_INDEX) { $env:LINGVOICE_PYPI_INDEX } else { 'https://pypi.org/simple/' }
& $uv pip install --python $python --index-url https://download.pytorch.org/whl/cu126 --extra-index-url $pypiIndex --index-strategy unsafe-best-match 'torch==2.6.0+cu126' 'torchaudio==2.6.0+cu126'
if ($LASTEXITCODE -ne 0) {
  # Fallback to Aliyun direct PyTorch wheel mirror if download.pytorch.org is unreachable or timed out.
  & $uv pip install --python $python --index-url $pypiIndex `
    'https://mirrors.aliyun.com/pytorch-wheels/cu126/torch-2.6.0%2Bcu126-cp310-cp310-win_amd64.whl' `
    'https://mirrors.aliyun.com/pytorch-wheels/cu126/torchaudio-2.6.0%2Bcu126-cp310-cp310-win_amd64.whl'
  if ($LASTEXITCODE -ne 0) { throw 'PyTorch CUDA wheels installation failed.' }
}
$lock = Join-Path $root 'requirements.lock'
$requirements = if ((Test-Path $lock) -and !$RefreshLock) { $lock } else { Join-Path $root 'requirements.in' }
& $uv pip install --python $python --index-url $pypiIndex --extra-index-url https://download.pytorch.org/whl/cu126 --index-strategy unsafe-best-match -r $requirements
if ($LASTEXITCODE -ne 0) { throw 'Inference dependencies installation failed.' }
& $uv pip check --python $python
if ($LASTEXITCODE -ne 0) { throw 'Dependency validation failed.' }
if (!$NoModels) {
  & $python (Join-Path $root 'prepare_models.py') $(if ($SkipModels) { '--runtime-only' })
  if ($LASTEXITCODE -ne 0) { throw 'Model/runtime preparation failed.' }
}
# Lock only a completely installed environment, never a guessed dependency set.
& $uv pip freeze --python $python | Set-Content -Encoding UTF8 $lock
if ($LASTEXITCODE -ne 0) { throw 'Environment lock failed.' }
