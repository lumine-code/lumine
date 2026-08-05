@echo off

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

IF "%LUMINE_ADD%"=="YES" (
  IF "%LUMINE_NEW_WINDOW%"=="YES" (
    SET EXPECT_OUTPUT=YES
  )
)

IF "%EXPECT_OUTPUT%"=="YES" (
  IF "%WAIT%"=="YES" (
    powershell -noexit "Start-Process -FilePath \"%~dp0\..\%EXE_NAME%.exe\" -ArgumentList \"--pid=$pid $env:PSARGS\" ; wait-event"
    exit 0
  ) ELSE (
    "%~dp0\..\%EXE_NAME%.exe" %*
  )
) ELSE (
  start "" "%~dp0\..\%EXE_NAME%.exe" %*
)
