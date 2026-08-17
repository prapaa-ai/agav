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
function Save-FileWithProgress {
    param(
        [Parameter(Mandatory = $true)][string]$Url,
        [Parameter(Mandatory = $true)][string]$Destination,
        [string]$Activity = "Downloading"
    )

    # `irm | iex` inherits the caller's session, where a profile may have set
    # this to SilentlyContinue and would silently swallow the whole bar.
    $ProgressPreference = "Continue"

    Add-Type -AssemblyName System.Net.Http
    $Handler = New-Object System.Net.Http.HttpClientHandler
    # DefaultProxyCredentials needs .NET Framework 4.7.1+; older machines still
    # download fine, just without automatic proxy auth.
    try {
        $Handler.DefaultProxyCredentials = [System.Net.CredentialCache]::DefaultCredentials
    } catch {}
    $Client = New-Object System.Net.Http.HttpClient($Handler)
    $Client.DefaultRequestHeaders.UserAgent.ParseAdd("agav-installer")
    $Response = $null
    $InputStream = $null
    $OutputStream = $null

    try {
        $Response = $Client.GetAsync($Url, [System.Net.Http.HttpCompletionOption]::ResponseHeadersRead).GetAwaiter().GetResult()
        $Response.EnsureSuccessStatusCode() | Out-Null

        $TotalBytes = $Response.Content.Headers.ContentLength
        $InputStream = $Response.Content.ReadAsStreamAsync().GetAwaiter().GetResult()
        $OutputStream = [System.IO.File]::Open($Destination, [System.IO.FileMode]::Create)
        $Buffer = New-Object byte[] (64KB)
        $Downloaded = [int64]0
        $Stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
        # Every Write-Progress forces a console redraw, which is slow enough on
        # the PS 5.1 host to dominate the download. Repaint at most every
        # 100 ms, and only when something visible actually changed.
        $LastPaintMs = [int64]-1000
        $LastPercent = -1

        while (($Read = $InputStream.Read($Buffer, 0, $Buffer.Length)) -gt 0) {
            $OutputStream.Write($Buffer, 0, $Read)
            $Downloaded += $Read

            $ElapsedMs = $Stopwatch.ElapsedMilliseconds
            if ($TotalBytes -and $TotalBytes -gt 0) {
                $Percent = [Math]::Min(100, [int](($Downloaded * 100) / $TotalBytes))
            } else {
                $Percent = -1
            }
            if (($ElapsedMs - $LastPaintMs) -lt 100 -and $Percent -eq $LastPercent) { continue }
            $LastPaintMs = $ElapsedMs
            $LastPercent = $Percent

            $DownloadedMB = $Downloaded / 1MB
            $Seconds = $Stopwatch.Elapsed.TotalSeconds
            $Speed = if ($Seconds -gt 0) { $DownloadedMB / $Seconds } else { 0 }

            if ($Percent -ge 0) {
                $Status = "{0:N1} MB / {1:N1} MB ({2:N1} MB/s)" -f $DownloadedMB, ($TotalBytes / 1MB), $Speed
                Write-Progress -Activity $Activity -Status $Status -PercentComplete $Percent
            } else {
                $Status = "{0:N1} MB ({1:N1} MB/s)" -f $DownloadedMB, $Speed
                Write-Progress -Activity $Activity -Status $Status
            }
        }
    } finally {
        Write-Progress -Activity $Activity -Completed
        if ($OutputStream) { $OutputStream.Dispose() }
        if ($InputStream) { $InputStream.Dispose() }
        if ($Response) { $Response.Dispose() }
        $Client.Dispose()
        $Handler.Dispose()
    }
}

if (-not (Test-Path $InstallDir)) {
    New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
}

$TmpFile = Join-Path $InstallDir "$BinaryName.tmp"
try {
    Save-FileWithProgress -Url $DownloadUrl -Destination $TmpFile -Activity "Downloading $AssetName"
} catch {
    # Write-Host, not Write-Error: $ErrorActionPreference is Stop, so a
    # Write-Error here would abort the handler before the cleanup below runs.
    Write-Host "Download failed: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host "Check available releases: https://github.com/$Repo/releases" -ForegroundColor Red
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
