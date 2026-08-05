@echo off

REM Keep the flags below out of the caller's environment. A batch file invoked
REM from an interactive cmd prompt runs in that same shell, so without SETLOCAL
REM every SET here would linger after the command finishes.
SETLOCAL

SET EXPECT_OUTPUT=
SET WAIT=
SET PSARGS=%*
SET ELECTRON_ENABLE_LOGGING=
SET LUMINE_ADD=
SET LUMINE_CHANNEL=
SET LUMINE_NEW_WINDOW=

FOR %%a IN (%*) DO (
  IF /I "%%a"=="-f"                         SET EXPECT_OUTPUT=YES
  IF /I "%%a"=="--foreground"               SET EXPECT_OUTPUT=YES
  IF /I "%%a"=="-h"                         SET EXPECT_OUTPUT=YES
  IF /I "%%a"=="--help"                     SET EXPECT_OUTPUT=YES
  IF /I "%%a"=="-t"                         SET EXPECT_OUTPUT=YES
  IF /I "%%a"=="--test"                     SET EXPECT_OUTPUT=YES
  IF /I "%%a"=="--benchmark"                SET EXPECT_OUTPUT=YES
  IF /I "%%a"=="--benchmark-test"           SET EXPECT_OUTPUT=YES
  IF /I "%%a"=="-v"                         SET EXPECT_OUTPUT=YES
  IF /I "%%a"=="--version"                  SET EXPECT_OUTPUT=YES
  IF /I "%%a"=="--install"                  SET EXPECT_OUTPUT=YES
  IF /I "%%a"=="--uninstall"                SET EXPECT_OUTPUT=YES
  IF /I "%%a"=="--list"                     SET EXPECT_OUTPUT=YES
  IF /I "%%a"=="--link"                     SET EXPECT_OUTPUT=YES
  IF /I "%%a"=="--unlink"                   SET EXPECT_OUTPUT=YES
  IF /I "%%a"=="--enable-electron-logging"  SET ELECTRON_ENABLE_LOGGING=YES
  IF /I "%%a"=="-a"                         SET LUMINE_ADD=YES
  IF /I "%%a"=="--add"                      SET LUMINE_ADD=YES
  IF /I "%%a"=="-n"                         SET LUMINE_NEW_WINDOW=YES
  IF /I "%%a"=="--new-window"               SET LUMINE_NEW_WINDOW=YES
  IF /I "%%a"=="-w"           (
    SET EXPECT_OUTPUT=YES
    SET WAIT=YES
  )
  IF /I "%%a"=="--wait"       (
    SET EXPECT_OUTPUT=YES
    SET WAIT=YES
  )
)

set EXE_NAME=
set LUMINE_CHANNEL=

set LUMINE_BASE_NAME=%~n0
set LUMINE_CHANNEL=stable
set EXE_NAME=Lumine
set LUMINE_EXECUTABLE=%~dp0..\%EXE_NAME%.exe

REM Every `exit /b` below sits at the top level on purpose. Inside a
REM parenthesized block cmd swallows the code and the script reports 0, so the
REM branches are reached by GOTO rather than by nesting.

REM --add and --new-window contradict each other. The editor prints the error
REM and then exits 0, because a nonzero exit makes `open` fail on macOS, so
REM reporting the failure is the launcher's job on every platform. Run it in
REM the foreground for the message and never fall through to --wait: nothing
REM is opened, so nothing would ever arrive to end the wait.
IF NOT "%LUMINE_ADD%"=="YES"        GOTO :dispatch
IF NOT "%LUMINE_NEW_WINDOW%"=="YES" GOTO :dispatch
"%LUMINE_EXECUTABLE%" %*
exit /b 1

:dispatch
IF NOT "%EXPECT_OUTPUT%"=="YES" GOTO :detached
IF NOT "%WAIT%"=="YES"          GOTO :foreground

REM --wait blocks until the editor is done with the file. The editor kills the
REM pid it is handed, so this PowerShell is here only to be a killable process
REM that blocks; Wait-Event waits on an event that never comes. Exit 64 is a
REM sentinel for "the editor never launched": a killed PowerShell exits 1, so
REM ERRORLEVEL 1 cannot be read as failure here.
powershell -NoProfile -NonInteractive -Command "try { Start-Process -FilePath $env:LUMINE_EXECUTABLE -ArgumentList \"--pid=$PID $env:PSARGS\" -ErrorAction Stop } catch { Write-Error $_.Exception.Message; exit 64 }; Wait-Event"
IF ERRORLEVEL 64 exit /b 1
exit /b 0

:foreground
"%LUMINE_EXECUTABLE%" %*
exit /b %ERRORLEVEL%

:detached
start "" "%LUMINE_EXECUTABLE%" %*
exit /b 0
