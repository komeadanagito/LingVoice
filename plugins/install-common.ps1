# Shared Windows installer helpers. Dot-source this file; no machine-wide settings are changed.
function Invoke-LingVoiceNative {
    param([Parameter(Mandatory=$true)][string]$FilePath, [string[]]$Arguments = @())
    # Windows PowerShell treats redirected native stderr as ErrorRecords under Stop.
    # Keep progress on stderr visible, but decide success exclusively from the exit code.
    $oldPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $global:LASTEXITCODE = $null
        & $FilePath @Arguments
        $code = $global:LASTEXITCODE
    } finally { $ErrorActionPreference = $oldPreference }
    if ($null -eq $code -or $code -ne 0) { throw "Native command failed (exit $code): $FilePath $($Arguments -join ' ')" }
}

function Initialize-LingVoiceInstall {
    param([string]$Root, [ValidateSet('modelscope','huggingface')][string]$Source)
    $runtime = Join-Path $Root 'runtime'
    $values = @{
        UV_PYTHON_INSTALL_DIR=(Join-Path $runtime 'python'); UV_PYTHON_BIN_DIR=(Join-Path $runtime 'bin');
        UV_CACHE_DIR=(Join-Path $runtime 'cache/uv'); PIP_CACHE_DIR=(Join-Path $runtime 'cache/pip');
        TEMP=(Join-Path $runtime 'tmp'); TMP=(Join-Path $runtime 'tmp');
        PYTHONNOUSERSITE='1'; PYTHONPATH=$null; PYTHONHOME=$null; PYTHONUTF8='1'; PYTHONIOENCODING='utf-8';
        UV_DEFAULT_INDEX=$null; UV_INDEX_URL=$null; UV_INDEX=$null; UV_EXTRA_INDEX_URL=$null;
        UV_NO_CONFIG='1'; UV_HTTP_TIMEOUT='300'; UV_HTTP_RETRIES='4'; UV_PYTHON_DOWNLOADS='automatic';
        LINGVOICE_MODEL_SOURCE=$Source; HF_HUB_DISABLE_TELEMETRY='1'; HF_HUB_DISABLE_XET='1'
    }
    if ($Source -eq 'modelscope') {
        $values.UV_PYTHON_INSTALL_MIRROR = 'https://registry.npmmirror.com/-/binary/python-build-standalone'
        $values.LINGVOICE_PYPI_INDEX = 'https://mirrors.aliyun.com/pypi/simple/'
    } else {
        # Explicit reset is essential when switching sources in the same terminal.
        $values.UV_PYTHON_INSTALL_MIRROR = $null
        $values.LINGVOICE_PYPI_INDEX = 'https://pypi.org/simple/'
    }
    foreach ($name in $values.Keys) { [Environment]::SetEnvironmentVariable($name, $values[$name], 'Process') }
    foreach ($dir in @($env:TEMP, $env:UV_CACHE_DIR, $env:PIP_CACHE_DIR)) { [IO.Directory]::CreateDirectory($dir) | Out-Null }
}

function Receive-LingVoiceFile {
    param([string]$Uri, [string]$Destination, [int]$TimeoutSec = 900)
    $partial = "$Destination.partial"
    try {
        if (Get-Command curl.exe -ErrorAction SilentlyContinue) {
            Invoke-LingVoiceNative 'curl.exe' @('--fail','--location','--retry','3','--retry-delay','2','--connect-timeout','30','--max-time',[string]$TimeoutSec,'--speed-limit','1024','--speed-time','90','--output',$partial,$Uri)
        } else {
            # TLS 1.2 is not the default on all clean Windows PowerShell installations.
            $oldTls = [Net.ServicePointManager]::SecurityProtocol
            try {
                [Net.ServicePointManager]::SecurityProtocol = $oldTls -bor [Net.SecurityProtocolType]::Tls12
                Invoke-WebRequest -Uri $Uri -OutFile $partial -UseBasicParsing -TimeoutSec $TimeoutSec
            } finally { [Net.ServicePointManager]::SecurityProtocol = $oldTls }
        }
        Move-Item -LiteralPath $partial -Destination $Destination -Force
    } finally { if (Test-Path -LiteralPath $partial) { Remove-Item -LiteralPath $partial -Force } }
}

