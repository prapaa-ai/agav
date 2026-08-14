# Keep this file pure ASCII. install.cmd fetches it with Invoke-WebRequest,
# which writes raw bytes, and Windows PowerShell 5.1 decodes a BOM-less -File
# script as Windows-1252. A UTF-8 char whose trailing byte is 0x93/0x94 then
# becomes a smart quote, which the parser accepts as a string delimiter and
# the whole script fails to parse.
$ErrorActionPreference = "Stop"

$Repo = "prapaa-ai/agav"
$BinaryName = "agav.exe"
$Version = if ($env:AGAV_VERSION) { $env:AGAV_VERSION } else { "latest" }
$InstallDir = if ($env:AGAV_INSTALL_DIR) { $env:AGAV_INSTALL_DIR } else { "$env:LOCALAPPDATA\agav" }

# --- Parse flags ---
foreach ($arg in $args) {
    if ($arg -eq "--uninstall") {
        $Target = Join-Path $InstallDir $BinaryName
        if (Test-Path $Target) {
            Remove-Item $Target -Force
            Write-Host "Uninstalled agav from $InstallDir" -ForegroundColor Green
        } else {
            Write-Host "agav not found in $InstallDir" -ForegroundColor Red
        }
        exit 0
    }
    if ($arg -match "^--version=(.+)$") { $Version = $Matches[1] }
    if ($arg -match "^--dir=(.+)$") { $InstallDir = $Matches[1] }
    if ($arg -eq "--help" -or $arg -eq "-h") {
        Write-Host "Usage: install.ps1 [OPTIONS]"
        Write-Host ""
        Write-Host "Options:"
        Write-Host "  --version=<tag>    Install a specific version (default: latest)"
        Write-Host "  --dir=<path>       Install directory (default: %LOCALAPPDATA%\agav)"
        Write-Host "  --uninstall        Remove agav"
        Write-Host "  -h, --help         Show this help"
        exit 0
    }
}

# --- Detect architecture ---
if (-not [Environment]::Is64BitOperatingSystem) {
    Write-Host "Unsupported: 32-bit systems are not supported." -ForegroundColor Red
    exit 1
}

# Bun has no windows-arm64 compile target, and Windows on ARM runs x64
# binaries under emulation, so every 64-bit machine gets the x64 build.
$Arch = "x64"
if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64" -or $env:PROCESSOR_ARCHITEW6432 -eq "ARM64") {
    Write-Host "agav -> ARM64 detected; installing the x64 build (runs under emulation)." -ForegroundColor Cyan
}

$Target = "windows-$Arch"
$AssetName = "agav-$Target.exe"

# --- Check existing install ---
$FinalPath = Join-Path $InstallDir $BinaryName
if (Test-Path $FinalPath) {
    try {
        $ExistingVer = & $FinalPath --version 2>&1 | Select-String -Pattern '\d+\.\d+\.\d+' | ForEach-Object { $_.Matches[0].Value }
        Write-Host "agav -> Existing installation found: v$ExistingVer" -ForegroundColor Cyan
        Write-Host "agav -> Upgrading..." -ForegroundColor Cyan
    } catch {}
}

# --- Resolve download URL ---
if ($Version -eq "latest") {
    $DownloadUrl = "https://github.com/$Repo/releases/latest/download/$AssetName"
} else {
    $DownloadUrl = "https://github.com/$Repo/releases/download/$Version/$AssetName"
}

Write-Host "agav -> Downloading agav for $Target..." -ForegroundColor Cyan

# --- Download ---
if (-not (Test-Path $InstallDir)) {
    New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
}

$TmpFile = Join-Path $InstallDir "$BinaryName.tmp"
try {
    Invoke-WebRequest -Uri $DownloadUrl -OutFile $TmpFile -UseBasicParsing
} catch {
    Write-Error "Download failed - release not found for $Target"
    Write-Error "Check available releases: https://github.com/$Repo/releases"
    if (Test-Path $TmpFile) { Remove-Item $TmpFile -Force }
    exit 1
}

# --- Install ---
Move-Item -Path $TmpFile -Destination $FinalPath -Force

# --- Verify ---
try {
    $InstalledVer = & $FinalPath --version 2>&1 | Select-String -Pattern '\d+\.\d+\.\d+' | ForEach-Object { $_.Matches[0].Value }
    Write-Host "Agav v$InstalledVer installed to $FinalPath" -ForegroundColor Green
} catch {
    Write-Host "Agav installed to $FinalPath" -ForegroundColor Green
}

# --- PATH check ---
$UserPath = [Environment]::GetEnvironmentVariable("PATH", "User")
if ($UserPath -notlike "*$InstallDir*") {
    [Environment]::SetEnvironmentVariable("PATH", "$InstallDir;$UserPath", "User")
    Write-Host ""
    Write-Host "agav -> Added $InstallDir to your PATH." -ForegroundColor Cyan
    Write-Host "agav -> Restart your terminal, then run 'agav' to get started." -ForegroundColor Cyan
} else {
    Write-Host ""
    Write-Host "agav -> Run 'agav' to get started." -ForegroundColor Cyan
}
