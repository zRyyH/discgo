; DiscGo installer look (PLAN fase 9B). Included through bundle.windows.nsis.installerHooks
; by installer/installer.nsi. A double-click install shows a single dark page: the mark,
; one line and an accent progress bar; the Modern UI header, buttons and details list are
; hidden. Colours are the app's tokens (desktop/DESIGN.md). The marks are drawn by
; desktop/scripts/brand-art.mjs.

Var DiscGoOpenWhenDone

; Solid compression: files used before the install sections go first.
ReserveFile "${__FILEDIR__}\logo-64.bmp"
ReserveFile "${__FILEDIR__}\logo-96.bmp"
ReserveFile "${__FILEDIR__}\logo-128.bmp"

!define /ifndef DISCGO_SWP_FLAGS 0x0014 ; SWP_NOZORDER | SWP_NOACTIVATE

!macro DiscGoHide parent id
  GetDlgItem $R9 ${parent} ${id}
  ShowWindow $R9 ${SW_HIDE}
!macroend

; out = in * dpi / 96
!macro DiscGoScale out in
  IntOp ${out} ${in} * $7
  IntOp ${out} ${out} / 96
!macroend

Function DiscGoInstFilesShow
  Push $0
  Push $1
  Push $2
  Push $3
  Push $4
  Push $5
  Push $6
  Push $7
  Push $8

  ; Dark title bar in the window colour (ignored before Windows 10 2004 / 11).
  System::Call 'dwmapi::DwmSetWindowAttribute(p $HWNDPARENT, i 20, *i 1, i 4)'
  System::Call 'dwmapi::DwmSetWindowAttribute(p $HWNDPARENT, i 35, *i 0x00100C0B, i 4)'

  ; Modern UI chrome off: header, its image and lines, branding text, buttons.
  SetCtlColors $HWNDPARENT 0xE7E9F0 0x0B0C10
  !insertmacro DiscGoHide $HWNDPARENT 1034
  !insertmacro DiscGoHide $HWNDPARENT 1035
  !insertmacro DiscGoHide $HWNDPARENT 1036
  !insertmacro DiscGoHide $HWNDPARENT 1037
  !insertmacro DiscGoHide $HWNDPARENT 1038
  !insertmacro DiscGoHide $HWNDPARENT 1039
  !insertmacro DiscGoHide $HWNDPARENT 1028
  !insertmacro DiscGoHide $HWNDPARENT 1256
  !insertmacro DiscGoHide $HWNDPARENT 1
  !insertmacro DiscGoHide $HWNDPARENT 2
  !insertmacro DiscGoHide $HWNDPARENT 3

  ; The page fills the whole client area.
  FindWindow $0 "#32770" "" $HWNDPARENT
  SetCtlColors $0 0xE7E9F0 0x0B0C10
  System::Call '*(i, i, i, i) p .r1'
  System::Call 'user32::GetClientRect(p $HWNDPARENT, p r1)'
  System::Call '*$1(i, i, i .r2, i .r3)'
  System::Free $1
  System::Call 'user32::SetWindowPos(p r0, p 0, i 0, i 0, i r2, i r3, i ${DISCGO_SWP_FLAGS})'
  ; Status line and details list off; the bar stays.
  !insertmacro DiscGoHide $0 1006
  !insertmacro DiscGoHide $0 1016
  !insertmacro DiscGoHide $0 1027

  ; Sizes follow the display scaling.
  System::Call 'user32::GetDpiForWindow(p $HWNDPARENT) i .r7'
  ${If} $7 < 96
    StrCpy $7 96
  ${EndIf}
  InitPluginsDir
  ${If} $7 >= 168
    File "/oname=$PLUGINSDIR\discgo-logo.bmp" "${__FILEDIR__}\logo-128.bmp"
  ${ElseIf} $7 >= 120
    File "/oname=$PLUGINSDIR\discgo-logo.bmp" "${__FILEDIR__}\logo-96.bmp"
  ${Else}
    File "/oname=$PLUGINSDIR\discgo-logo.bmp" "${__FILEDIR__}\logo-64.bmp"
  ${EndIf}

  ; Layout, centred: mark 64, gap 20, title 32, gap 22, bar 6.
  !insertmacro DiscGoScale $4 64
  !insertmacro DiscGoScale $5 144 ; whole block height
  IntOp $6 $3 - $5
  IntOp $6 $6 / 2 ; top of the block
  IntOp $8 $2 - $4
  IntOp $8 $8 / 2
  ; The mark (SS_BITMAP | WS_CHILD | WS_VISIBLE).
  System::Call 'user32::CreateWindowExW(i 0, w "STATIC", w "", i 0x5000000E, i r8, i r6, i r4, i r4, p r0, p 0, p 0, p 0) p .r1'
  System::Call 'user32::LoadImageW(p 0, w "$PLUGINSDIR\discgo-logo.bmp", i 0, i r4, i r4, i 0x10) p .r5'
  SendMessage $1 0x0172 0 $5 ; STM_SETIMAGE, IMAGE_BITMAP

  ; The line (SS_CENTER | WS_CHILD | WS_VISIBLE), Segoe UI semibold. $(^Name) is the
  ; product name, so DiscGo Dev (PLAN fase 10.6) says its own.
  !insertmacro DiscGoScale $5 84
  IntOp $6 $6 + $5
  !insertmacro DiscGoScale $5 32
  System::Call 'user32::CreateWindowExW(i 0, w "STATIC", w "Instalando o $(^Name)…", i 0x50000001, i 0, i r6, i r2, i r5, p r0, p 0, p 0, p 0) p .r1'
  !insertmacro DiscGoScale $8 -20
  System::Call 'gdi32::CreateFontW(i r8, i 0, i 0, i 0, i 600, i 0, i 0, i 0, i 1, i 0, i 0, i 5, i 0, w "Segoe UI") p .r5'
  SendMessage $1 ${WM_SETFONT} $5 1
  SetCtlColors $1 0xE7E9F0 0x0B0C10

  ; The bar: no visual style, so it takes the accent on the raised surface colour.
  !insertmacro DiscGoScale $5 54
  IntOp $6 $6 + $5
  GetDlgItem $1 $0 1004
  System::Call 'uxtheme::SetWindowTheme(p r1, w "", w "")'
  ; ...and no sunken border: drop WS_BORDER, WS_EX_CLIENTEDGE and WS_EX_STATICEDGE.
  System::Call 'user32::GetWindowLongW(p r1, i -16) i .r5'
  IntOp $5 $5 & 0xFF7FFFFF
  System::Call 'user32::SetWindowLongW(p r1, i -16, i r5)'
  System::Call 'user32::GetWindowLongW(p r1, i -20) i .r5'
  IntOp $5 $5 & 0xFFFDFDFF
  System::Call 'user32::SetWindowLongW(p r1, i -20, i r5)'
  SendMessage $1 0x0409 0 0x00FF9C8B ; PBM_SETBARCOLOR #8B9CFF
  SendMessage $1 0x2001 0 0x0030211E ; PBM_SETBKCOLOR #1E2130
  !insertmacro DiscGoScale $4 280
  !insertmacro DiscGoScale $5 6
  IntOp $8 $2 - $4
  IntOp $8 $8 / 2
  System::Call 'user32::SetWindowPos(p r1, p 0, i r8, i r6, i r4, i r5, i 0x0034)' ; + SWP_FRAMECHANGED

  Pop $8
  Pop $7
  Pop $6
  Pop $5
  Pop $4
  Pop $3
  Pop $2
  Pop $1
  Pop $0
FunctionEnd

