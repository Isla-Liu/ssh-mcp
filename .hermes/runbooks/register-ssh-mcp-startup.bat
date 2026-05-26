@echo off
setlocal EnableExtensions EnableDelayedExpansion
REM ============================================================================
REM register-ssh-mcp-startup.bat
REM
REM Registers ssh-mcp as a Windows Task Scheduler task that auto-starts in the
REM user's INTERACTIVE LOGON SESSION at logon. Interactive session is mandatory
REM so the spawned in-box ssh.exe can read the user's LSA ticket cache for SSPI
REM Kerberos -- a Windows Service (LocalSystem) cannot, which is why deployment
REM option (b) was rejected. See R1 section 8 and windows-autostart.md.
REM
REM Target task:
REM   /SC ONLOGON   -- fire at every interactive logon for the registering user
REM   /RL HIGHEST   -- run with the user's highest available privileges (lets
REM                    ssh-mcp bind privileged ports if you ever move off 8934)
REM   /IT           -- interactive flag: task runs in the logged-on session, not
REM                    in session 0; this is what keeps the LSA Kerberos ticket
REM                    reachable for the child ssh.exe processes
REM   /F            -- overwrite any existing registration without prompting
REM
REM Launcher target (one of, in priority order):
REM   1. %SSH_MCP_LAUNCHER%                       -- explicit override
REM   2. %~dp0..\McpsLaunch\StandaloneMcpServer.bat -- production default
REM
REM The production default assumes this .bat is placed in a SIBLING directory of
REM the McpsLaunch checkout, e.g.:
REM   D:\Repositories\McpsLaunch\StandaloneMcpServer.bat
REM   D:\Repositories\ssh-mcp-launcher\register-ssh-mcp-startup.bat   <-- here
REM
REM If you keep this .bat inside the ssh-mcp-kerberos repo's .hermes\runbooks\
REM subtree, set SSH_MCP_LAUNCHER explicitly to the absolute path of the .bat
REM wrapper for StandaloneMcpServers.ps1.
REM
REM Idempotent: safe to run repeatedly. If the task already exists it is deleted
REM and re-created so the latest /TR target wins.
REM ============================================================================

set "TASK_NAME=ssh-mcp"

REM ---- Resolve launcher ------------------------------------------------------
if defined SSH_MCP_LAUNCHER (
    set "LAUNCHER=%SSH_MCP_LAUNCHER%"
    echo [info] Using launcher from SSH_MCP_LAUNCHER: !LAUNCHER!
) else (
    set "LAUNCHER=%~dp0..\McpsLaunch\StandaloneMcpServer.bat"
    echo [info] Using default launcher: !LAUNCHER!
)

if not exist "!LAUNCHER!" (
    echo [error] Launcher not found: !LAUNCHER!
    echo [error] Set SSH_MCP_LAUNCHER to the absolute path of the .bat wrapper,
    echo [error] or place this script alongside the McpsLaunch repository.
    exit /b 2
)

REM ---- Idempotency: drop existing registration first -------------------------
schtasks /Query /TN "%TASK_NAME%" >nul 2>&1
if not errorlevel 1 (
    echo [info] Task "%TASK_NAME%" already exists -- deleting before re-create.
    schtasks /Delete /TN "%TASK_NAME%" /F >nul
    if errorlevel 1 (
        echo [error] Failed to delete existing task "%TASK_NAME%".
        exit /b 3
    )
)

REM ---- Register --------------------------------------------------------------
REM Quote the launcher inside the /TR string. The canonical schtasks pattern
REM for an embedded quoted path is /TR "cmd /c \"C:\path with spaces.bat\""
REM -- backslash-quote is how schtasks itself reads a literal quote inside
REM the already-quoted /TR value. cmd /c lets the .bat invoke its own
REM internal pipeline (it spawns the PS1 + mcp-proxy children).
echo [info] Registering Task Scheduler entry "%TASK_NAME%"...
schtasks /Create ^
    /SC ONLOGON ^
    /RL HIGHEST ^
    /TN "%TASK_NAME%" ^
    /TR "cmd /c \"!LAUNCHER!\"" ^
    /IT ^
    /F
if errorlevel 1 (
    echo [error] schtasks /Create failed -- registration aborted.
    exit /b 4
)
echo [ok] Registered.

REM ---- Verification ----------------------------------------------------------
echo.
echo [verify] schtasks /Query for "%TASK_NAME%":
schtasks /Query /TN "%TASK_NAME%" /V /FO LIST | findstr /R /C:"Status" /C:"Run As User" /C:"Schedule Type" /C:"Task To Run" /C:"Logon Mode"
echo.
echo [done] ssh-mcp will auto-start at your next interactive logon.
echo [done] To test now without logging out, run:
echo [done]     schtasks /Run /TN "%TASK_NAME%"
echo [done] To remove this registration:
echo [done]     unregister-ssh-mcp-startup.bat
endlocal
exit /b 0
