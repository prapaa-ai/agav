# Keep this file pure ASCII. install.cmd fetches it with Invoke-WebRequest,
# which writes raw bytes, and Windows PowerShell 5.1 decodes a BOM-less -File
# script as Windows-1252. A UTF-8 char whose trailing byte is 0x93/0x94 then
# becomes a smart quote, which the parser accepts as a string delimiter and
# the whole script fails to parse.
$ErrorActionPreference = "Stop"

# .NET Framework older than 4.7 negotiates TLS 1.0/1.1 by default, which
# github.com refuses outright. Additive so we never downgrade a host that
# already prefers something stronger.
try {
    [Net.ServicePointManager]::SecurityProtocol =
        [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
} catch {}

$Repo = "prapaa-ai/agav"
$BinaryName = "agav.exe"
$Version = if ($env:AGAV_VERSION) { $env:AGAV_VERSION } else { "latest" }
$InstallDir = if ($env:AGAV_INSTALL_DIR) { $env:AGAV_INSTALL_DIR } else { "$env:LOCALAPPDATA\agav" }
$SkipChecksum = $env:AGAV_SKIP_CHECKSUM -match '^(1|true|yes)$'
$Beta = $env:AGAV_BETA -match '^(1|true|yes)$'

# Windows refuses to delete the image of a running process, so an update
# renames the old exe aside and deletes it later. Sweep whatever earlier runs
# could not, before anything else touches the directory. A ~100 MB leftover per
# interrupted install adds up fast.
function Remove-StaleArtifacts {
    param([Parameter(Mandatory = $true)][string]$Dir, [Parameter(Mandatory = $true)][string]$Name)

    if (-not (Test-Path -LiteralPath $Dir)) { return }

    Get-ChildItem -LiteralPath $Dir -Filter "$Name.*" -File -ErrorAction SilentlyContinue |
        ForEach-Object {
            $Leftover = $_.Name
            # Both are named "<binary>.<pid>.<ext>"; the legacy installer wrote a
            # plain "<binary>.tmp" with no pid, which nothing produces any more.
            if ($Leftover -eq "$Name.tmp") {
                Remove-Item -LiteralPath $_.FullName -Force -ErrorAction SilentlyContinue
                return
            }
            if ($Leftover -notmatch "^$([regex]::Escape($Name))\.(\d+)\.(bak|tmp)(\.gz)?$") { return }
            $PidText = $Matches[1]
            $Kind = $Matches[2]
            # TryParse, not [int]: \d+ happily matches a number too large for an
            # Int32, and the cast would throw under $ErrorActionPreference =
            # "Stop", aborting the whole install from inside a cleanup routine
            # whose entire job is to tolerate junk. Nothing we wrote looks like
            # that, so treat it as ownerless and sweep it.
            $OwnerPid = 0
            $HasOwner = [int]::TryParse($PidText, [ref]$OwnerPid)
            # A .tmp belonging to a live process is a download in flight for a
            # second installer. Locked .bak files just fail to delete, harmlessly.
            if ($Kind -eq "tmp" -and $HasOwner -and
                (Get-Process -Id $OwnerPid -ErrorAction SilentlyContinue)) { return }
            Remove-Item -LiteralPath $_.FullName -Force -ErrorAction SilentlyContinue
        }
}

# Does this one PATH segment name that directory?
#
# Compares whole segments. `-like "*$Dir*"` treated the directory as a wildcard
# pattern and matched substrings, so an unrelated "C:\agav-old" already on PATH
# looked like a hit and suppressed the edit.
#
# Install and uninstall both go through here so the two can never disagree
# about what counts as "already on PATH".
function Test-PathSegment {
    param([Parameter(Mandatory = $true)][AllowEmptyString()][string]$Segment,
          [Parameter(Mandatory = $true)][string]$Needle)

    $Candidate = $Segment.Trim().Trim('"').TrimEnd('\')
    if ($Candidate.Length -eq 0) { return $false }
    if ($Candidate -eq $Needle) { return $true }
    # The stored value may still hold %VARS%; the expanded form is what the
    # shell will actually search.
    try {
        return [Environment]::ExpandEnvironmentVariables($Candidate).TrimEnd('\') -eq $Needle
    } catch {}
    return $false
}

function Test-PathContainsDir {
    param([Parameter(Mandatory = $true)][AllowEmptyString()][string]$PathValue,
          [Parameter(Mandatory = $true)][string]$Dir)

    if ([string]::IsNullOrEmpty($PathValue)) { return $false }
    $Needle = $Dir.TrimEnd('\')
    foreach ($Segment in $PathValue.Split(';')) {
        if (Test-PathSegment -Segment $Segment -Needle $Needle) { return $true }
    }
    return $false
}

# Drop a directory from a PATH value, leaving every other segment byte-for-byte
# alone. Returns $null when nothing matched, so the caller can skip the write.
#
# Uninstalling used to leave the PATH entry behind, pointing at a directory it
# had just deleted.
function Remove-PathSegment {
    param([Parameter(Mandatory = $true)][AllowEmptyString()][string]$PathValue,
          [Parameter(Mandatory = $true)][string]$Dir)

    if ([string]::IsNullOrEmpty($PathValue)) { return $null }
    $Needle = $Dir.TrimEnd('\')
    $Kept = @()
    $Dropped = $false
    foreach ($Segment in $PathValue.Split(';')) {
        if (Test-PathSegment -Segment $Segment -Needle $Needle) { $Dropped = $true }
        else { $Kept += $Segment }
    }
    if (-not $Dropped) { return $null }
    return ($Kept -join ';')
}

# --- Parse flags ---
# Two passes: collect every flag first, then act. Acting inline meant
# `--uninstall --dir=C:\tools` uninstalled from the default directory, because
# --uninstall was reached before --dir had been read.
$DoUninstall = $false
$Purge = $false

foreach ($arg in $args) {
    if ($arg -eq "--uninstall") { $DoUninstall = $true }
    # --purge is useless on its own, so it implies --uninstall.
    if ($arg -eq "--purge") { $DoUninstall = $true; $Purge = $true }
    if ($arg -match "^--version=(.+)$") { $Version = $Matches[1] }
    if ($arg -match "^--dir=(.+)$") { $InstallDir = $Matches[1] }
    if ($arg -eq "--skip-checksum") { $SkipChecksum = $true }
    if ($arg -eq "--beta") { $Beta = $true }
    if ($arg -eq "--help" -or $arg -eq "-h") {
        Write-Host "Usage: install.ps1 [OPTIONS]"
        Write-Host ""
        Write-Host "Options:"
        Write-Host "  --version=<tag>    Install a specific version (default: latest)"
        Write-Host "  --dir=<path>       Install directory (default: %LOCALAPPDATA%\agav)"
        Write-Host "  --skip-checksum    Install without verifying the SHA-256 checksum"
        Write-Host "  --beta             Install the latest pre-release (beta) version"
        Write-Host "  --uninstall        Remove agav, keeping your settings and history"
        Write-Host "  --purge            Remove agav and delete %USERPROFILE%\.agav as well"
        Write-Host "  -h, --help         Show this help"
        Write-Host ""
        Write-Host "Environment:"
        Write-Host "  AGAV_VERSION         Version to install; overridden by --version."
        Write-Host "  AGAV_INSTALL_DIR     Install directory; overridden by --dir."
        Write-Host "  AGAV_SKIP_CHECKSUM   Set to 1/true/yes to skip verification."
        Write-Host "  AGAV_BETA            Set to 1/true/yes to install pre-release; overridden by --beta."
        exit 0
    }
}

if ($DoUninstall) {
    $Target = Join-Path $InstallDir $BinaryName
    $Removed = $false
    $PathChanged = $false
    Remove-StaleArtifacts -Dir $InstallDir -Name $BinaryName

    if (Test-Path -LiteralPath $Target) {
        try {
            Remove-Item -LiteralPath $Target -Force
            $Removed = $true
        } catch {
            # Almost always a running agav holding its own image open.
            Write-Host "Could not remove $Target." -ForegroundColor Red
            Write-Host "Close any running agav sessions and try again." -ForegroundColor Red
            exit 1
        }
    }

    # Same registry-direct read/write as the install path, and for the same
    # reason: the [Environment] API hands back an already-expanded PATH, so
    # writing it back would flatten every %VAR% in the segments we are keeping.
    try {
        $EnvKey = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey("Environment", $true)
        if ($EnvKey) {
            $RawPath = [string]$EnvKey.GetValue(
                "PATH", "", [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
            $Trimmed = Remove-PathSegment -PathValue $RawPath -Dir $InstallDir
            if ($null -ne $Trimmed) {
                $EnvKey.SetValue("PATH", $Trimmed, $EnvKey.GetValueKind("PATH"))
                $Removed = $true
                $PathChanged = $true
            }
            $EnvKey.Close()
        }
    } catch {
        Write-Host "Could not update your PATH: $($_.Exception.Message)" -ForegroundColor Yellow
        Write-Host "Remove $InstallDir from it yourself." -ForegroundColor Yellow
    }

    # Only when we are the ones who left it empty. Never delete a directory the
    # user has put their own files in.
    if ((Test-Path -LiteralPath $InstallDir) -and
        -not (Get-ChildItem -LiteralPath $InstallDir -Force -ErrorAction SilentlyContinue)) {
        Remove-Item -LiteralPath $InstallDir -Force -ErrorAction SilentlyContinue
    }

    # Guarded: USERPROFILE is always set on Windows, but a null here would blow up
    # Join-Path and abort the run with a stack trace after the binary is already
    # gone - a confusing way to end a mostly-successful uninstall.
    $DataDir = if ($env:USERPROFILE) { Join-Path $env:USERPROFILE ".agav" } else { $null }
    $HasData = $DataDir -and (Test-Path -LiteralPath $DataDir)

    # Purge runs before the not-found check on purpose: someone who deleted the
    # exe by hand and then ran --purge to finish the job should get their data
    # directory cleaned up, not "agav not found" with the data still sitting there.
    $Purged = $false
    if ($Purge -and $HasData) {
        Remove-Item -LiteralPath $DataDir -Recurse -Force -ErrorAction SilentlyContinue
        $Purged = $true
        $Removed = $true
    }

    if (-not $Removed) {
        Write-Host "agav not found in $InstallDir" -ForegroundColor Red
        exit 1
    }

    Write-Host "Uninstalled agav from $InstallDir" -ForegroundColor Green
    if ($PathChanged) { Write-Host "Removed $InstallDir from your PATH." -ForegroundColor Green }
    if ($Purged) {
        Write-Host "Removed $DataDir" -ForegroundColor Green
    } elseif ($HasData) {
        Write-Host "Kept your settings and history in $DataDir - delete them with --purge." -ForegroundColor Cyan
    }

    if ($PathChanged) {
        Write-Host "Restart your terminal to drop $InstallDir from PATH." -ForegroundColor Cyan
    }
    exit 0
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

# Detect AVX2 support.  Bun ships two x64 variants: the default build uses
# AVX2 instructions, and a baseline build uses SSE4.2 only.  CPUs without
# AVX2 (and some Intel 12th/13th gen hybrid CPUs whose E-cores lack it)
# crash or misbehave with the AVX2 build.  PF_AVX2_INSTRUCTIONS_AVAILABLE
# is feature index 40 in kernel32 IsProcessorFeaturePresent.
$HasAvx2 = $false
try {
    Add-Type -MemberDefinition `
        '[DllImport("kernel32.dll")] public static extern bool IsProcessorFeaturePresent(int feature);' `
        -Name AgavCpu -Namespace Win32 -ErrorAction Stop
    $HasAvx2 = [Win32.AgavCpu]::IsProcessorFeaturePresent(40)
} catch {}

if ($HasAvx2) {
    $Target = "windows-$Arch"
} else {
    $Target = "windows-$Arch-baseline"
    Write-Host "agav -> AVX2 not detected; installing the baseline build." -ForegroundColor Cyan
}
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

# This has to stay above the pre-release lookup below, not down with the other
# helpers. A script is executed top to bottom, and `function` is a statement
# like any other, so a call placed earlier in the file than the definition hits
# a "term is not recognized" error rather than resolving late. That is exactly
# what --beta and AGAV_BETA=1 did on every Windows install.
function Get-RemoteText {
    param([Parameter(Mandatory = $true)][string]$Url)

    Add-Type -AssemblyName System.Net.Http
    $Handler = New-Object System.Net.Http.HttpClientHandler
    try {
        $Handler.DefaultProxyCredentials = [System.Net.CredentialCache]::DefaultCredentials
    } catch {}
    $Client = New-Object System.Net.Http.HttpClient($Handler)
    $Client.DefaultRequestHeaders.UserAgent.ParseAdd("agav-installer")
    $Response = $null
    try {
        $Response = $Client.GetAsync($Url).GetAwaiter().GetResult()
        $Response.EnsureSuccessStatusCode() | Out-Null
        return $Response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
    } finally {
        if ($Response) { $Response.Dispose() }
        $Client.Dispose()
        $Handler.Dispose()
    }
}

# --- Resolve download URL ---
# Normalize: strip a leading v/V so we can re-add it consistently, matching
# install.sh's normalize_version.  Both `--version=0.3.0` and `--version=v0.3.0`
# now produce the same URL.
if ($Version -ne "latest") {
    $Version = $Version -replace '^[vV]', ''
}

if ($Version -eq "latest") {
    if ($Beta) {
        Write-Host "agav -> Resolving latest pre-release..." -ForegroundColor Cyan
        # /releases returns all releases (including pre-releases) newest-first.
        # Pick the first one, which may be a pre-release.
        try {
            $ReleasesJson = Get-RemoteText "https://api.github.com/repos/$Repo/releases?per_page=1"
            $Tag = [regex]::Match($ReleasesJson, '"tag_name"\s*:\s*"v?([^"]+)"').Groups[1].Value
            if (-not $Tag) { throw "No tag found" }
            $DownloadUrl = "https://github.com/$Repo/releases/download/v$Tag/$AssetName"
            Write-Host "agav -> Resolved: v$Tag" -ForegroundColor Cyan
        } catch {
            Write-Host "Could not resolve latest pre-release: $($_.Exception.Message)" -ForegroundColor Red
            exit 1
        }
    } else {
        $DownloadUrl = "https://github.com/$Repo/releases/latest/download/$AssetName"
    }
} else {
    $DownloadUrl = "https://github.com/$Repo/releases/download/v$Version/$AssetName"
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

# Every release publishes "<asset>.gz" beside the raw binary. It is roughly a
# third of the size, and the raw asset stays published so an installer pinned to
# an older release keeps resolving. gzip rather than a zip: GZipStream has been
# in System.dll since .NET 2.0, so there is nothing to Add-Type and nothing that
# can write outside the file it was handed.
function Expand-GzipFile {
    param(
        [Parameter(Mandatory = $true)][string]$Source,
        [Parameter(Mandatory = $true)][string]$Destination
    )

    $Compressed = $null
    $Gzip = $null
    $Output = $null
    try {
        $Compressed = [System.IO.File]::OpenRead($Source)
        $Gzip = New-Object System.IO.Compression.GZipStream($Compressed, [System.IO.Compression.CompressionMode]::Decompress)
        $Output = [System.IO.File]::Open($Destination, [System.IO.FileMode]::Create)
        $Buffer = New-Object byte[] (1MB)
        while (($Read = $Gzip.Read($Buffer, 0, $Buffer.Length)) -gt 0) {
            $Output.Write($Buffer, 0, $Read)
        }
    } finally {
        if ($Output) { $Output.Dispose() }
        if ($Gzip) { $Gzip.Dispose() }
        if ($Compressed) { $Compressed.Dispose() }
    }
}

if (-not (Test-Path -LiteralPath $InstallDir)) {
    New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
}

Remove-StaleArtifacts -Dir $InstallDir -Name $BinaryName

# Per-process so a leftover from a still-running agav cannot collide with this
# one, and so two installers cannot overwrite each other's partial download.
$TmpFile = Join-Path $InstallDir "$BinaryName.$PID.tmp"
$TmpGzFile = "$TmpFile.gz"
$GotCompressed = $false
try {
    Save-FileWithProgress -Url "$DownloadUrl.gz" -Destination $TmpGzFile -Activity "Downloading $AssetName.gz"
    Expand-GzipFile -Source $TmpGzFile -Destination $TmpFile
    $GotCompressed = $true
} catch {
    Write-Host "agav -> Compressed download unavailable, falling back to the full binary." -ForegroundColor Yellow
} finally {
    if (Test-Path -LiteralPath $TmpGzFile) { Remove-Item -LiteralPath $TmpGzFile -Force -ErrorAction SilentlyContinue }
}

if (-not $GotCompressed) {
    try {
        Save-FileWithProgress -Url $DownloadUrl -Destination $TmpFile -Activity "Downloading $AssetName"
    } catch {
        # Write-Host, not Write-Error: $ErrorActionPreference is Stop, so a
        # Write-Error here would abort the handler before the cleanup below runs.
        Write-Host "Download failed: $($_.Exception.Message)" -ForegroundColor Red
        Write-Host "Check available releases: https://github.com/$Repo/releases" -ForegroundColor Red
        if (Test-Path -LiteralPath $TmpFile) { Remove-Item -LiteralPath $TmpFile -Force }
        exit 1
    }
}

# --- Verify checksum ---
# The other two installers refuse to install an unverified binary; this one used
# to move whatever arrived straight into place. Fail closed here too, since the
# next thing that happens is the user running it.
if ($SkipChecksum) {
    Write-Host "agav -> WARNING: skipping checksum verification." -ForegroundColor Yellow
} else {
    Write-Host "agav -> Verifying checksum..." -ForegroundColor Cyan
    $Expected = $null
    try {
        # Published as "<hex>  <asset>" next to the binary, one file per asset.
        $Expected = ((Get-RemoteText "$DownloadUrl.sha256").Trim() -split '\s+')[0]
    } catch {
        Write-Host "Could not download $DownloadUrl.sha256 - $($_.Exception.Message)" -ForegroundColor Red
    }

    if ($Expected -notmatch '^[0-9a-fA-F]{64}$') {
        Write-Host "No usable SHA-256 checksum was published for $AssetName." -ForegroundColor Red
        Write-Host "Re-run with --skip-checksum to install without verification." -ForegroundColor Red
        Remove-Item -LiteralPath $TmpFile -Force -ErrorAction SilentlyContinue
        exit 1
    }

    $Actual = (Get-FileHash -LiteralPath $TmpFile -Algorithm SHA256).Hash
    if ($Actual -ne $Expected.ToUpperInvariant()) {
        Write-Host "Checksum verification failed - refusing to install." -ForegroundColor Red
        Write-Host "Expected: $($Expected.ToUpperInvariant())" -ForegroundColor Red
        Write-Host "Actual:   $Actual" -ForegroundColor Red
        Remove-Item -LiteralPath $TmpFile -Force -ErrorAction SilentlyContinue
        exit 1
    }
    Write-Host "agav -> Checksum verified." -ForegroundColor Cyan
}

# --- Install ---
# Move-Item -Force onto a running agav.exe fails with a sharing violation:
# Windows will not let the destination be deleted while the image is loaded. It
# will happily *rename* it though, so shift the old binary aside first. That is
# the same dance the in-app updater does.
$BackupPath = "$FinalPath.$PID.bak"
$MovedAside = $false
try {
    if (Test-Path -LiteralPath $FinalPath) {
        Move-Item -LiteralPath $FinalPath -Destination $BackupPath -Force
        $MovedAside = $true
    }
    Move-Item -LiteralPath $TmpFile -Destination $FinalPath -Force
} catch {
    Write-Host "Install failed: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host "Close any running agav sessions and try again." -ForegroundColor Red
    # Put the working binary back rather than leaving the user with nothing.
    if ($MovedAside -and -not (Test-Path -LiteralPath $FinalPath)) {
        Move-Item -LiteralPath $BackupPath -Destination $FinalPath -Force -ErrorAction SilentlyContinue
    }
    Remove-Item -LiteralPath $TmpFile -Force -ErrorAction SilentlyContinue
    exit 1
}

# Best-effort: the old image stays locked for as long as that process lives, so
# a failure here is untidy, not a failed install. The next run sweeps it.
if ($MovedAside) {
    Remove-Item -LiteralPath $BackupPath -Force -ErrorAction SilentlyContinue
}

# --- Verify ---
try {
    $InstalledVer = & $FinalPath --version 2>&1 | Select-String -Pattern '\d+\.\d+\.\d+' | ForEach-Object { $_.Matches[0].Value }
    Write-Host "Agav v$InstalledVer installed to $FinalPath" -ForegroundColor Green
} catch {
    Write-Host "Agav installed to $FinalPath" -ForegroundColor Green
}

# --- PATH check ---
#
# Read and write the registry value directly instead of using
# [Environment]::GetEnvironmentVariable/SetEnvironmentVariable. Get returns the
# *expanded* value, so writing it back stored every %USERPROFILE%-style entry
# as a baked-in absolute path and permanently flattened a REG_EXPAND_SZ PATH.
$RawUserPath = ""
$PathKind = [Microsoft.Win32.RegistryValueKind]::ExpandString
$EnvKey = $null
try {
    $EnvKey = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey("Environment", $true)
    if ($EnvKey) {
        $Existing = $EnvKey.GetValue(
            "PATH", $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
        if ($null -ne $Existing) {
            $RawUserPath = [string]$Existing
            $PathKind = $EnvKey.GetValueKind("PATH")
        }
    }
} catch {
    $EnvKey = $null
}

$AlreadyOnPath = Test-PathContainsDir -PathValue $RawUserPath -Dir $InstallDir
if (-not $AlreadyOnPath -and $EnvKey) {
    $NewPath = if ([string]::IsNullOrEmpty($RawUserPath)) { $InstallDir } else { "$InstallDir;$RawUserPath" }
    try {
        $EnvKey.SetValue("PATH", $NewPath, $PathKind)
        $AlreadyOnPath = $true
        Write-Host ""
        Write-Host "agav -> Added $InstallDir to your PATH." -ForegroundColor Cyan
        Write-Host "agav -> Restart your terminal, then run 'agav' to get started." -ForegroundColor Cyan
    } catch {
        Write-Host ""
        Write-Host "agav -> Could not update your PATH: $($_.Exception.Message)" -ForegroundColor Yellow
        Write-Host "agav -> Add $InstallDir to it yourself, or run agav from $FinalPath." -ForegroundColor Yellow
    }
} else {
    Write-Host ""
    Write-Host "agav -> Run 'agav' to get started." -ForegroundColor Cyan
}
if ($EnvKey) { $EnvKey.Close() }

# The registry write does not reach this already-running shell, and under
# `irm | iex` that shell is the one the user is about to type into.
if (-not (Test-PathContainsDir -PathValue $env:PATH -Dir $InstallDir)) {
    $env:PATH = "$InstallDir;$env:PATH"
}
