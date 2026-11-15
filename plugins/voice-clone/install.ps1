param(
    [switch]$SkipModels, [switch]$RefreshLock, [switch]$NoModels,
    [ValidateSet('modelscope','huggingface')][string]$Source = 'modelscope',
    [ValidateSet('cuda','cpu')][string]$Device = 'cuda'
)
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
. (Join-Path (Split-Path $root -Parent) 'install-common.ps1')
Initialize-LingVoiceInstall -Root (Split-Path $root -Parent) -Source $Source
$python = Join-Path $root '.venv/Scripts/python.exe'
$uv = Join-Path $root '../runtime/tools/uv.exe'
Assert-LingVoicePython -Python $python -Version '3.10'
if (!(Test-Path -LiteralPath $uv)) { throw 'Run plugins/bootstrap.ps1 first.' }
$upstream = Join-Path $root 'upstream'
$revision = 'e91506f1fba265e1841617c3042a1573206a7351'
$marker = Join-Path $upstream '.lingvoice-source-revision'
$requiredSource = @('tools/uvr5/bsroformer.py','GPT_SoVITS/TTS_infer_pack/TTS.py')
$complete = $true
foreach ($relative in $requiredSource) { if (!(Test-Path -LiteralPath (Join-Path $upstream $relative))) { $complete = $false } }
$verifiedSource = $false
if ($complete -and (Test-Path -LiteralPath (Join-Path $upstream '.git')) -and (Get-Command git -ErrorAction SilentlyContinue)) {
    $actual = (Invoke-LingVoiceNative 'git' @('-C',$upstream,'rev-parse','HEAD')) -join ''
    if ($actual.Trim() -ne $revision) { throw 'Upstream revision mismatch. Existing source/models are preserved; select the pinned checkout manually.' }
    $trackedChanges = (Invoke-LingVoiceNative 'git' @('-C',$upstream,'status','--porcelain','--untracked-files=no')) -join ''
    if ($trackedChanges.Trim()) { throw 'Pinned upstream has tracked local modifications; refusing to silently use changed source. Existing files were preserved.' }
    $verifiedSource = $true
} elseif ($complete -and (Test-Path -LiteralPath $marker)) {
    $verifiedSource = ([IO.File]::ReadAllText($marker).Trim() -eq $revision)
    if (!$verifiedSource) { throw 'Upstream source marker mismatch; existing source/models were preserved.' }
}
if (!$verifiedSource) {
    # Download into an independent staging directory. Never recursively delete upstream:
    # it also contains downloaded model weights and runtime language resources.
    $stage = Join-Path $env:TEMP ('src-' + [Guid]::NewGuid().ToString('N').Substring(0,8))
    [IO.Directory]::CreateDirectory($stage) | Out-Null
    try {
        $archive = Join-Path $stage 'source.zip'
        try { Receive-LingVoiceFile -Uri "https://codeload.github.com/RVC-Boss/GPT-SoVITS/zip/$revision" -Destination $archive }
        catch { Receive-LingVoiceFile -Uri "https://github.com/RVC-Boss/GPT-SoVITS/archive/$revision.zip" -Destination $archive }
        # Strip the archive's long top-level directory to keep paths usable in
        # Windows PowerShell 5.1; explicit stream extraction fails on every error.
        $sourceRoot = Join-Path $stage 'x'
        Expand-LingVoiceSourceArchive -Archive $archive -Destination $sourceRoot -RootName "GPT-SoVITS-$revision"
        foreach ($relative in $requiredSource) {
            if (!(Test-Path -LiteralPath (Join-Path $sourceRoot $relative))) { throw "Incomplete pinned source archive: $relative" }
        }
        $files = @(Get-ChildItem -LiteralPath $sourceRoot -File -Recurse -Force)
        # Validate all collisions before writing anything. A conflicting local source
        # file requires human review, not a destructive checkout or model deletion.
        foreach ($file in $files) {
            $relative = $file.FullName.Substring($sourceRoot.Length + 1)
            $destination = Join-Path $upstream $relative
            if (Test-Path -LiteralPath $destination) {
                if ((Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash -ne (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash) {
                    throw "Pinned source conflicts with existing file: $destination. No source/model files were overwritten."
                }
            }
        }
        foreach ($file in $files) {
            $relative = $file.FullName.Substring($sourceRoot.Length + 1)
            $destination = Join-Path $upstream $relative
            if (!(Test-Path -LiteralPath $destination)) {
                [IO.Directory]::CreateDirectory((Split-Path $destination -Parent)) | Out-Null
                Copy-Item -LiteralPath $file.FullName -Destination $destination
            }
        }
        [IO.File]::WriteAllText($marker, $revision, [Text.UTF8Encoding]::new($false))
    } finally { Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue }
}
$channel = if ($Device -eq 'cpu') { 'cpu' } else { 'cu126' }
$lock = Join-Path $root 'requirements.lock'
$requirements = if ((Test-Path -LiteralPath $lock) -and !$RefreshLock) { $lock } else { Join-Path $root 'requirements.in' }
Install-LingVoicePackages -Uv $uv -Python $python -Requirements $requirements -Channel $channel -PythonTag 'cp310' -TorchPackages @("torch==2.6.0+$channel", "torchaudio==2.6.0+$channel")
# Required even with -NoModels: pip metadata checks do not load native DLLs.
Invoke-LingVoiceNative $python @('-I','-c',"import sys; sys.path.insert(0,sys.argv[1]); import torch,torchaudio,numpy,scipy,librosa,soundfile,onnxruntime,transformers,peft,pyopenjtalk,jieba_fast,eunjeon,fastapi; from transformers import BertModel, AutoModelForMaskedLM; from tools.uvr5.bsroformer import Roformer_Loader; assert torch.__version__ == '2.6.0+$channel'; assert torchaudio.__version__ == '2.6.0+$channel'",$upstream)
if (!$NoModels) {
    $prepareArgs = @((Join-Path $root 'prepare_models.py'),'--source',$Source)
    if ($SkipModels) { $prepareArgs += '--runtime-only' }
    Invoke-LingVoiceNative $python $prepareArgs
}
Write-LingVoiceLock -Uv $uv -Python $python -Path $lock
