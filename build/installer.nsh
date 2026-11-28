; Luma's installer runs per user, but the stock electron-builder check only
; looks for processes whose executable lives under the *new* install directory.
; A copy started from another folder (an older install on another drive, a
; portable folder) is never matched, and a half-killed Electron tree can leave
; the install stuck on "LumaBrowser cannot be closed".
;
; Closing by image name covers every copy, and doing it in two steps lets the
; browser flush its profile before the leftovers are force-killed.
!macro customCheckAppRunning
  nsExec::Exec `"$SYSDIR\taskkill.exe" /IM "${APP_EXECUTABLE_FILENAME}" /T`
  Sleep 1200
  nsExec::Exec `"$SYSDIR\taskkill.exe" /F /IM "${APP_EXECUTABLE_FILENAME}" /T`
  Sleep 600
!macroend
