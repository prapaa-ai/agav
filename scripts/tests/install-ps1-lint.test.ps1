# Static checks on install.ps1: it parses, it is pure ASCII, and PSScriptAnalyzer
# has nothing to say about it - including under Windows PowerShell 5.1, which is
# the host `install.cmd` actually launches it with.
#
#   pwsh -NoProfile -File scripts/tests/install-ps1-lint.test.ps1
param(
    [string]$Installer = (Join-Path (Join-Path $PSScriptRoot "..") "install.ps1")
)

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

Write-Host "== it parses =="
$Errors = $null
$Tokens = $null
$Ast = [System.Management.Automation.Language.Parser]::ParseFile($Installer, [ref]$Tokens, [ref]$Errors)
Check "no parse errors" (-not $Errors -or $Errors.Count -eq 0) ($Errors | Out-String)

Write-Host "== every function is defined above its first top-level call =="
# A script runs top to bottom and `function` is a statement like any other, so a
# call written above the definition fails with "term is not recognized" instead
# of resolving late. --beta shipped broken on Windows for exactly this: the
# pre-release lookup called Get-RemoteText 130 lines before it existed, and
# nothing here noticed because the failure needs a flag and a network call to
# reach. A call from inside another function body is fine - that one resolves
# when the enclosing function is invoked, not where it is written.
$Defs = @{}
foreach ($Fn in $Ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $true)) {
    if (-not $Defs.ContainsKey($Fn.Name)) { $Defs[$Fn.Name] = $Fn.Extent.EndOffset }
}
$Early = @()
foreach ($Cmd in $Ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.CommandAst] }, $true)) {
    $Name = $Cmd.GetCommandName()
    if (-not $Name -or -not $Defs.ContainsKey($Name)) { continue }
    $Enclosing = $Cmd.Parent
    while ($Enclosing -and -not ($Enclosing -is [System.Management.Automation.Language.FunctionDefinitionAst])) {
        $Enclosing = $Enclosing.Parent
    }
    if (-not $Enclosing -and $Cmd.Extent.StartOffset -lt $Defs[$Name]) {
        $Early += "$Name called at line $($Cmd.Extent.StartLineNumber) but defined below it"
    }
}
Check "no function is called before it is defined" ($Early.Count -eq 0) ($Early -join "; ")

Write-Host "== it is pure ASCII =="
# install.cmd fetches this with Invoke-WebRequest, which writes raw bytes, and
# Windows PowerShell 5.1 decodes a BOM-less -File script as Windows-1252. A
# UTF-8 character whose trailing byte is 0x93/0x94 becomes a smart quote, which
# the parser accepts as a string delimiter, and the whole script fails to parse.
$Bytes = [System.IO.File]::ReadAllBytes($Installer)
$HighByte = -1
for ($i = 0; $i -lt $Bytes.Length; $i++) {
    if ($Bytes[$i] -ge 0x80) { $HighByte = $i; break }
}
Check "no bytes above 0x7F" ($HighByte -lt 0) "first at offset $HighByte"
Check "no UTF-8 BOM" (-not ($Bytes.Length -ge 3 -and $Bytes[0] -eq 0xEF -and $Bytes[1] -eq 0xBB -and $Bytes[2] -eq 0xBF))

Write-Host "== PSScriptAnalyzer =="
$Analyzer = Get-Module -ListAvailable -Name PSScriptAnalyzer | Select-Object -First 1
if (-not $Analyzer) {
    Write-Host "  installing PSScriptAnalyzer from PSGallery..." -ForegroundColor Cyan
    try {
        # PowerShellGet under Windows PowerShell 5.1 still negotiates TLS 1.0 by
        # default, which PSGallery refuses outright.
        try {
            [Net.ServicePointManager]::SecurityProtocol =
                [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
        } catch {}
        Set-PSRepository -Name PSGallery -InstallationPolicy Trusted -ErrorAction SilentlyContinue
        Install-Module -Name PSScriptAnalyzer -Force -Scope CurrentUser -AllowClobber -ErrorAction Stop
        $Analyzer = Get-Module -ListAvailable -Name PSScriptAnalyzer | Select-Object -First 1
    } catch {
        Write-Host "  SKIP  PSScriptAnalyzer unavailable: $($_.Exception.Message)" -ForegroundColor Yellow
    }
}

if ($Analyzer) {
    Import-Module PSScriptAnalyzer

    # Four rules are written for modules and are wrong for a one-shot installer:
    #
    #   PSAvoidUsingWriteHost   - Write-Host is the point. This script's output is
    #                             for a person watching a terminal, and it must
    #                             survive `irm | iex`, where the pipeline belongs
    #                             to the caller.
    #   PSAvoidUsingEmptyCatchBlock - every one is a deliberate best-effort probe
    #                             (TLS 1.2, proxy credentials, --version).
    #   PSUseShouldProcessForStateChangingFunctions and PSUseSingularNouns - both
    #                             about the contract an exported cmdlet owes its
    #                             callers. These are script-local helpers.
    $Ignored = @(
        "PSAvoidUsingWriteHost",
        "PSAvoidUsingEmptyCatchBlock",
        "PSUseShouldProcessForStateChangingFunctions",
        "PSUseSingularNouns"
    )
    $General = @(Invoke-ScriptAnalyzer -Path $Installer -Severity Error, Warning -ExcludeRule $Ignored)
    if ($General.Count -gt 0) {
        $General | Format-Table -AutoSize Severity, RuleName, Line, Message | Out-String -Width 200 | Write-Host
    }
    Check "no errors or warnings" ($General.Count -eq 0) "$($General.Count) finding(s)"

    # 5.1 is what install.cmd launches, and the 14393 cmdlet set is the oldest
    # still-supported Windows 10 servicing baseline. IncludeRules keeps this to
    # the compatibility question alone - without it the default rule set runs too
    # and this second pass just repeats the first.
    $Settings = @{
        IncludeRules = @("PSUseCompatibleSyntax", "PSUseCompatibleCmdlets")
        Rules = @{
            PSUseCompatibleSyntax  = @{ Enable = $true; TargetVersions = @("5.1", "7.0") }
            PSUseCompatibleCmdlets = @{ Enable = $true; compatibility = @("desktop-5.1.14393.206-windows") }
        }
    }
    $Compat = @(Invoke-ScriptAnalyzer -Path $Installer -Settings $Settings)
    if ($Compat.Count -gt 0) {
        $Compat | Format-Table -AutoSize Severity, RuleName, Line, Message | Out-String -Width 200 | Write-Host
    }
    Check "compatible with Windows PowerShell 5.1 and pwsh 7" ($Compat.Count -eq 0) "$($Compat.Count) finding(s)"
}

Write-Host ""
Write-Host "$Pass passed, $Fail failed" -ForegroundColor $(if ($Fail -eq 0) { "Green" } else { "Red" })
exit $(if ($Fail -eq 0) { 0 } else { 1 })
