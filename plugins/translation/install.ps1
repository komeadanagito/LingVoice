param(
    [switch]$Locked,
    [switch]$RefreshLock,
    [ValidateSet('modelscope','huggingface')][string]$Source = 'modelscope',
    [ValidateSet('cuda','cpu')][string]$Device = 'cuda'
)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
. (Join-Path $root 'install-common.ps1')
Initialize-LingVoiceInstall -Root $root -Source $Source
$uv = Join-Path $root 'runtime/tools/uv.exe'
$python = Join-Path $PSScriptRoot '.venv/Scripts/python.exe'
Assert-LingVoicePython -Python $python -Version '3.12'
$env:HF_HOME = Join-Path $PSScriptRoot 'cache/huggingface'
$lock = Join-Path $PSScriptRoot 'requirements.lock.txt'
if ($Locked -and $RefreshLock) { throw 'Locked and RefreshLock cannot be combined.' }
if ($Locked -and !(Test-Path -LiteralPath $lock)) { throw 'No validated translation lock exists. Run install.ps1 without -Locked first.' }
$requirements = if (!$RefreshLock -and (Test-Path -LiteralPath $lock)) { $lock } else { Join-Path $PSScriptRoot 'requirements.txt' }
$channel = if ($Device -eq 'cpu') { 'cpu' } else { 'cu128' }
Install-LingVoicePackages -Uv $uv -Python $python -Requirements $requirements -Channel $channel -TorchPackages @("torch==2.10.0+$channel", "torchvision==0.25.0+$channel")
# pip check alone cannot detect DLL errors or incompatible transformers/torch APIs.
Invoke-LingVoiceNative $python @('-I','-c',"import torch,torchvision,transformers,accelerate,bitsandbytes,sentencepiece,safetensors; from PIL import Image; from transformers import AutoTokenizer, AutoModelForMultimodalLM, BitsAndBytesConfig; assert torch.__version__ == '2.10.0+$channel'; assert torchvision.__version__ == '0.25.0+$channel'")
Write-LingVoiceLock -Uv $uv -Python $python -Path $lock
