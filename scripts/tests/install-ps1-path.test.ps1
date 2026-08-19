# Unit tests for install.ps1's three PATH helpers.
#
# Whatever Remove-PathSegment returns is written straight back to the user's
# PATH, so most of what follows is about collateral damage to segments we do
# not own. Nothing here touches the registry or the filesystem.
#
#   pwsh -NoProfile -File scripts/tests/install-ps1-path.test.ps1
param(
    [string]$Installer = (Join-Path (Join-Path $PSScriptRoot "..") "install.ps1")
)

$ErrorActionPreference = "Stop"

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

# Lift the helpers out of the installer verbatim via the AST, so this tests the
# shipped source rather than a copy that can drift.
$Errors = $null
$Tokens = $null
$Ast = [System.Management.Automation.Language.Parser]::ParseFile($Installer, [ref]$Tokens, [ref]$Errors)
if ($Errors -and $Errors.Count -gt 0) {
    Write-Host "$Installer does not parse:" -ForegroundColor Red
    $Errors | ForEach-Object { Write-Host "  $_" -ForegroundColor Red }
    exit 1
}
foreach ($Name in @("Test-PathSegment", "Test-PathContainsDir", "Remove-PathSegment")) {
    $Fn = $Ast.Find({ param($n)
        $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $Name }, $true)
    if (-not $Fn) { Write-Host "could not find $Name in the source" -ForegroundColor Red; exit 1 }
    Invoke-Expression $Fn.Extent.Text
}

$Dir = "C:\Users\me\AppData\Local\agav"

