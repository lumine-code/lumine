!include "${BUILD_RESOURCES_DIR}\..\resources\win\EnvVarUpdate.nsh" ; Relative to 'build\'
!include "${BUILD_RESOURCES_DIR}\..\resources\win\GetWindowsVersion.nsh"
!include nsDialogs.nsh
!include "${BUILD_RESOURCES_DIR}\..\resources\win\installer-art.nsh"
XPStyle on

!macro customInit ; Macro called by electron-builder; inserted at start of .OnInit callback
  ; Check the current windows version
  ${GetWindowsVersion} $R0

  ${Switch} $R0
    ${Case} '10.0' ; Support Windows 10
    ${Case} '' ; Support Windows versions unknown to GetWindowsVersion v4.1.1 (Win11)
      ${Break} ; Do nothing if supported version.
    ${Default}
      MessageBox MB_OK "Lumine requires Windows 10 or later."
      Quit
      ${Break}
  ${EndSwitch}
!macroend

!macro customInstall ; Macro called by electron-builder
  ; Set the 'InstallLocation' Registry Key for Lumine
  WriteRegStr SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" "InstallLocation" "$INSTDIR"
!macroend

; Match the literal command written by src/win-shell.js before removing a key.
; An empty command is a broken registration; another installation's valid
; command must survive this uninstall. Never remove entries during an update.
!macro RemoveLumineShellEntry ROOT_KEY COMMAND_SUBKEY ARG
  ClearErrors
  ReadRegStr $0 HKCU "${ROOT_KEY}\${COMMAND_SUBKEY}" ""
  ${if} $0 == ""
  ${orIf} $0 == '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "${ARG}"'
    DeleteRegKey HKCU "${ROOT_KEY}"
  ${endIf}
  ClearErrors
!macroend

!macro customUnInstall ; Macro called by electron-builder
  ; Since adding the PATH occurs during installation, we want to ensure to remove it.
  ; Luckily 'EnvVarUpdate' handles the case of it not being present
  ${ifNot} ${isUpdated}
    ; Only run uninstall steps if truly uninstalling. Prevents this step from
    ; running during an upgrade, where it technically runs after the upgrade's
    ; install steps, ultimately removing Lumine from the PATH
    ${un.EnvVarUpdate} $0 "PATH" "R" "HKCU" "$INSTDIR\resources"

    ; Key names and command placeholders must match src/win-shell.js.
    !insertmacro RemoveLumineShellEntry "Software\Classes\*\shell\${PRODUCT_NAME}" "command" "%1"
    !insertmacro RemoveLumineShellEntry "Software\Classes\Directory\shell\${PRODUCT_NAME}" "command" "%1"
    !insertmacro RemoveLumineShellEntry "Software\Classes\Directory\background\shell\${PRODUCT_NAME}" "command" "%V"
    !insertmacro RemoveLumineShellEntry "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}" "shell\open\command" "%1"
  ${endIf}
!macroend

!macro MUI_PAGE_ADD_TO_PATH ; Define our custom macro

  ; Define our variables
  Var Dialog
  Var LuminePathCheckbox_Label
  Var LuminePathCheckbox
  Var LuminePathCheckbox_State

  Var LuminePathAdd_Status

  Page custom AddToPathPage AddToPathFunction ; Call our page with creator_function leave_function

  Function AddToPathPage

    !insertmacro MUI_HEADER_TEXT "Choose Installation Options" ""

    nsDialogs::Create 1018 ; Create custom dialog
    Pop $Dialog

    ${If} $Dialog == error
      Abort ; Abort if we fail to create dialog
    ${EndIf}

    ; Enter our custom dialog controls
    ${NSD_CreateLabel} 0 0 100% 24u "You can choose to add the 'lumine' command to your PATH. This allows you to easily invoke Lumine from the shell."
    Pop $LuminePathCheckbox_Label

    ${NSD_CreateCheckbox} 0 30u 100% 10u "&Add Lumine to the User PATH"
    Pop $LuminePathCheckbox

    ; Check the boxes by default
    ${NSD_Check} $LuminePathCheckbox

    ; The below 'If's add memory to the selection. Meaning if the user clicks
    ; forward then returns, their selection will be remembered.
    ${If} $LuminePathCheckbox_State == ${BST_UNCHECKED}
      ${NSD_Uncheck} $LuminePathCheckbox
    ${EndIf}

    nsDialogs::Show ; Show custom dialog

  FunctionEnd

  Function AddToPathFunction
    ; Here we set the memory of the users selection after leaving the page.
    ${NSD_GetState} $LuminePathCheckbox $LuminePathCheckbox_State

    ; Now to add this data to the User PATH
    ${If} $LuminePathCheckbox_State == ${BST_CHECKED}
      ${EnvVarUpdate} $LuminePathAdd_Status "PATH" "A" "HKCU" "$INSTDIR\resources"
    ${EndIf}

  FunctionEnd

  Section
  SectionEnd

!macroend

!macro customPageAfterChangeDir ; Macro called by electron-builder

  !insertmacro MUI_PAGE_ADD_TO_PATH ; Add our custom dialog into the regular installation process

!macroend