function Expand-LingVoiceSourceArchive {
    param([string]$Archive, [string]$Destination, [string]$RootName)
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = [IO.Compression.ZipFile]::OpenRead($Archive)
    try {
        [IO.Directory]::CreateDirectory($Destination) | Out-Null
        $basePath = [IO.Path]::GetFullPath($Destination).TrimEnd('\') + '\'
        foreach ($entry in $zip.Entries) {
            $name = $entry.FullName.Replace('\','/')
            if (!$name.StartsWith("$RootName/", [StringComparison]::Ordinal)) { throw "Unexpected source archive member: $name" }
            $relative = $name.Substring($RootName.Length + 1)
            if (!$relative) { continue }
            $target = [IO.Path]::GetFullPath((Join-Path $Destination $relative))
            if (!$target.StartsWith($basePath, [StringComparison]::OrdinalIgnoreCase)) { throw "Unsafe source archive member: $name" }
            if ($name.EndsWith('/')) { [IO.Directory]::CreateDirectory($target) | Out-Null; continue }
            [IO.Directory]::CreateDirectory((Split-Path $target -Parent)) | Out-Null
            $inputStream = $entry.Open()
            try {
                $outputStream = [IO.File]::Open($target, [IO.FileMode]::CreateNew)
                try { $inputStream.CopyTo($outputStream) } finally { $outputStream.Dispose() }
            } finally { $inputStream.Dispose() }
        }
    } finally { $zip.Dispose() }
}

function Get-LingVoiceUvWheel {
    param([string]$Html, [string]$IndexUri, [string]$Version)
    $fileName = "uv-$Version-py3-none-win_amd64.whl"
    foreach ($link in [regex]::Matches($Html, 'href\s*=\s*["'']([^"'']+)["'']', 'IgnoreCase')) {
        $href = [Net.WebUtility]::HtmlDecode($link.Groups[1].Value)
        $uri = [Uri]::new([Uri]$IndexUri, $href)
        if ([Uri]::UnescapeDataString(($uri.AbsolutePath -split '/')[-1]) -ne $fileName) { continue }
        if ($uri.Scheme -ne 'https' -or $uri.Fragment -notmatch '^#sha256=([a-fA-F0-9]{64})$') { continue }
        return @{ Url=$uri.GetLeftPart([UriPartial]::Path); Sha256=$Matches[1].ToLowerInvariant(); Version=$Version }
    }
    throw "Index has no SHA256-pinned Windows x64 uv $Version wheel: $IndexUri"
}

function Assert-LingVoicePython {
    param([string]$Python, [string]$Version)
    if (!(Test-Path -LiteralPath $Python)) { throw 'Run plugins/bootstrap.ps1 first to create project-local Python environments.' }
    Invoke-LingVoiceNative $Python @('-I','-c',"import sys,struct; assert sys.platform == 'win32' and struct.calcsize('P') == 8 and '.'.join(map(str,sys.version_info[:2])) == '$Version', 'Wrong Python architecture/version; recreate this service venv with bootstrap.ps1'")
}

function Install-LingVoicePackages {
    param([string]$Uv, [string]$Python, [string]$Requirements, [string[]]$TorchPackages, [string]$Channel, [ValidateSet('cp310','cp312')][string]$PythonTag = 'cp312')
    if (!(Test-Path -LiteralPath $Uv)) { throw 'Project uv is missing; run plugins/bootstrap.ps1 first.' }
    if (!(Test-Path -LiteralPath $Requirements)) { throw "Requirements file missing: $Requirements" }
    $constraints = Join-Path $env:TEMP ("torch-constraints-" + [Guid]::NewGuid().ToString('N') + '.txt')
    # Freeze records direct wheel URLs. Strip only matching, already-owned torch
    # entries so a lock cannot undo the verified channel or force a failed origin
    # after mirror recovery. Keep relative includes anchored beside the source file.
    $filteredRequirements = Join-Path (Split-Path $Requirements -Parent) ('.install-' + [Guid]::NewGuid().ToString('N') + '.txt')
    try {
        $filtered = @()
        foreach ($line in [IO.File]::ReadAllLines($Requirements)) {
            $owned = $false
            foreach ($package in $TorchPackages) {
                $parts = $package -split '=='
                $namePattern = [regex]::Escape($parts[0])
                if ($line -match "^\s*$namePattern(?:==|\s*@\s*)") {
                    $decoded = [Uri]::UnescapeDataString($line)
                    if ($decoded.Trim() -ne $package -and $decoded -notmatch "$namePattern-$([regex]::Escape($parts[1]))-$PythonTag-$PythonTag-win_amd64\.whl(?:\s|#|$)") {
                        throw "Lock requests a different $($parts[0]) version/channel/ABI. Use -RefreshLock explicitly when changing CPU/CUDA or Python versions."
                    }
                    $owned = $true
                    break
                }
            }
            if (!$owned) { $filtered += $line }
        }
        [IO.File]::WriteAllLines($filteredRequirements, [string[]]$filtered, [Text.UTF8Encoding]::new($false))
        [IO.File]::WriteAllLines($constraints, $TorchPackages, [Text.UTF8Encoding]::new($false))
        # Only exact PyTorch packages come from the CUDA/CPU index. All transitive
        # dependencies use the selected PyPI source, with no unsafe cross-index resolution.
        $tag = $PythonTag
        $wheels = @()
        foreach ($package in $TorchPackages) {
            $parts = $package -split '=='
            $version = $parts[1].Replace('+','%2B')
            $wheels += "https://download.pytorch.org/whl/$Channel/$($parts[0])-$version-$tag-$tag-win_amd64.whl"
        }
        try { Invoke-LingVoiceNative $Uv (@('pip','install','--python',$Python,'--index-url',$env:LINGVOICE_PYPI_INDEX) + $wheels) }
        catch {
            if ($env:LINGVOICE_MODEL_SOURCE -ne 'modelscope') { throw }
            Write-Warning 'Official PyTorch download failed; retrying the same pinned wheels from Aliyun (no CPU/CUDA substitution).'
            $mirrorWheels = @($wheels | ForEach-Object { $_.Replace('https://download.pytorch.org/whl/', 'https://mirrors.aliyun.com/pytorch-wheels/') })
            Invoke-LingVoiceNative $Uv (@('pip','install','--python',$Python,'--index-url','https://pypi.org/simple/') + $mirrorWheels)
        }
        try { Invoke-LingVoiceNative $Uv @('pip','install','--python',$Python,'--index-url',$env:LINGVOICE_PYPI_INDEX,'--constraint',$constraints,'-r',$filteredRequirements) }
        catch {
            if ($env:LINGVOICE_PYPI_INDEX -eq 'https://pypi.org/simple/') { throw }
            Write-Warning 'Selected PyPI mirror failed; retrying dependencies from official PyPI.'
            Invoke-LingVoiceNative $Uv @('pip','install','--python',$Python,'--index-url','https://pypi.org/simple/','--constraint',$constraints,'-r',$filteredRequirements)
        }
        Invoke-LingVoiceNative $Uv @('pip','check','--python',$Python)
    } finally {
        foreach ($temporary in @($constraints,$filteredRequirements)) { if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force } }
    }
}

function Write-LingVoiceLock {
    param([string]$Uv, [string]$Python, [string]$Path)
    $lines = @(Invoke-LingVoiceNative $Uv @('pip','freeze','--python',$Python))
    if ($lines.Count -eq 0) { throw 'Refusing to save an empty dependency lock.' }
    $temporary = "$Path.partial"
    [IO.File]::WriteAllLines($temporary, [string[]]$lines, [Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $temporary -Destination $Path -Force
}