Write-Host "== positive matches =="
Check "exact segment"        (Test-PathContainsDir -PathValue "C:\Windows;$Dir;C:\Other" -Dir $Dir)
Check "only segment"         (Test-PathContainsDir -PathValue $Dir -Dir $Dir)
Check "trailing backslash"   (Test-PathContainsDir -PathValue "C:\Windows;$Dir\" -Dir $Dir)
Check "quoted segment"       (Test-PathContainsDir -PathValue "C:\Windows;`"$Dir`"" -Dir $Dir)
Check "surrounding spaces"   (Test-PathContainsDir -PathValue "C:\Windows;  $Dir  " -Dir $Dir)
Check "dir given with slash" (Test-PathContainsDir -PathValue "C:\Windows;$Dir" -Dir "$Dir\")

Write-Host "== the actual bug: -notlike wildcard/substring matching =="
# "C:\agav-old" contains "C:\agav" as a substring, so `-notlike "*$InstallDir*"`
# reported the directory as already present and silently skipped the PATH edit.
Check "sibling with a longer name is not a match" `
    (-not (Test-PathContainsDir -PathValue "C:\Windows;C:\agav-old" -Dir "C:\agav"))
Check "parent directory is not a match" `
    (-not (Test-PathContainsDir -PathValue "C:\Windows;C:\Users\me\AppData\Local" -Dir $Dir))
Check "child directory is not a match" `
    (-not (Test-PathContainsDir -PathValue "C:\Windows;$Dir\bin" -Dir $Dir))
# The old code also fed the directory to -like as a *pattern*. A PATH entry with
# a bracket in it made the pattern match nothing, or throw.
Check "a bracket in the dir does not blow up the comparison" `
    (Test-PathContainsDir -PathValue "C:\Windows;C:\tools[x]\agav" -Dir "C:\tools[x]\agav")

Write-Host "== unexpanded REG_EXPAND_SZ entries =="
$env:AGAVTESTHOME = "C:\Users\me"
Check "matches through %VAR% expansion" `
    (Test-PathContainsDir -PathValue "C:\Windows;%AGAVTESTHOME%\bin" -Dir "C:\Users\me\bin")
Check "unrelated %VAR% still does not match" `
    (-not (Test-PathContainsDir -PathValue "C:\Windows;%AGAVTESTHOME%\bin" -Dir "C:\Users\you\bin"))

Write-Host "== degenerate input =="
Check "empty PATH"           (-not (Test-PathContainsDir -PathValue "" -Dir $Dir))
Check "null PATH"            (-not (Test-PathContainsDir -PathValue $null -Dir $Dir))
Check "empty segments only"  (-not (Test-PathContainsDir -PathValue ";;;" -Dir $Dir))
Check "trailing semicolon"   (Test-PathContainsDir -PathValue "$Dir;" -Dir $Dir)

# ---------------------------------------------------------------------------
# Remove-PathSegment: uninstall's half of the same problem. It has to drop our
# segment and leave every other one byte-for-byte alone, because whatever it
# returns is written straight back to the user's PATH.
# ---------------------------------------------------------------------------
Write-Host "== Remove-PathSegment: removal =="
Check "removes from the middle" `
    ((Remove-PathSegment -PathValue "C:\Windows;$Dir;C:\Other" -Dir $Dir) -eq "C:\Windows;C:\Other")
Check "removes from the front" `
    ((Remove-PathSegment -PathValue "$Dir;C:\Windows" -Dir $Dir) -eq "C:\Windows")
Check "removes from the end" `
    ((Remove-PathSegment -PathValue "C:\Windows;$Dir" -Dir $Dir) -eq "C:\Windows")
Check "sole segment leaves an empty PATH" `
    ((Remove-PathSegment -PathValue $Dir -Dir $Dir) -eq "")
Check "removes every duplicate, not just the first" `
    ((Remove-PathSegment -PathValue "$Dir;C:\Windows;$Dir\" -Dir $Dir) -eq "C:\Windows")
Check "removes a quoted segment" `
    ((Remove-PathSegment -PathValue "C:\Windows;`"$Dir`"" -Dir $Dir) -eq "C:\Windows")
Check "removes a %VAR% segment that expands to the dir" `
    ((Remove-PathSegment -PathValue "C:\Windows;%AGAVTESTHOME%\bin" -Dir "C:\Users\me\bin") -eq "C:\Windows")

Write-Host "== Remove-PathSegment: null means 'nothing to write' =="
# Returning $null rather than the unchanged string is what lets the caller skip
# the registry write entirely - and skip claiming it changed the PATH.
Check "no match returns null"       ($null -eq (Remove-PathSegment -PathValue "C:\Windows;C:\Other" -Dir $Dir))
Check "substring near-miss is null" ($null -eq (Remove-PathSegment -PathValue "C:\Windows;C:\agav-old" -Dir "C:\agav"))
Check "child dir is null"           ($null -eq (Remove-PathSegment -PathValue "C:\Windows;$Dir\bin" -Dir $Dir))
Check "empty PATH is null"          ($null -eq (Remove-PathSegment -PathValue "" -Dir $Dir))
Check "null PATH is null"           ($null -eq (Remove-PathSegment -PathValue $null -Dir $Dir))

Write-Host "== Remove-PathSegment: everything else survives untouched =="
# The whole risk of this function is collateral damage to segments we do not own.
$Keep = "%USERPROFILE%\bin;C:\Program Files\Git\cmd;`"C:\Quoted Dir`";C:\tools[x]\bin"
Check "unrelated segments are byte-identical" `
    ((Remove-PathSegment -PathValue "$Keep;$Dir" -Dir $Dir) -eq $Keep) `
    "got: $(Remove-PathSegment -PathValue "$Keep;$Dir" -Dir $Dir)"
Check "%VARS% in kept segments are not expanded" `
    ((Remove-PathSegment -PathValue "%AGAVTESTHOME%\bin;$Dir" -Dir $Dir) -eq "%AGAVTESTHOME%\bin")
Check "empty segments are preserved, not silently compacted" `
    ((Remove-PathSegment -PathValue "C:\Windows;;$Dir" -Dir $Dir) -eq "C:\Windows;")

Write-Host "== install and uninstall agree =="
# If these two ever disagree, install adds a segment uninstall cannot find.
foreach ($Case in @("C:\Windows;$Dir", "$Dir", "C:\Windows;$Dir\", "C:\Windows;  $Dir  ",
                    "C:\Windows;C:\agav-old", "C:\Windows;$Dir\bin", "")) {
    $Contains = Test-PathContainsDir -PathValue $Case -Dir $Dir
    $Removed = $null -ne (Remove-PathSegment -PathValue $Case -Dir $Dir)
    Check "agree on '$Case'" ($Contains -eq $Removed) "contains=$Contains removed=$Removed"
}

$env:AGAVTESTHOME = ""

Write-Host ""
Write-Host "$Pass passed, $Fail failed" -ForegroundColor $(if ($Fail -eq 0) { "Green" } else { "Red" })
exit $(if ($Fail -eq 0) { 0 } else { 1 })
