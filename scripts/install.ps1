# Idempotent setup for candybar-manager.
#
# Default: installs only what the splice-recovery CLI needs (npm deps + Playwright Chromium).
# Pass -Full to also build the Electron app and install the Python venv for rbx-* scripts.

[CmdletBinding()]
param(
    [switch]$Full,
    [switch]$App,
    [switch]$Rbx,
    [switch]$Force
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

function Write-Step($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }
function Write-Skip($msg) { Write-Host "    skip: $msg" -ForegroundColor DarkGray }
function Write-Done($msg) { Write-Host "    ok:   $msg" -ForegroundColor Green }

# --- Node deps ---------------------------------------------------------------
Write-Step "Checking Node"
$nodeVersion = (& node --version) 2>$null
if (-not $nodeVersion) { throw "node not found on PATH" }
$expected = (Get-Content .nvmrc -Raw).Trim()
if ($nodeVersion -notmatch "^v$expected\.") {
    Write-Warning "Node $nodeVersion found, .nvmrc pins $expected. Continuing anyway."
} else {
    Write-Done "node $nodeVersion matches .nvmrc ($expected)"
}

Write-Step "npm install"
if ((Test-Path node_modules) -and -not $Force) {
    Write-Skip "node_modules exists (pass -Force to reinstall)"
} else {
    & npm install
    if ($LASTEXITCODE -ne 0) { throw "npm install failed" }
    Write-Done "dependencies installed"
}

# --- Playwright browser ------------------------------------------------------
Write-Step "Playwright Chromium"
$pwCache = Join-Path $env:USERPROFILE 'AppData\Local\ms-playwright'
$hasChromium = (Test-Path $pwCache) -and (Get-ChildItem $pwCache -Directory -Filter 'chromium-*' -ErrorAction SilentlyContinue)
if ($hasChromium -and -not $Force) {
    Write-Skip "Chromium already cached at $pwCache"
} else {
    & npx --yes playwright install chromium
    if ($LASTEXITCODE -ne 0) { throw "playwright install failed" }
    Write-Done "Chromium installed"
}

# --- Electron app build (optional) ------------------------------------------
if ($Full -or $App) {
    Write-Step "Building Electron app"
    & npm run build
    if ($LASTEXITCODE -ne 0) { throw "npm run build failed" }
    Write-Done "app built into dist/"
}

# --- Python venv for rbx-* scripts (optional) -------------------------------
if ($Full -or $Rbx) {
    Write-Step "Python venv for rbx-* scripts"
    $py = Get-Command py -ErrorAction SilentlyContinue
    if (-not $py) { $py = Get-Command python -ErrorAction SilentlyContinue }
    if (-not $py) { throw "python not found on PATH" }

    if ((Test-Path .venv-rbx) -and -not $Force) {
        Write-Skip ".venv-rbx exists (pass -Force to recreate)"
    } else {
        & $py.Source -m venv .venv-rbx
        if ($LASTEXITCODE -ne 0) { throw "venv creation failed" }
        Write-Done ".venv-rbx created"
    }

    $venvPip = Join-Path $repoRoot '.venv-rbx\Scripts\pip.exe'
    & $venvPip install --upgrade pip pyrekordbox
    if ($LASTEXITCODE -ne 0) { throw "pip install pyrekordbox failed" }
    Write-Done "pyrekordbox installed in .venv-rbx"
}

Write-Host ""
Write-Host "Done." -ForegroundColor Green
if (-not ($Full -or $App)) {
    Write-Host "Splice recovery is ready. Next: log in once with 'node splice-api-recon.mjs'." -ForegroundColor Yellow
}
