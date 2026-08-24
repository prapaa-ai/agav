# Exercises install.ps1 end to end against a throwaway directory.
#
# The two functions that touch the network are redefined just before the main
# install flow starts; everything above that point is the shipped file verbatim,
# generated on every run so the stub cannot drift from the source.
#
#   pwsh -NoProfile -File scripts/tests/install-ps1.test.ps1
#   powershell -NoProfile -File scripts\tests\install-ps1.test.ps1
#
# On Windows this really does write HKCU\Environment\PATH, exactly as a user's
# install would. The original value is captured up front and put back in the
# finally block below, whatever happens in between.
param(
    [string]$Installer = (Join-Path (Join-Path $PSScriptRoot "..") "install.ps1")
)

# Continue, not Stop: a failing assertion should print and move on rather than
# take the rest of the suite with it.
$ErrorActionPreference = "Continue"

if (-not (Test-Path -LiteralPath $Installer)) {
    Write-Host "no installer at $Installer" -ForegroundColor Red
    exit 1
}
$Installer = (Resolve-Path -LiteralPath $Installer).Path

$Pass = 0
$Fail = 0
function Check([string]$Name, [bool]$Cond, [string]$Detail = "") {
    if ($Cond) { Write-Host "  PASS  $Name" -ForegroundColor Green; $script:Pass++ }
    else { Write-Host "  FAIL  $Name  $Detail" -ForegroundColor Red; $script:Fail++ }
}

$Root = Join-Path ([System.IO.Path]::GetTempPath()) "agav-ps1-test"
Remove-Item -Recurse -Force $Root -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Path $Root -Force | Out-Null

# --- Build the stub ---------------------------------------------------------
# Insert the fakes immediately before the first line of the install flow, so
# every parse, flag, uninstall and PATH decision above it is the real thing.
$StubBody = @'
# ---- TEST STUBS ----
function Save-FileWithProgress {
    param([string]$Url, [string]$Destination, [string]$Activity)
    if ($env:FAKE_DL_FAIL -eq "1") { throw "simulated 404 for $Url" }
    # The installer asks for "<asset>.gz" first and falls back to the raw asset.
    # FAKE_GZ_FAIL is a release that predates the compressed asset; FAKE_GZ_JUNK
    # is one where the bytes arrive but are not a gzip stream.
    if ($Url.EndsWith(".gz")) {
        if ($env:FAKE_GZ_FAIL -eq "1") { throw "simulated 404 for $Url" }
        if ($env:FAKE_GZ_JUNK -eq "1") {
            Copy-Item -LiteralPath $env:FAKE_ASSET -Destination $Destination -Force
            return (Get-FileHash -LiteralPath $Destination -Algorithm SHA256).Hash
        }
        $Raw = [System.IO.File]::ReadAllBytes($env:FAKE_ASSET)
        $Out = [System.IO.File]::Open($Destination, [System.IO.FileMode]::Create)
        $Gz = New-Object System.IO.Compression.GZipStream($Out, [System.IO.Compression.CompressionMode]::Compress)
        try { $Gz.Write($Raw, 0, $Raw.Length) } finally { $Gz.Dispose(); $Out.Dispose() }
        return (Get-FileHash -LiteralPath $Destination -Algorithm SHA256).Hash
    }
    Copy-Item -LiteralPath $env:FAKE_ASSET -Destination $Destination -Force
    return (Get-FileHash -LiteralPath $Destination -Algorithm SHA256).Hash
}
function Get-RemoteText {
    param([string]$Url)
    if ($env:FAKE_SHA_FAIL -eq "1") { throw "simulated 404 for $Url" }
    return $env:FAKE_SHA_TEXT
}
# ---- END TEST STUBS ----
'@

