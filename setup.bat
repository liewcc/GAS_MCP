@echo off
setlocal enabledelayedexpansion
title GAS MCP - Setup

set "ROOT=%~dp0"
cd /d "%ROOT%"

echo ============================================================
echo   GAS MCP -- Setup
echo ============================================================

rem -- 1. config.json --
echo.
echo [1/6] Config file...
if not exist "%ROOT%config.json" (
    (
    echo {
    echo   "default_model": "gemini-2.5-flash",
    echo   "active_tab": "api_key",
    echo   "api_keys": [],
    echo   "active_profile": null
    echo }
    ) > "%ROOT%config.json"
    echo   Created default config.json.
) else (
    echo   config.json already exists, leaving it untouched.
)

rem -- 2. Check Python --
echo.
echo [2/6] Checking Python...
python --version >NUL 2>&1
if errorlevel 1 (
    echo Python not found. Install Python 3.10+ from https://python.org
    pause
    exit /b 1
)
for /f "delims=" %%v in ('python --version 2^>^&1') do echo   Found: %%v

rem -- 3. Python venv (MCP server deps) --
echo.
echo [3/6] Python venv (mcp server deps)...
if not exist "%ROOT%.venv" (
    python -m venv "%ROOT%.venv"
)
"%ROOT%.venv\Scripts\python.exe" -m pip install -r "%ROOT%requirements.txt" --quiet
if errorlevel 1 (
    echo pip install failed
    pause
    exit /b 1
)
echo   Done.

rem -- 4. Portable Node.js --
echo.
echo [4/6] Portable Node.js...
set "NODEDIR=%ROOT%.node_venv"
set "NODEURL=https://nodejs.org/dist/v20.11.1/node-v20.11.1-win-x64.zip"
set "NODEZIP=%ROOT%node-portable.zip"

if not exist "%NODEDIR%\node.exe" (
    echo   Downloading Node.js v20.11.1...
    curl -L -A "Mozilla/5.0" -o "%NODEZIP%" "%NODEURL%"
    if errorlevel 1 (
        echo Failed to download Node.js
        pause
        exit /b 1
    )
    if exist "%ROOT%.node_temp" rmdir /s /q "%ROOT%.node_temp"
    mkdir "%ROOT%.node_temp"
    tar -xf "%NODEZIP%" -C "%ROOT%.node_temp"
    if errorlevel 1 (
        echo Failed to extract Node.js
        pause
        exit /b 1
    )
    for /f "delims=" %%d in ('dir /b /ad "%ROOT%.node_temp"') do set "NODEINNER=%%d"
    move "%ROOT%.node_temp\!NODEINNER!" "%NODEDIR%" >NUL
    del /f /q "%NODEZIP%"
    rmdir /s /q "%ROOT%.node_temp"
    echo   Node.js extracted to .node_venv
) else (
    echo   .node_venv already exists, skipping download.
)

set "PATH=%NODEDIR%;%PATH%"
for /f "delims=" %%v in ('"%NODEDIR%\node.exe" --version') do set "NODEVER=%%v"
for /f "delims=" %%v in ('"%NODEDIR%\npm.cmd" --version') do set "NPMVER=%%v"
echo   node !NODEVER!  /  npm !NPMVER!

rem -- 5. npm install (TUI) --
echo.
echo [5/6] npm install (Ink TUI)...
pushd "%ROOT%tui"
call "%NODEDIR%\npm.cmd" install
if errorlevel 1 (
    echo npm install failed
    popd
    pause
    exit /b 1
)
popd
echo   Done.

rem -- 6. Desktop shortcut --
echo.
echo [6/6] Creating desktop shortcut...
cscript //nologo "%ROOT%make_shortcut.vbs"

echo.
echo ============================================================
echo   Setup complete.
echo.
echo   Start TUI:
echo     run.bat
echo ============================================================
pause
