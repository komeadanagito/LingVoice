param(
    [switch]$UseLock,
    [switch]$RefreshLock,
    [ValidateSet('modelscope','huggingface')][string]$Source = 'modelscope',
    [ValidateSet('cuda','cpu')][string]$Device = 'cuda'
)
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
. (Join-Path (Split-Path $root -Parent) 'install-common.ps1')
Initialize-LingVoiceInstall -Root (Split-Path $root -Parent) -Source $Source
$python = Join-Path $root '.venv/Scripts/python.exe'
$uv = Join-Path (Split-Path $root -Parent) 'runtime/tools/uv.exe'
Assert-LingVoicePython -Python $python -Version '3.12'
foreach ($dir in @('inputs','outputs')) { [IO.Directory]::CreateDirectory((Join-Path $root $dir)) | Out-Null }
$lock = Join-Path $root 'requirements.lock.txt'
if ($UseLock -and $RefreshLock) { throw 'UseLock and RefreshLock cannot be combined.' }
if ($UseLock -and !(Test-Path -LiteralPath $lock)) { throw 'No validated lock exists. Run install.ps1 without -UseLock first.' }
$requirements = if (!$RefreshLock -and (Test-Path -LiteralPath $lock)) { $lock } else { Join-Path $root 'requirements.in' }
$channel = if ($Device -eq 'cpu') { 'cpu' } else { 'cu128' }
Install-LingVoicePackages -Uv $uv -Python $python -Requirements $requirements -Channel $channel -TorchPackages @("torch==2.10.0+$channel", "torchaudio==2.10.0+$channel")
Invoke-LingVoiceNative $python @('-I','-c',"import torch,torchaudio; assert torch.__version__ == '2.10.0+$channel'; assert torchaudio.__version__ == '2.10.0+$channel'")
Invoke-LingVoiceNative $python @('-I',(Join-Path $root 'server.py'),'check','--dependencies-only')
Write-LingVoiceLock -Uv $uv -Python $python -Path $lock