$Anchor = 'if (-not (Test-Path -LiteralPath $InstallDir)) {'
$Lines = @(Get-Content -LiteralPath $Installer)
$Index = -1
for ($i = 0; $i -lt $Lines.Count; $i++) {
    if ($Lines[$i] -eq $Anchor) { $Index = $i; break }
}
if ($Index -lt 0) {
    Write-Host "could not find the install-flow anchor in $Installer" -ForegroundColor Red
    Write-Host "looked for: $Anchor" -ForegroundColor Red
    exit 1
}
$Script = Join-Path $Root "install-stub.ps1"
Set-Content -LiteralPath $Script -Encoding ASCII -Value (
    @($Lines[0..($Index - 1)]) + ($StubBody -split "\r?\n") + @("") + @($Lines[$Index..($Lines.Count - 1)])
)

# --- Fake release asset, and its real digest --------------------------------
$Asset = Join-Path $Root "asset.bin"
Set-Content -LiteralPath $Asset -Value "I am the agav binary" -NoNewline
$Digest = (Get-FileHash -LiteralPath $Asset -Algorithm SHA256).Hash
$env:FAKE_ASSET = $Asset

# Re-invoke whichever host is running this suite, so the same file is exercised
# under Windows PowerShell 5.1 and pwsh without a second copy of the harness.
$PSExe = (Get-Process -Id $PID).Path
if (-not $PSExe) { $PSExe = "pwsh" }

# Quote one argument for the -Command line below.
function ConvertTo-Quoted([string]$Value) { "'" + ($Value -replace "'", "''") + "'" }

# -Command, not -File. pwsh's -File parser reads `--dir=C:\tools` as a
# `-name:value` pair and splits it at the colon, so the script sees `--dir=C`
# and a stray `\tools`; Windows PowerShell 5.1 does not. Neither is how anyone
# invokes this - install.cmd uses `powershell.exe -File`, and the documented
# one-liner is `& ([scriptblock]::Create((irm ...))) --dir=...`, which binds
# arguments the way -Command does here.
function Invoke-Script([string[]]$Arguments = @()) {
    $Line = "& $(ConvertTo-Quoted $Script)"
    foreach ($Arg in $Arguments) { $Line += " $(ConvertTo-Quoted $Arg)" }
    $out = & $PSExe -NoProfile -Command $Line 2>&1 | Out-String
    return [pscustomobject]@{ Code = $LASTEXITCODE; Out = $out }
}

function Invoke-Install([string]$Dir, [string[]]$Arguments = @()) {
    $env:AGAV_INSTALL_DIR = $Dir
    return Invoke-Script $Arguments
}

