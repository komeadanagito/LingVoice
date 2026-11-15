param(
    [ValidateSet('bootstrap','install','download','check','start','stop','status')][string]$Action = 'check',
    [ValidateSet('all','asr','translation','voice-clone')][string]$Service = 'all'
)
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$uv = Join-Path $root 'runtime/tools/uv.exe'
$installer = Join-Path $root 'installer/.venv/Scripts/python.exe'
$env:UV_CACHE_DIR = Join-Path $root 'runtime/cache/uv'
$env:TEMP = Join-Path $root 'runtime/tmp'
$env:TMP = $env:TEMP
$env:PYTHONPATH = $null
$env:PYTHONHOME = $null
$env:PYTHONNOUSERSITE = '1'
$env:PYTHONUTF8 = '1'
$env:PYTHONIOENCODING = 'utf-8'
$services = if ($Service -eq 'all') { @('asr','translation','voice-clone') } else { @($Service) }
if ($Action -eq 'bootstrap' -or $Action -eq 'install') {
    & (Join-Path $root 'bootstrap.ps1')
    if (!$?) { throw 'Bootstrap failed.' }
    & $uv pip install --python $installer 'huggingface-hub==1.33.0' 'psutil==7.2.2'
    if ($LASTEXITCODE -ne 0) { throw 'Installer dependencies failed.' }
    if ($Action -eq 'bootstrap') { exit 0 }
}
if (!(Test-Path $installer)) { throw 'Run plugins.ps1 -Action bootstrap first.' }
switch ($Action) {
    'install' {
        foreach ($name in $services) {
            & (Join-Path $root "$name/install.ps1")
            if (!$? -or $LASTEXITCODE -ne 0) { throw "Install failed: $name" }
        }
    }
    'download' {
        if ($Service -in @('all','asr','translation')) {
            $models = switch ($Service) { 'all' { @('qwen-asr','qwen-aligner','gemma-e2b') } 'asr' { @('qwen-asr','qwen-aligner') } 'translation' { @('gemma-e2b') } }
            foreach ($model in $models) {
                & $installer (Join-Path $root 'download_models.py') --model $model
                if ($LASTEXITCODE -ne 0) { throw "Download failed: $model" }
            }
        }
        if ($Service -in @('all','voice-clone')) {
            $voicePython = Join-Path $root 'voice-clone/.venv/Scripts/python.exe'
            & $voicePython (Join-Path $root 'voice-clone/prepare_models.py')
            if ($LASTEXITCODE -ne 0) { throw 'Voice model download failed.' }
        }
    }
    'check' {
        & $installer (Join-Path $root 'check.py') --service $Service
        exit $LASTEXITCODE
    }
    default {
        & $installer (Join-Path $root 'manage.py') $Action $Service
        exit $LASTEXITCODE
    }
}
