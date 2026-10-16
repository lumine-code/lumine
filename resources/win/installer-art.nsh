!ifndef LUMINE_INSTALLER_ART
!define LUMINE_INSTALLER_ART
!include MUI2.nsh
!include Util.nsh

; Render the vector artwork at 3x, then fit it to the actual DPI-scaled control
; with HALFTONE. LoadImage's built-in resize drops samples at small sizes.
!macro LumineSetScaledBitmap CONTROL IMAGE HANDLE
  Push "${IMAGE}"
  Push "${CONTROL}"
  ${CallArtificialFunction} LumineScaleBitmap
  !if "${HANDLE}" == "Leak"
    !insertmacro _LOGICLIB_TEMP
    Pop $_LOGICLIB_TEMP
  !else
    Pop ${HANDLE}
  !endif
!macroend

!macro LumineScaleBitmap
  System::Store "S"
  Pop $0 ; target control
  Pop $1 ; bitmap path
  StrCpy $R6 0 ; returned HBITMAP
  System::Call 'user32::GetClientRect(pr0,@r2)'
  System::Call '*$2(i,i,i.r3,i.r4)'
  ${If} $3 > 0
  ${AndIf} $4 > 0
    ; Preserve the full source raster as a DIB section.
    System::Call 'user32::LoadImage(p0,tr1,i0,i0,i0,i0x2010)p.r5'
    ${If} $5 P<> 0
      ; NSIS runs a 32-bit stub, whose BITMAP structure is 24 bytes.
      System::Call 'gdi32::GetObject(pr5,i24,@r2)'
      System::Call '*$2(i,i.r6,i.r7)'
      System::Call 'user32::GetDC(pr0)p.r8'
      System::Call 'gdi32::CreateCompatibleDC(pr8)p.r9'
      System::Call 'gdi32::CreateCompatibleDC(pr8)p.R0'
      System::Call 'gdi32::CreateCompatibleBitmap(pr8,ir3,ir4)p.R1'
      ${If} $8 P<> 0
      ${AndIf} $9 P<> 0
      ${AndIf} $R0 P<> 0
      ${AndIf} $R1 P<> 0
        System::Call 'gdi32::SelectObject(pr9,pr5)p.R2'
        System::Call 'gdi32::SelectObject(pR0,pR1)p.R3'
        System::Call 'gdi32::SetStretchBltMode(pR0,i4)'
        System::Call 'gdi32::SetBrushOrgEx(pR0,i0,i0,p0)'
        System::Call 'gdi32::StretchBlt(pR0,i0,i0,ir3,ir4,pr9,i0,i0,ir6,ir7,i0x00cc0020)i.R4'
        System::Call 'gdi32::SelectObject(pr9,pR2)'
        System::Call 'gdi32::SelectObject(pR0,pR3)'
        ${If} $R4 <> 0
          SendMessage $0 ${STM_SETIMAGE} ${IMAGE_BITMAP} $R1 $R5
          ${If} $R5 P<> 0
            System::Call 'gdi32::DeleteObject(pR5)'
          ${EndIf}
          StrCpy $R6 $R1
        ${EndIf}
      ${EndIf}
      ${If} $R6 P= 0
        System::Call 'gdi32::DeleteObject(pR1)'
      ${EndIf}
      System::Call 'gdi32::DeleteDC(pr9)'
      System::Call 'gdi32::DeleteDC(pR0)'
      System::Call 'user32::ReleaseDC(pr0,pr8)'
      System::Call 'gdi32::DeleteObject(pr5)'
    ${EndIf}
  ${EndIf}
  Push $R6
  System::Store "L"
!macroend

; Keep MUI's page/control layout and ownership of welcome/finish HBITMAPs.
; Only replace the two image-loading hooks in the bundled MUI2 implementation.
!macroundef MUI_INTERNAL_FULLWINDOW_LOADWIZARDIMAGE
!macro MUI_INTERNAL_FULLWINDOW_LOADWIZARDIMAGE UN CONTROL IMAGE HANDLE
  !insertmacro LumineSetScaledBitmap "${CONTROL}" "${IMAGE}" "${HANDLE}"
!macroend

!macroundef MUI_HEADERIMAGE_INITHELPER_LOADIMAGE
!macro MUI_HEADERIMAGE_INITHELPER_LOADIMAGE UN RTL IMGRESID PATH
  GetDlgItem $mui.Header.Image $HWNDPARENT ${IMGRESID}
  !insertmacro LumineSetScaledBitmap $mui.Header.Image "${PATH}" Leak
!macroend
!endif
