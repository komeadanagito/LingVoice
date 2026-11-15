param([switch]$UseLock)
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$python = Join-Path $root '.venv\Scripts\python.exe'
$uv = [IO.Path]::GetFullPath((Join-Path $root '..\runtime\tools\uv.exe'))
# Changes apply to this script's children only and are restored in finally.
$values = @{
    PYTHONNOUSERSITE='1'; PYTHONPATH=$null; PYTHONHOME=$null;
    UV_CACHE_DIR=(Join-Path $root 'cache\uv'); HF_HOME=(Join-Path $root 'cache\huggingface');
    XDG_CACHE_HOME=(Join-Path $root 'cache'); TORCH_HOME=(Join-Path $root 'cache\torch');
    TEMP=(Join-Path $root 'tmp'); TMP=(Join-Path $root 'tmp')
}
$previous = @{}
try {
    foreach ($name in $values.Keys) {
        $previous[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
        [Environment]::SetEnvironmentVariable($name, $values[$name], 'Process')
    }
    New-Item -ItemType Directory -Force -Path "$root\cache\uv", "$root\tmp", "$root\inputs", "$root\outputs" | Out-Null
    if (!(Test-Path $python)) { throw 'Create the plugin Python 3.12 venv first.' }
    if ($UseLock) {
        if (!(Test-Path "$root\requirements.lock.txt")) { throw 'No validated lock exists. Run install.ps1 first.' }
        & $uv pip sync --python $python --extra-index-url https://download.pytorch.org/whl/cu128 "$root\requirements.lock.txt"
        if ($LASTEXITCODE) { throw 'Locked dependency installation failed.' }
    } else {
        & $uv pip install --python $python --index-url https://download.pytorch.org/whl/cu128 'torch==2.10.0' 'torchaudio==2.10.0'
        if ($LASTEXITCODE) { throw 'CUDA torch/torchaudio installation failed.' }
        & $uv pip install --python $python --only-binary :all: -r "$root\requirements.in"
        if ($LASTEXITCODE) { throw 'Dependency installation failed.' }
    }
    & $uv pip check --python $python
    if ($LASTEXITCODE) { throw 'Dependency check failed; no lock will be generated.' }
    & $python -I "$root\server.py" check --dependencies-only
    if ($LASTEXITCODE) { throw 'Native model imports failed; no lock will be generated.' }
    $lock = & $uv pip freeze --python $python
    if ($LASTEXITCODE) { throw 'Dependency freeze failed.' }
    [IO.File]::WriteAllLines((Join-Path $root 'requirements.lock.txt'), $lock, [Text.UTF8Encoding]::new($false))
} finally {
    foreach ($name in $previous.Keys) { [Environment]::SetEnvironmentVariable($name, $previous[$name], 'Process') }
}
