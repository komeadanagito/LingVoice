# Offline Windows PowerShell 5.1 regression suite; never touches project environments.
$ErrorActionPreference = 'Stop'
$project = Split-Path $PSScriptRoot -Parent
$pluginRoot = Join-Path $project 'plugins'
$files = @('install-common.ps1','bootstrap.ps1','plugins.ps1','asr/install.ps1','translation/install.ps1','voice-clone/install.ps1')
foreach ($file in $files) {
    $tokens=$null; $errors=$null
    [System.Management.Automation.Language.Parser]::ParseFile((Join-Path $pluginRoot $file),[ref]$tokens,[ref]$errors) | Out-Null
    if ($errors.Count) { throw "PowerShell parse failed: $file : $errors" }
}
. (Join-Path $pluginRoot 'install-common.ps1')
function Assert-Test { param([bool]$Condition,[string]$Message) if (!$Condition) { throw $Message } }
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('lv-' + [Guid]::NewGuid().ToString('N').Substring(0,8))
[IO.Directory]::CreateDirectory($testRoot) | Out-Null
# Restore the caller's process environment even if a regression test fails.
$previous = @{}
foreach ($entry in [Environment]::GetEnvironmentVariables('Process').GetEnumerator()) { $previous[$entry.Key] = $entry.Value }
try {
    $sha = 'a' * 64
    $html = "<a href='../../uv-0.1.0-py3-none-win_amd64.whl#sha256=$sha'>old</a><a href='../../uv-0.13.8-py3-none-win_arm64.whl#sha256=$sha'>arm</a><a href='../../uv-0.13.8-py3-none-win_amd64.whl#sha256=$sha'>exact</a>"
    $wheel = Get-LingVoiceUvWheel -Html $html -IndexUri 'https://example.invalid/simple/uv/' -Version '0.13.8'
    Assert-Test ($wheel.Version -eq '0.13.8' -and $wheel.Sha256 -eq $sha -and $wheel.Url -eq 'https://example.invalid/uv-0.13.8-py3-none-win_amd64.whl') 'Wheel selection must match the exact version/platform and resolve relative links.'
    foreach ($invalid in @("<a href='uv-0.13.8-py3-none-win_amd64.whl'>no hash</a>", "<a href='http://example.invalid/uv-0.13.8-py3-none-win_amd64.whl#sha256=$sha'>http</a>", "<a href='uv-0.1.0-py3-none-win_amd64.whl#sha256=$sha'>wrong version</a>")) {
        $rejected=$false
        try { Get-LingVoiceUvWheel -Html $invalid -IndexUri 'https://example.invalid/' -Version '0.13.8' | Out-Null } catch { $rejected=$true }
        Assert-Test $rejected 'Unhashed, insecure, or unpinned uv wheel was accepted.'
    }
    Initialize-LingVoiceInstall -Root $testRoot -Source modelscope
    Assert-Test ($env:LINGVOICE_PYPI_INDEX -like '*aliyun*') 'ModelScope package source was not selected.'
    Initialize-LingVoiceInstall -Root $testRoot -Source huggingface
    Assert-Test (!$env:UV_PYTHON_INSTALL_MIRROR -and $env:LINGVOICE_PYPI_INDEX -eq 'https://pypi.org/simple/') 'Source change retained a stale mirror.'
    $env:UV_INDEX_URL='https://bad.invalid/'; $env:UV_EXTRA_INDEX_URL='https://bad.invalid/'
    Initialize-LingVoiceInstall -Root $testRoot -Source huggingface
    Assert-Test (!$env:UV_INDEX_URL -and !$env:UV_EXTRA_INDEX_URL) 'Ambient indexes leaked into the install.'
    # Exercise real native stderr/exit handling without Python, uv, or downloads.
    Invoke-LingVoiceNative $env:ComSpec @('/d','/c','echo expected-progress 1>&2 & exit /b 0')
    $rejected=$false
    try { Invoke-LingVoiceNative $env:ComSpec @('/d','/c','exit /b 17') } catch { $rejected=$true }
    Assert-Test $rejected 'Native nonzero exit code did not fail.'

    $fixture = Join-Path $testRoot 'plugins'
    [IO.Directory]::CreateDirectory($fixture) | Out-Null
    $mock = @'
function Invoke-LingVoiceNative {
    param([string]$FilePath,[string[]]$Arguments=@())
    $global:InstallerTestCalls.Add(@{File=$FilePath; Args=$Arguments})
    if ($global:InstallerTestFailImports -and $Arguments -contains '-c' -and ($Arguments -join ' ') -match 'import torch') { throw 'mock native import failure' }
    if ($Arguments -contains 'freeze') { 'mock-package==1.0' }
    if ($Arguments -contains '-r') {
        $index=[Array]::IndexOf($Arguments,'-r')
        $global:InstallerTestRequirements=[IO.File]::ReadAllText($Arguments[$index+1])
    }
}
function Receive-LingVoiceFile {
    param([string]$Uri,[string]$Destination)
    if (!$global:InstallerTestSourceArchive) { throw 'Unexpected network operation in offline test.' }
    Copy-Item -LiteralPath $global:InstallerTestSourceArchive -Destination $Destination
}
'@
    [IO.File]::WriteAllText((Join-Path $fixture 'install-common.ps1'), [IO.File]::ReadAllText((Join-Path $pluginRoot 'install-common.ps1')) + "`n" + $mock)
    foreach ($service in @('asr','translation','voice-clone')) {
        $dir = Join-Path $fixture $service
        [IO.Directory]::CreateDirectory((Join-Path $dir '.venv/Scripts')) | Out-Null
        [IO.File]::WriteAllText((Join-Path $dir '.venv/Scripts/python.exe'), '')
        Copy-Item -LiteralPath (Join-Path $pluginRoot "$service/install.ps1") -Destination (Join-Path $dir 'install.ps1')
        foreach ($name in @('requirements.in','requirements.txt')) { [IO.File]::WriteAllText((Join-Path $dir $name), 'example-package==1.0') }
    }
    [IO.Directory]::CreateDirectory((Join-Path $fixture 'runtime/tools')) | Out-Null
    [IO.File]::WriteAllText((Join-Path $fixture 'runtime/tools/uv.exe'), '')
    $revision='e91506f1fba265e1841617c3042a1573206a7351'
    $archiveRoot = Join-Path $testRoot "GPT-SoVITS-$revision"
    foreach ($relative in @('tools/uvr5/bsroformer.py','GPT_SoVITS/TTS_infer_pack/TTS.py')) {
        $file = Join-Path $archiveRoot $relative
        [IO.Directory]::CreateDirectory((Split-Path $file -Parent)) | Out-Null
        [IO.File]::WriteAllText($file, '# pinned mock source')
    }
    $global:InstallerTestSourceArchive = Join-Path $testRoot 'source.zip'
    Compress-Archive -LiteralPath $archiveRoot -DestinationPath $global:InstallerTestSourceArchive
    $sentinel = Join-Path $fixture 'voice-clone/upstream/GPT_SoVITS/pretrained_models/model.pth'
    [IO.Directory]::CreateDirectory((Split-Path $sentinel -Parent)) | Out-Null
    [IO.File]::WriteAllText($sentinel, 'KEEP MODEL')
    $global:InstallerTestFailImports=$false
    foreach ($service in @('asr','translation','voice-clone')) {
        $global:InstallerTestCalls = New-Object 'System.Collections.Generic.List[object]'
        $parameters=@{Source='huggingface'; Device='cpu'; RefreshLock=$true}
        if ($service -eq 'voice-clone') { $parameters.NoModels=$true }
        & (Join-Path $fixture "$service/install.ps1") @parameters
        $calls=$global:InstallerTestCalls.ToArray()
        $wheelCalls=@($calls | Where-Object { ($_.Args -join ' ') -match 'download.pytorch.org/whl/cpu/' })
        Assert-Test ($wheelCalls.Count -eq 1) "$service did not use explicitly pinned CPU wheels."
        $expectedTag = if ($service -eq 'voice-clone') { 'cp310' } else { 'cp312' }
        Assert-Test (($wheelCalls[0].Args -join ' ') -match "$expectedTag-$expectedTag-win_amd64") "$service selected the wrong Python ABI wheel."
        Assert-Test (!(($calls | ForEach-Object { $_.Args -join ' ' }) -join ' ' -match 'unsafe-best-match|--extra-index-url')) 'Unsafe mixed package indexes were used.'
        $nativeChecks=@($calls | Where-Object { ($_.Args -join ' ') -match 'import torch' -or $_.Args -contains '--dependencies-only' })
        Assert-Test ($nativeChecks.Count -gt 0) "$service skipped mandatory native import validation."
        $lockName=if ($service -eq 'voice-clone') { 'requirements.lock' } else { 'requirements.lock.txt' }
        $lock = Join-Path $fixture "$service/$lockName"
        Assert-Test ([IO.File]::ReadAllText($lock) -match 'mock-package==1.0') "$service failed to save a validated lock."
        $before=[IO.File]::ReadAllText($lock)
        $global:InstallerTestFailImports=$true
        $rejected=$false
        try { & (Join-Path $fixture "$service/install.ps1") @parameters } catch { $rejected=$true }
        $global:InstallerTestFailImports=$false
        Assert-Test $rejected "$service ignored native import failure."
        Assert-Test ([IO.File]::ReadAllText($lock) -eq $before) "$service overwrote a valid lock after failed imports."
        $global:InstallerTestCalls.Clear()
        $parameters.Device='cuda'
        & (Join-Path $fixture "$service/install.ps1") @parameters
        $expectedChannel=if ($service -eq 'voice-clone') { 'cu126' } else { 'cu128' }
        $cudaCalls=@($global:InstallerTestCalls.ToArray() | Where-Object { ($_.Args -join ' ') -match "download.pytorch.org/whl/$expectedChannel/" })
        Assert-Test ($cudaCalls.Count -eq 1) "$service did not preserve its pinned CUDA channel."
    }
    Assert-Test ([IO.File]::ReadAllText($sentinel) -eq 'KEEP MODEL') 'Source recovery deleted or overwrote existing model weights.'
    # Matching direct-wheel locks must not force the old origin after a mirror
    # recovery. A different CUDA/CPU lock must require an explicit refresh.
    $asrLock=Join-Path $fixture 'asr/requirements.lock.txt'
    [IO.File]::WriteAllText($asrLock, "torch @ https://download.pytorch.org/whl/cu128/torch-2.10.0%2Bcu128-cp312-cp312-win_amd64.whl`nmock-package==1.0`n")
    & (Join-Path $fixture 'asr/install.ps1') -Source huggingface -Device cuda
    Assert-Test ($global:InstallerTestRequirements -notmatch 'torch @' -and $global:InstallerTestRequirements -match 'mock-package==1.0') 'Torch origin in lock bypassed controlled wheel selection.'
    [IO.File]::WriteAllText($asrLock, 'torch==2.10.0+cu128')
    $rejected=$false
    try { & (Join-Path $fixture 'asr/install.ps1') -Source huggingface -Device cpu } catch { $rejected=$true }
    Assert-Test $rejected 'A CPU install silently accepted a conflicting CUDA lock.'
    # Force a source collision: retry must fail before changing models or source.
    $sourceFile=Join-Path $fixture 'voice-clone/upstream/tools/uvr5/bsroformer.py'
    [IO.File]::WriteAllText($sourceFile, 'LOCAL EDIT')
    Remove-Item -LiteralPath (Join-Path $fixture 'voice-clone/upstream/.lingvoice-source-revision')
    $rejected=$false
    try { & (Join-Path $fixture 'voice-clone/install.ps1') -NoModels -Source huggingface } catch { $rejected=$true }
    Assert-Test $rejected 'Source retry overwrote a conflicting local source file.'
    Assert-Test ([IO.File]::ReadAllText($sourceFile) -eq 'LOCAL EDIT' -and [IO.File]::ReadAllText($sentinel) -eq 'KEEP MODEL') 'Source retry changed local source/models.'
    Write-Host 'PASS: parser, exact uv version/platform/hash, source switching, native stderr/exit status, CPU index isolation, import gates, atomic locks, source recovery and model preservation.'
} finally {
    foreach ($name in @([Environment]::GetEnvironmentVariables('Process').Keys)) {
        if (!$previous.ContainsKey($name)) { [Environment]::SetEnvironmentVariable($name,$null,'Process') }
    }
    foreach ($name in $previous.Keys) { [Environment]::SetEnvironmentVariable($name,$previous[$name],'Process') }
    Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Variable InstallerTestCalls,InstallerTestFailImports,InstallerTestSourceArchive,InstallerTestRequirements -Scope Global -ErrorAction SilentlyContinue
}
