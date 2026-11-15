param(
    [ValidateSet('bootstrap','install','download','check','start','stop','status')][string]$Action = 'check',
    [ValidateSet('all','asr','translation','voice-clone')][string]$Service = 'all',
    [ValidateSet('modelscope','huggingface')][string]$Source = 'modelscope',
    [switch]$NoModels
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
if ($Source -eq 'modelscope') {
    $env:UV_PYTHON_INSTALL_MIRROR = 'https://registry.npmmirror.com/-/binary/python-build-standalone'
    $env:LINGVOICE_PYPI_INDEX = 'https://mirrors.aliyun.com/pypi/simple/'
}
$env:UV_DEFAULT_INDEX = $null
$env:UV_INDEX_URL = $null
$env:UV_HTTP_TIMEOUT = '300'
$services = if ($Service -eq 'all') { @('asr','translation','voice-clone') } else { @($Service) }
if ($Action -eq 'bootstrap' -or $Action -eq 'install') {
    & (Join-Path $root 'bootstrap.ps1') -Source $Source
    if (!$?) { throw 'Bootstrap failed.' }
    $installerArgs = @('pip', 'install', '--python', $installer)
    if ($env:LINGVOICE_PYPI_INDEX) { $installerArgs += @('--index-url', $env:LINGVOICE_PYPI_INDEX) }
    $installerArgs += @('huggingface-hub==1.33.0', 'psutil==7.2.2')
    & $uv @installerArgs
    if ($LASTEXITCODE -ne 0) { throw 'Installer dependencies failed.' }
    if ($Action -eq 'bootstrap') { exit 0 }
}
if (!(Test-Path $installer)) { throw 'Run plugins.ps1 -Action bootstrap first.' }
switch ($Action) {
    'install' {
        foreach ($name in $services) {
            if ($name -eq 'voice-clone' -and $NoModels) {
                & (Join-Path $root "$name/install.ps1") -NoModels
            } else {
                & (Join-Path $root "$name/install.ps1")
            }
            if (!$? -or $LASTEXITCODE -ne 0) { throw "Install failed: $name" }
        }
    }
    'download' {
        if ($Service -in @('all','asr','translation')) {
            $models = switch ($Service) { 'all' { @('qwen-asr','qwen-aligner','gemma-e2b','separation') } 'asr' { @('qwen-asr','qwen-aligner') } 'translation' { @('gemma-e2b') } }
            foreach ($model in $models) {
                & $installer (Join-Path $root 'download_models.py') --model $model --source $Source
                if ($LASTEXITCODE -ne 0) { throw "Download failed: $model" }
            }
        }
        if ($Service -in @('all','voice-clone')) {
            $voicePython = Join-Path $root 'voice-clone/.venv/Scripts/python.exe'
            & $voicePython (Join-Path $root 'voice-clone/prepare_models.py') --source $Source
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
