param(
    [ValidateSet('bootstrap','install','download','check','start','stop','status')][string]$Action = 'check',
    [ValidateSet('all','asr','translation','voice-clone')][string]$Service = 'all',
    [ValidateSet('modelscope','huggingface')][string]$Source = 'modelscope',
    [switch]$NoModels,
    [ValidateSet('cuda','cpu')][string]$Device = 'cuda',
    [switch]$RefreshLock
)
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
. (Join-Path $root 'install-common.ps1')
Initialize-LingVoiceInstall -Root $root -Source $Source
$uv = Join-Path $root 'runtime/tools/uv.exe'
$installer = Join-Path $root 'installer/.venv/Scripts/python.exe'
$services = if ($Service -eq 'all') { @('asr','translation','voice-clone') } else { @($Service) }
if ($Action -eq 'bootstrap' -or $Action -eq 'install') {
    & (Join-Path $root 'bootstrap.ps1') -Source $Source
    $installerArgs = @('pip','install','--python',$installer,'--index-url',$env:LINGVOICE_PYPI_INDEX,'huggingface-hub==1.33.0','psutil==7.2.2')
    try { Invoke-LingVoiceNative $uv $installerArgs }
    catch {
        if ($Source -ne 'modelscope') { throw }
        Write-Warning 'Installer package mirror failed; retrying official PyPI.'
        Invoke-LingVoiceNative $uv @('pip','install','--python',$installer,'--index-url','https://pypi.org/simple/','huggingface-hub==1.33.0','psutil==7.2.2')
    }
    Invoke-LingVoiceNative $uv @('pip','check','--python',$installer)
    Invoke-LingVoiceNative $installer @('-I','-c','import huggingface_hub, psutil')
    if ($Action -eq 'bootstrap') { return }
}
if (!(Test-Path -LiteralPath $installer)) { throw 'Run plugins.ps1 -Action bootstrap first.' }
switch ($Action) {
    'install' {
        foreach ($name in $services) {
            $parameters = @{Source=$Source; Device=$Device; RefreshLock=$RefreshLock}
            if ($name -eq 'voice-clone') { $parameters.NoModels = $NoModels }
            & (Join-Path $root "$name/install.ps1") @parameters
            # Script failures terminate via exceptions. LASTEXITCODE may belong to
            # an earlier recovered network attempt and is not a script exit status.
            if (!$?) { throw "Install failed: $name" }
        }
    }
    'download' {
        if ($Service -in @('all','asr','translation')) {
            $models = switch ($Service) { 'all' { @('qwen-asr','qwen-aligner','gemma-e2b','separation') } 'asr' { @('qwen-asr','qwen-aligner') } 'translation' { @('gemma-e2b') } }
            foreach ($model in $models) {
                Invoke-LingVoiceNative $installer @((Join-Path $root 'download_models.py'),'--model',$model,'--source',$Source)
            }
        }
        if ($Service -in @('all','voice-clone')) {
            $voicePython = Join-Path $root 'voice-clone/.venv/Scripts/python.exe'
            Assert-LingVoicePython -Python $voicePython -Version '3.10'
            Invoke-LingVoiceNative $voicePython @((Join-Path $root 'voice-clone/prepare_models.py'),'--source',$Source)
        }
    }
    'check' { Invoke-LingVoiceNative $installer @((Join-Path $root 'check.py'),'--service',$Service) }
    default { Invoke-LingVoiceNative $installer @((Join-Path $root 'manage.py'),$Action,$Service) }
}