# --- State this suite is allowed to change, and must put back ---------------
$SavedUserProfile = $env:USERPROFILE
$SavedInstallDir = $env:AGAV_INSTALL_DIR
$SavedSkip = $env:AGAV_SKIP_CHECKSUM
$SavedRegPath = $null
$SavedRegKind = $null
$HaveRegistry = $false
try {
    $Key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey("Environment", $false)
    if ($Key) {
        $SavedRegPath = $Key.GetValue(
            "PATH", $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
        if ($null -ne $SavedRegPath) { $SavedRegKind = $Key.GetValueKind("PATH") }
        $Key.Close()
        $HaveRegistry = $true
    }
} catch {
    # Not Windows, or no access. The installer tolerates both, and so does this.
}

function Restore-State {
    $env:USERPROFILE = $script:SavedUserProfile
    $env:AGAV_INSTALL_DIR = $script:SavedInstallDir
    $env:AGAV_SKIP_CHECKSUM = $script:SavedSkip
    $env:FAKE_ASSET = ""
    $env:FAKE_SHA_TEXT = ""
    $env:FAKE_SHA_FAIL = ""
    $env:FAKE_DL_FAIL = ""
    $env:FAKE_GZ_FAIL = ""
    $env:FAKE_GZ_JUNK = ""
    if (-not $script:HaveRegistry) { return }
    try {
        $Key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey("Environment", $true)
        if (-not $Key) { return }
        if ($null -eq $script:SavedRegPath) { $Key.DeleteValue("PATH", $false) }
        else { $Key.SetValue("PATH", $script:SavedRegPath, $script:SavedRegKind) }
        $Key.Close()
    } catch {
        Write-Host "WARNING: could not restore your user PATH: $($_.Exception.Message)" -ForegroundColor Yellow
    }
}

function Invoke-Suite {

Write-Host "== `$Matches populated by -notmatch when the pattern DOES match =="
$n = "agav.exe.1234.bak"
if ($n -notmatch "^agav\.exe\.(\d+)\.(bak|tmp)$") { Check "unreachable" $false }
else { Check "-notmatch still fills `$Matches" ($Matches[1] -eq "1234" -and $Matches[2] -eq "bak") "got $($Matches | Out-String)" }

Write-Host "== --help =="
$r = Invoke-Install "$Root/help" @("--help")
Check "--help exits 0" ($r.Code -eq 0) "code=$($r.Code)"
Check "--help documents --skip-checksum" ($r.Out -match "--skip-checksum")
Check "--help does not install" (-not (Test-Path "$Root/help"))

Write-Host "== happy path =="
$env:FAKE_SHA_TEXT = "$Digest  agav-windows-x64.exe"
$env:FAKE_SHA_FAIL = "0"; $env:FAKE_DL_FAIL = "0"
$env:FAKE_GZ_FAIL = "0"; $env:FAKE_GZ_JUNK = "0"
$d = "$Root/ok"
$r = Invoke-Install $d
Check "install exits 0" ($r.Code -eq 0) "code=$($r.Code) out=$($r.Out)"
Check "binary landed" (Test-Path "$d/agav.exe")
Check "content matches asset" ((Get-Content -Raw "$d/agav.exe") -eq (Get-Content -Raw $Asset))
Check "reports checksum verified" ($r.Out -match "Checksum verified")
Check "no .tmp left" (@(Get-ChildItem $d -Filter "*.tmp" -EA SilentlyContinue).Count -eq 0)
Check "no .bak left" (@(Get-ChildItem $d -Filter "*.bak" -EA SilentlyContinue).Count -eq 0)
Check "no .gz left" (@(Get-ChildItem $d -Filter "*.gz" -EA SilentlyContinue).Count -eq 0)
# The compressed asset is roughly a third of the download, so preferring it is
# the whole point; falling back silently would look identical from out here.
Check "took the compressed asset" ($r.Out -notmatch "falling back to the full binary") "out=$($r.Out)"

Write-Host "== a release with no compressed asset =="
# Anything published before .gz existed, and any partial upload since.
$env:FAKE_GZ_FAIL = "1"
$d = "$Root/nogz"
$r = Invoke-Install $d
Check "no-gz install exits 0" ($r.Code -eq 0) "code=$($r.Code) out=$($r.Out)"
Check "no-gz binary landed" (Test-Path "$d/agav.exe")
Check "no-gz content matches asset" ((Get-Content -Raw "$d/agav.exe") -eq (Get-Content -Raw $Asset))
Check "no-gz says it fell back" ($r.Out -match "falling back to the full binary")
Check "no-gz leaves no .gz" (@(Get-ChildItem $d -Filter "*.gz" -EA SilentlyContinue).Count -eq 0)
$env:FAKE_GZ_FAIL = "0"

Write-Host "== a .gz that is not actually gzip =="
$env:FAKE_GZ_JUNK = "1"
$d = "$Root/junkgz"
$r = Invoke-Install $d
Check "junk-gz install exits 0" ($r.Code -eq 0) "code=$($r.Code) out=$($r.Out)"
Check "junk-gz installs the raw asset instead" ((Get-Content -Raw "$d/agav.exe") -eq (Get-Content -Raw $Asset))
Check "junk-gz leaves no .gz" (@(Get-ChildItem $d -Filter "*.gz" -EA SilentlyContinue).Count -eq 0)
$env:FAKE_GZ_JUNK = "0"

Write-Host "== upgrade over an existing install (rename-aside) =="
Set-Content -LiteralPath "$d/agav.exe" -Value "OLD" -NoNewline
$r = Invoke-Install $d
Check "upgrade exits 0" ($r.Code -eq 0) "code=$($r.Code) out=$($r.Out)"
Check "old binary replaced" ((Get-Content -Raw "$d/agav.exe") -eq (Get-Content -Raw $Asset))
Check "backup cleaned up" (@(Get-ChildItem $d -Filter "*.bak" -EA SilentlyContinue).Count -eq 0)

Write-Host "== checksum mismatch =="
$env:FAKE_SHA_TEXT = ("a" * 64) + "  agav-windows-x64.exe"
$d = "$Root/mismatch"
$r = Invoke-Install $d
Check "mismatch exits 1" ($r.Code -eq 1) "code=$($r.Code)"
Check "mismatch installs nothing" (-not (Test-Path "$d/agav.exe"))
Check "mismatch leaves no .tmp" (@(Get-ChildItem $d -Filter "*.tmp" -EA SilentlyContinue).Count -eq 0)
Check "mismatch does NOT advertise the bypass" ($r.Out -notmatch "skip-checksum")

Write-Host "== checksum fetch 404 =="
$env:FAKE_SHA_FAIL = "1"
$d = "$Root/sha404"
$r = Invoke-Install $d
Check "sha 404 exits 1" ($r.Code -eq 1) "code=$($r.Code)"
Check "sha 404 installs nothing" (-not (Test-Path "$d/agav.exe"))
Check "sha 404 leaves no .tmp" (@(Get-ChildItem $d -Filter "*.tmp" -EA SilentlyContinue).Count -eq 0)
Check "sha 404 suggests the bypass" ($r.Out -match "skip-checksum")

Write-Host "== garbage checksum body =="
$env:FAKE_SHA_FAIL = "0"; $env:FAKE_SHA_TEXT = "<html>404 not found</html>"
$d = "$Root/garbage"
$r = Invoke-Install $d
Check "garbage checksum exits 1" ($r.Code -eq 1) "code=$($r.Code)"
Check "garbage checksum installs nothing" (-not (Test-Path "$d/agav.exe"))

Write-Host "== --skip-checksum =="
$env:FAKE_SHA_FAIL = "1"
$d = "$Root/skip"
$r = Invoke-Install $d @("--skip-checksum")
Check "--skip-checksum exits 0" ($r.Code -eq 0) "code=$($r.Code) out=$($r.Out)"
Check "--skip-checksum installs" (Test-Path "$d/agav.exe")
Check "--skip-checksum warns" ($r.Out -match "skipping checksum")

Write-Host "== AGAV_SKIP_CHECKSUM env =="
$env:AGAV_SKIP_CHECKSUM = "true"
$d = "$Root/skipenv"
$r = Invoke-Install $d
Check "AGAV_SKIP_CHECKSUM=true installs" (Test-Path "$d/agav.exe") "code=$($r.Code) out=$($r.Out)"
$env:AGAV_SKIP_CHECKSUM = ""

Write-Host "== download failure =="
$env:FAKE_DL_FAIL = "1"; $env:FAKE_SHA_FAIL = "0"; $env:FAKE_SHA_TEXT = "$Digest  agav-windows-x64.exe"
$d = "$Root/dlfail"
$r = Invoke-Install $d
Check "download failure exits 1" ($r.Code -eq 1) "code=$($r.Code)"
Check "download failure installs nothing" (-not (Test-Path "$d/agav.exe"))
$env:FAKE_DL_FAIL = "0"

Write-Host "== stale artifact sweep =="
$d = "$Root/stale"
New-Item -ItemType Directory -Path $d -Force | Out-Null
Set-Content "$d/agav.exe.9999999.bak" "dead pid backup" -NoNewline
Set-Content "$d/agav.exe.9999998.tmp" "dead pid download" -NoNewline
Set-Content "$d/agav.exe.9999997.tmp.gz" "dead pid compressed download" -NoNewline
Set-Content "$d/agav.exe.tmp" "legacy download" -NoNewline
Set-Content "$d/agav.exe.$PID.tmp" "LIVE download" -NoNewline
Set-Content "$d/notes.txt" "keep me" -NoNewline
$r = Invoke-Install $d
Check "sweep exits 0" ($r.Code -eq 0) "code=$($r.Code) out=$($r.Out)"
Check "dead-pid .bak swept" (-not (Test-Path "$d/agav.exe.9999999.bak"))
Check "dead-pid .tmp swept" (-not (Test-Path "$d/agav.exe.9999998.tmp"))
# An interrupted install leaves ~25MB of compressed download behind, which the
# sweep missed entirely while it only knew about .tmp and .bak.
Check "dead-pid .tmp.gz swept" (-not (Test-Path "$d/agav.exe.9999997.tmp.gz"))
Check "legacy .tmp swept" (-not (Test-Path "$d/agav.exe.tmp"))
Check "LIVE .tmp spared" (Test-Path "$d/agav.exe.$PID.tmp")
Check "unrelated file spared" (Test-Path "$d/notes.txt")

Write-Host "== a leftover with an absurd pid does not abort the install =="
# \d+ matches a number too big for an Int32, and the cast threw under
# $ErrorActionPreference = "Stop" - taking the whole installer down from inside
# the routine that exists to tolerate junk.
$d = "$Root/bigpid"
New-Item -ItemType Directory -Path $d -Force | Out-Null
Set-Content "$d/agav.exe.99999999999.bak" "absurd pid" -NoNewline
Set-Content "$d/agav.exe.99999999999.tmp" "absurd pid" -NoNewline
Set-Content "$d/agav.exe.0000$PID.tmp" "live pid, zero padded" -NoNewline
$r = Invoke-Install $d
Check "install still exits 0" ($r.Code -eq 0) "code=$($r.Code) out=$($r.Out)"
Check "binary installed" (Test-Path "$d/agav.exe")
Check "unparseable-pid .bak swept" (-not (Test-Path "$d/agav.exe.99999999999.bak"))
Check "unparseable-pid .tmp swept" (-not (Test-Path "$d/agav.exe.99999999999.tmp"))
Check "zero-padded live pid still spared" (Test-Path "$d/agav.exe.0000$PID.tmp")

Write-Host "== uninstall =="
$d = "$Root/ok"
$r = Invoke-Install $d @("--uninstall")
Check "uninstall exits 0" ($r.Code -eq 0) "code=$($r.Code) out=$($r.Out)"
Check "uninstall removes the binary" (-not (Test-Path "$d/agav.exe"))
$r = Invoke-Install $d @("--uninstall")
Check "uninstall of nothing exits 1" ($r.Code -eq 1) "code=$($r.Code)"

Write-Host "== uninstall sweeps stale artifacts and the empty dir =="
$d = "$Root/unstale"
New-Item -ItemType Directory -Path $d -Force | Out-Null
Set-Content "$d/agav.exe" "binary" -NoNewline
Set-Content "$d/agav.exe.9999999.bak" "dead pid backup" -NoNewline
$r = Invoke-Install $d @("--uninstall")
Check "uninstall exits 0" ($r.Code -eq 0) "code=$($r.Code) out=$($r.Out)"
Check "uninstall swept the stale .bak" (-not (Test-Path "$d/agav.exe.9999999.bak"))
Check "uninstall removed the now-empty dir" (-not (Test-Path $d))

Write-Host "== uninstall never deletes a dir holding the user's own files =="
$d = "$Root/unkeep"
New-Item -ItemType Directory -Path $d -Force | Out-Null
Set-Content "$d/agav.exe" "binary" -NoNewline
Set-Content "$d/notes.txt" "keep me" -NoNewline
$r = Invoke-Install $d @("--uninstall")
Check "binary removed" (-not (Test-Path "$d/agav.exe")) "out=$($r.Out)"
Check "non-empty dir spared" (Test-Path $d)
Check "unrelated file spared" (Test-Path "$d/notes.txt")

# From here on the data directory is real and gets deleted, so point the child
# processes at a fake home first.
$env:USERPROFILE = "$Root/home"
$DataDir = Join-Path $env:USERPROFILE ".agav"
# The one thing in this suite that destroys data. If $Root were ever
# misconfigured this would be the user's real ~/.agav, so refuse outright
# rather than trust the assignment above.
if ($DataDir -notlike "$Root*") {
    throw "refusing to run the purge tests: $DataDir is outside $Root"
}

function New-DataDir {
    Remove-Item -Recurse -Force $DataDir -ErrorAction SilentlyContinue
    New-Item -ItemType Directory -Path $DataDir -Force | Out-Null
    Set-Content "$DataDir/settings.json" '{"keep":true}' -NoNewline
}

Write-Host "== plain --uninstall keeps the data directory =="
$d = "$Root/keepdata"
New-Item -ItemType Directory -Path $d -Force | Out-Null
Set-Content "$d/agav.exe" "binary" -NoNewline
New-DataDir
$r = Invoke-Install $d @("--uninstall")
Check "exits 0" ($r.Code -eq 0) "code=$($r.Code) out=$($r.Out)"
Check "settings survive" (Test-Path "$DataDir/settings.json")
Check "says what it kept, and how to remove it" `
    ($r.Out -match "Kept your settings" -and $r.Out -match "--purge") "out=$($r.Out)"

Write-Host "== --purge removes the data directory =="
$d = "$Root/purge"
New-Item -ItemType Directory -Path $d -Force | Out-Null
Set-Content "$d/agav.exe" "binary" -NoNewline
New-DataDir
$r = Invoke-Install $d @("--purge")
Check "exits 0" ($r.Code -eq 0) "code=$($r.Code) out=$($r.Out)"
Check "--purge implies --uninstall: binary gone" (-not (Test-Path "$d/agav.exe"))
Check "data directory gone" (-not (Test-Path $DataDir))
Check "reports the removal" ($r.Out -match "Removed .*\.agav") "out=$($r.Out)"
Check "does not also claim it kept anything" ($r.Out -notmatch "Kept your settings")

Write-Host "== --purge after the binary was already removed by hand =="
# The point of --purge is the data directory. Bailing out with "not found"
# because the exe is already gone would leave the data behind for good.
$d = "$Root/purgeonly"
New-Item -ItemType Directory -Path $d -Force | Out-Null
New-DataDir
$r = Invoke-Install $d @("--purge")
Check "exits 0" ($r.Code -eq 0) "code=$($r.Code) out=$($r.Out)"
Check "data directory gone" (-not (Test-Path $DataDir))

Write-Host "== nothing to do at all still fails =="
$d = "$Root/nothing"
Remove-Item -Recurse -Force $DataDir -ErrorAction SilentlyContinue
$r = Invoke-Install $d @("--purge")
Check "exits 1" ($r.Code -eq 1) "code=$($r.Code) out=$($r.Out)"
Check "says not found" ($r.Out -match "not found")

Write-Host "== --help documents --purge =="
$r = Invoke-Install "$Root/help2" @("--help")
Check "--help lists --purge" ($r.Out -match "--purge")
Check "--help says plain uninstall keeps your data" ($r.Out -match "keeping your settings")

Write-Host "== --uninstall --dir=X honours --dir (two-pass parsing) =="
$env:AGAV_INSTALL_DIR = "$Root/default"
New-Item -ItemType Directory -Path "$Root/default" -Force | Out-Null
Set-Content "$Root/default/agav.exe" "default install" -NoNewline
New-Item -ItemType Directory -Path "$Root/explicit" -Force | Out-Null
Set-Content "$Root/explicit/agav.exe" "explicit install" -NoNewline
$r = Invoke-Script @("--uninstall", "--dir=$Root/explicit")
Check "removed the --dir target" (-not (Test-Path "$Root/explicit/agav.exe")) $r.Out
Check "left the default target alone" (Test-Path "$Root/default/agav.exe")

Write-Host "== --dir= wins over AGAV_INSTALL_DIR on install =="
$env:AGAV_INSTALL_DIR = "$Root/envdir"
$r = Invoke-Script @("--dir=$Root/flagdir")
Check "installed to --dir" (Test-Path "$Root/flagdir/agav.exe") $r.Out
Check "did not install to env dir" (-not (Test-Path "$Root/envdir/agav.exe"))

}

try {
    Invoke-Suite
} finally {
    Restore-State
    Remove-Item -Recurse -Force $Root -ErrorAction SilentlyContinue
}

Write-Host ""
Write-Host "$Pass passed, $Fail failed" -ForegroundColor $(if ($Fail -eq 0) { "Green" } else { "Red" })
exit $(if ($Fail -eq 0) { 0 } else { 1 })
