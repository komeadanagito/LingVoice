param(
    [switch]$SkipPython,
    [ValidateSet('modelscope', 'huggingface')][string]$Source = 'modelscope'
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'install-common.ps1')
$root = $PSScriptRoot
Initialize-LingVoiceInstall -Root $root -Source $Source
# The dependency wheels are Windows x64. Do not silently provision ARM Python.
if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64' -or $env:PROCESSOR_ARCHITEW6432 -eq 'ARM64') {
    throw 'These pinned dependency wheels require Windows x64; native Windows ARM64 is not supported.'
}
$tools = Join-Path $root 'runtime/tools'
[IO.Directory]::CreateDirectory($tools) | Out-Null
$uv = Join-Path $tools 'uv.exe'
$version = '0.13.8'
$validUv = $false
if (Test-Path -LiteralPath $uv) {
    try {
        $reported = (Invoke-LingVoiceNative $uv @('--version')) -join ''
        $record = Get-Content (Join-Path $tools 'source.json') -Raw | ConvertFrom-Json
        $validUv = $reported -match "^uv $([regex]::Escape($version))(\s|$)" -and $record.version -eq $version -and $record.executableSha256 -eq (Get-FileHash -LiteralPath $uv -Algorithm SHA256).Hash
    } catch { $validUv = $false }
}
if (!$validUv) {
    $indexes = if ($Source -eq 'modelscope') {
        @('https://mirrors.aliyun.com/pypi/simple/uv/', 'https://pypi.tuna.tsinghua.edu.cn/simple/uv/', 'https://pypi.org/simple/uv/')
    } else { @('https://pypi.org/simple/uv/', 'https://mirrors.aliyun.com/pypi/simple/uv/', 'https://pypi.tuna.tsinghua.edu.cn/simple/uv/') }
    $installed = $false
    foreach ($index in $indexes) {
        $stage = Join-Path $tools ('uv-stage-' + [Guid]::NewGuid().ToString('N'))
        [IO.Directory]::CreateDirectory($stage) | Out-Null
        try {
            $indexFile = Join-Path $stage 'index.html'
            Receive-LingVoiceFile -Uri $index -Destination $indexFile -TimeoutSec 60
            $wheel = Get-LingVoiceUvWheel -Html ([IO.File]::ReadAllText($indexFile)) -IndexUri $index -Version $version
            $archive = Join-Path $stage 'uv.zip'
            Receive-LingVoiceFile -Uri $wheel.Url -Destination $archive
            $actual = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
            if ($actual -ne $wheel.Sha256) { throw 'uv wheel SHA256 mismatch.' }
            $extracted = Join-Path $stage 'extracted'
            Expand-Archive -LiteralPath $archive -DestinationPath $extracted
            $executables = @(Get-ChildItem -LiteralPath $extracted -Filter 'uv.exe' -Recurse -File)
            if ($executables.Count -ne 1) { throw 'Expected exactly one uv.exe in the pinned wheel.' }
            $reported = (Invoke-LingVoiceNative $executables[0].FullName @('--version')) -join ''
            if ($reported -notmatch "^uv $([regex]::Escape($version))(\s|$)") { throw 'Downloaded uv version does not match the pin.' }
            Copy-Item -LiteralPath $executables[0].FullName -Destination $uv -Force
            @{version=$version; url=$wheel.Url; sha256=$actual; executableSha256=(Get-FileHash -LiteralPath $uv -Algorithm SHA256).Hash} | ConvertTo-Json | Set-Content (Join-Path $tools 'source.json') -Encoding UTF8
            $installed = $true
            break
        } catch { Write-Warning "uv source failed ($index): $($_.Exception.Message)" }
        finally { Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue }
    }
    if (!$installed) { throw "Could not provision SHA256-verified uv $version from any source. Existing runtimes were preserved; retry bootstrap when connectivity is restored." }
}
Invoke-LingVoiceNative $uv @('--version')
if (!$SkipPython) {
    try { Invoke-LingVoiceNative $uv @('python','install','3.12','3.10','--no-bin') }
    catch {
        if ($Source -ne 'modelscope') { throw }
        Write-Warning 'Python mirror failed; retrying the official standalone Python source.'
        $env:UV_PYTHON_INSTALL_MIRROR = $null
        Invoke-LingVoiceNative $uv @('python','install','3.12','3.10','--no-bin')
    }
    foreach ($service in @('asr','translation','voice-clone','installer')) {
        $dir = Join-Path $root $service
        [IO.Directory]::CreateDirectory($dir) | Out-Null
        $pythonVersion = if ($service -eq 'voice-clone') { '3.10' } else { '3.12' }
        $venv = Join-Path $dir '.venv'
        $python = Join-Path $venv 'Scripts/python.exe'
        if (!(Test-Path -LiteralPath $python)) {
            if (Test-Path -LiteralPath $venv) { throw "Incomplete environment at $venv. Rename only that .venv directory and retry; models and caches must be preserved." }
            Invoke-LingVoiceNative $uv @('venv',$venv,'--python',$pythonVersion,'--managed-python')
        }
        Assert-LingVoicePython -Python $python -Version $pythonVersion
    }
}
