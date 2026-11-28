!macro customCheckAppRunning
  !insertmacro IS_POWERSHELL_AVAILABLE
  ${GetParameters} $R0
  ClearErrors
  ${GetOptions} $R0 "--require-closed" $R1
  ${If} ${Errors}
    !insertmacro _CHECK_APP_RUNNING
  ${Else}
    !insertmacro FIND_PROCESS "${APP_EXECUTABLE_FILENAME}" $R0
    ${If} $R0 != 1 ; 1 means no matching process.
      SetErrorLevel 2
      Quit
    ${EndIf}
  ${EndIf}
!macroend
