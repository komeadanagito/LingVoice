param([switch]$SkipPython)
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
[IO.Directory]::CreateDirectory($env:TEMP) | Out-Null
$uv = Join-Path $tools 'uv.exe'
if (!(Test-Path $uv)) {
    $version = '0.13.8'
    $name = 'uv-x86_64-pc-windows-msvc.zip'
    $url = "https://github.com/astral-sh/uv/releases/download/$version/$name"
    $zip = Join-Path $tools $name
    & curl.exe --fail --location --retry 4 --output $zip $url
    if ($LASTEXITCODE -ne 0) { throw 'uv download failed.' }
    $checksumFile = "$zip.sha256"
    & curl.exe --fail --location --retry 4 --output $checksumFile "$url.sha256"
    if ($LASTEXITCODE -ne 0) { throw 'uv checksum download failed.' }
    $expected = ((Get-Content $checksumFile -Raw).Trim() -split '\s+')[0].ToLowerInvariant()
    $actual = (Get-FileHash -Algorithm SHA256 $zip).Hash.ToLowerInvariant()
    if ($expected -notmatch '^[a-f0-9]{64}$' -or $actual -ne $expected) { throw 'uv SHA256 mismatch.' }
    Expand-Archive -LiteralPath $zip -DestinationPath $tools -Force
    @{tag=$version;url=$url;sha256=$actual} | ConvertTo-Json | Set-Content (Join-Path $tools 'source.json') -Encoding UTF8
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
