param(
    [switch]$SkipPython,
    [ValidateSet('modelscope', 'huggingface')][string]$Source = 'modelscope'
)
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$runtime = Join-Path $root 'runtime'
$tools = Join-Path $runtime 'tools'
[IO.Directory]::CreateDirectory($tools) | Out-Null
$env:UV_PYTHON_INSTALL_DIR = Join-Path $runtime 'python'
$env:UV_CACHE_DIR = Join-Path $runtime 'cache/uv'
$env:UV_PYTHON_BIN_DIR = Join-Path $runtime 'bin'
$env:PIP_CACHE_DIR = Join-Path $runtime 'cache/pip'
$env:PYTHONNOUSERSITE = '1'
$env:PYTHONPATH = $null
$env:PYTHONHOME = $null
$env:TEMP = Join-Path $runtime 'tmp'
$env:TMP = $env:TEMP
if ($Source -eq 'modelscope') {
    $env:UV_PYTHON_INSTALL_MIRROR = 'https://registry.npmmirror.com/-/binary/python-build-standalone'
    $env:LINGVOICE_PYPI_INDEX = 'https://mirrors.aliyun.com/pypi/simple/'
}
$env:UV_DEFAULT_INDEX = $null
$env:UV_INDEX_URL = $null
$env:UV_HTTP_TIMEOUT = '300'
[IO.Directory]::CreateDirectory($env:TEMP) | Out-Null
$uv = Join-Path $tools 'uv.exe'
if (!(Test-Path $uv)) {
    $version = '0.13.8'
    $name = 'uv-x86_64-pc-windows-msvc.zip'
    $url = "https://github.com/astral-sh/uv/releases/download/$version/$name"
    $zip = Join-Path $tools $name
    $downloadedFromGithub = $false
    if ($Source -ne 'modelscope') {
        & curl.exe --fail --location --retry 3 --connect-timeout 20 --output $zip $url
        if ($LASTEXITCODE -eq 0) {
            $checksumFile = "$zip.sha256"
            & curl.exe --fail --location --retry 3 --connect-timeout 20 --output $checksumFile "$url.sha256"
            if ($LASTEXITCODE -eq 0) {
                $expected = ((Get-Content $checksumFile -Raw).Trim() -split '\s+')[0].ToLowerInvariant()
                $actual = (Get-FileHash -Algorithm SHA256 $zip).Hash.ToLowerInvariant()
                if ($expected -match '^[a-f0-9]{64}$' -and $actual -eq $expected) {
                    Expand-Archive -LiteralPath $zip -DestinationPath $tools -Force
                    @{tag=$version;url=$url;sha256=$actual} | ConvertTo-Json | Set-Content (Join-Path $tools 'source.json') -Encoding UTF8
                    $downloadedFromGithub = $true
                }
            }
        }
    }
    if (!$downloadedFromGithub) {
        # Fallback: download the official uv wheel from Aliyun/Tsinghua PyPI mirror and extract uv.exe.
        $wheelUrl = $null
        $wheelSha = $null
        foreach ($indexBase in @('https://mirrors.aliyun.com/pypi/simple/uv/', 'https://pypi.tuna.tsinghua.edu.cn/simple/uv/', 'https://pypi.org/simple/uv/')) {
            try {
                $html = (Invoke-WebRequest -Uri $indexBase -UseBasicParsing -TimeoutSec 20).Content
                $match = [regex]::Match($html, 'href="([^"]*uv-0\.[0-9.]+-py3-none-win_amd64\.whl)(?:#sha256=([a-f0-9]{64}))?"')
                if (!$match.Success) {
                    $matches = [regex]::Matches($html, 'href="([^"]*uv-[^"]*-py3-none-win_amd64\.whl)(?:#sha256=([a-f0-9]{64}))?"')
                    if ($matches.Count -gt 0) { $match = $matches[$matches.Count - 1] }
                }
                if ($match.Success) {
                    $rawHref = $match.Groups[1].Value
                    $wheelUrl = if ($rawHref -match '^https?://') { $rawHref } else { ([Uri]::new([Uri]$indexBase, $rawHref)).AbsoluteUri }
                    if ($match.Groups[2].Success) { $wheelSha = $match.Groups[2].Value.ToLowerInvariant() }
                    break
                }
            } catch {}
        }
        if (!$wheelUrl) { throw 'uv download failed (neither GitHub nor PyPI mirror is reachable).' }
        $whl = Join-Path $tools 'uv-win_amd64.whl.zip'
        & curl.exe --fail --location --retry 4 --connect-timeout 30 --output $whl $wheelUrl
        if ($LASTEXITCODE -ne 0) { throw 'uv wheel download failed.' }
        $actual = (Get-FileHash -Algorithm SHA256 $whl).Hash.ToLowerInvariant()
        if ($wheelSha -and $actual -ne $wheelSha) { throw 'uv wheel SHA256 mismatch.' }
        $extractDir = Join-Path $tools '_whl_extract'
        if (Test-Path $extractDir) { Remove-Item -Recurse -Force $extractDir }
        Expand-Archive -LiteralPath $whl -DestinationPath $extractDir -Force
        $foundUv = Get-ChildItem -Path $extractDir -Filter 'uv.exe' -Recurse | Select-Object -First 1
        if (!$foundUv) { throw 'uv.exe missing inside downloaded wheel.' }
        Copy-Item -LiteralPath $foundUv.FullName -Destination $uv -Force
        Remove-Item -Recurse -Force $extractDir, $whl -ErrorAction SilentlyContinue
        @{tag='pypi-wheel';url=$wheelUrl;sha256=$actual} | ConvertTo-Json | Set-Content (Join-Path $tools 'source.json') -Encoding UTF8
    }
}
& $uv --version
if ($LASTEXITCODE -ne 0) { throw 'uv executable failed.' }
if (!$SkipPython) {
    & $uv python install 3.12 3.10 --no-bin
    if ($LASTEXITCODE -ne 0) { throw 'Project Python installation failed.' }
    foreach ($service in @('asr','translation','voice-clone','installer')) {
        $dir = Join-Path $root $service
        [IO.Directory]::CreateDirectory($dir) | Out-Null
        $version = if ($service -eq 'voice-clone') { '3.10' } else { '3.12' }
        if (!(Test-Path (Join-Path $dir '.venv/Scripts/python.exe'))) {
            & $uv venv (Join-Path $dir '.venv') --python $version --managed-python
            if ($LASTEXITCODE -ne 0) { throw "Environment creation failed: $service" }
        }
    }
}
