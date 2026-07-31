@echo off
setlocal

set "INSTALLER_URL=https://raw.githubusercontent.com/prapaa-ai/agav/main/scripts/install.ps1"
set "TMP_PS1=%TEMP%\agav-install-%RANDOM%-%RANDOM%.ps1"

where powershell.exe >nul 2>nul
if errorlevel 1 (
  echo ERROR: PowerShell is required to install Agav on Windows.
  exit /b 1
)

echo agav ^> Downloading installer...
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$ProgressPreference='SilentlyContinue'; Invoke-WebRequest -Uri '%INSTALLER_URL%' -OutFile '%TMP_PS1%'"
if errorlevel 1 (
  echo ERROR: Failed to download installer from %INSTALLER_URL%
  if exist "%TMP_PS1%" del "%TMP_PS1%" >nul 2>nul
  exit /b 1
)

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%TMP_PS1%" %*
set "EXIT_CODE=%ERRORLEVEL%"

if exist "%TMP_PS1%" del "%TMP_PS1%" >nul 2>nul

exit /b %EXIT_CODE%
