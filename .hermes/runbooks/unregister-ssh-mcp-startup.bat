@echo off
setlocal EnableExtensions
REM ============================================================================
REM unregister-ssh-mcp-startup.bat
REM
REM Removes the "ssh-mcp" Task Scheduler entry registered by
REM register-ssh-mcp-startup.bat. Safe to run when the task does not exist --
REM exits 0 either way (idempotent teardown).
REM
REM Does NOT stop the currently running ssh-mcp process (the registration only
REM controls auto-start at next logon). To kill a running instance:
REM   taskkill /F /T /IM node.exe                (if no other Node services)
REM   --or, more surgical, via Get-CimInstance Win32_Process--
REM See .hermes/runbooks/windows-smoke-http-mcp.md section 7.1 "Tear down".
REM ============================================================================

set "TASK_NAME=ssh-mcp"

schtasks /Query /TN "%TASK_NAME%" >nul 2>&1
if errorlevel 1 (
    echo [info] Task "%TASK_NAME%" is not registered -- nothing to remove.
    endlocal
    exit /b 0
)

echo [info] Deleting Task Scheduler entry "%TASK_NAME%"...
schtasks /Delete /TN "%TASK_NAME%" /F
if errorlevel 1 (
    echo [error] schtasks /Delete returned a non-zero exit code.
    endlocal
    exit /b 1
)

echo [ok] Removed. ssh-mcp will no longer auto-start at logon.
echo [info] Any currently running ssh-mcp process is unaffected by this script.
endlocal
exit /b 0
