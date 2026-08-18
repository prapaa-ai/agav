@echo off
setlocal

rem Fetch from the release host rather than a raw git branch. Pulling from a
rem branch meant cmd users always ran whatever was on main instead of the
rem installer that shipped with a release, so an unrelated commit could break
rem this path instantly. Set AGAV_INSTALLER_URL to override.
rem The www host is deliberate: the apex answers with a 308 and Windows
rem PowerShell 5.1 cannot follow that status.
if not defined AGAV_INSTALLER_URL set "AGAV_INSTALLER_URL=https://www.agav.dev/install.ps1"
set "INSTALLER_URL=%AGAV_INSTALLER_URL%"
set "TMP_PS1=%TEMP%\agav-install-%RANDOM%-%RANDOM%.ps1"

where powershell.exe >nul 2>nul
if errorlevel 1 (
  echo ERROR: PowerShell is required to install Agav on Windows.
  exit /b 1
)

echo agav ^> Downloading installer...
rem -UseBasicParsing keeps this off the Internet Explorer engine, which is
rem absent on Server Core and unconfigured on a fresh profile. Tls12 is forced
rem because .NET below 4.7 negotiates TLS 1.0 and github.com rejects it.
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch {}; Invoke-WebRequest -UseBasicParsing -Uri '%INSTALLER_URL%' -OutFile '%TMP_PS1%'"
if errorlevel 1 (
  echo ERROR: Failed to download installer from %INSTALLER_URL%
  if exist "%TMP_PS1%" del "%TMP_PS1%" >nul 2>nul
  exit /b 1
)

rem A proxy or captive portal can answer 200 with an error page; a truncated or
rem empty script would otherwise be handed straight to PowerShell.
for %%A in ("%TMP_PS1%") do if %%~zA LSS 1000 (
  echo ERROR: Downloaded installer looks invalid ^(%%~zA bytes^).
  if exist "%TMP_PS1%" del "%TMP_PS1%" >nul 2>nul
  exit /b 1
)

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%TMP_PS1%" %*
set "EXIT_CODE=%ERRORLEVEL%"

if exist "%TMP_PS1%" del "%TMP_PS1%" >nul 2>nul

exit /b %EXIT_CODE%
