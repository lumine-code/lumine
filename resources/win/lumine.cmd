@echo off
REM Keep launcher state out of an interactive caller's environment. Argument
REM parsing belongs to the shared JavaScript launcher, just as it does in the app.
SETLOCAL DisableDelayedExpansion
SET ELECTRON_RUN_AS_NODE=1
"%~dp0..\Lumine.exe" "%~dp0lumine.js" Lumine.exe %*
exit /b %ERRORLEVEL%
