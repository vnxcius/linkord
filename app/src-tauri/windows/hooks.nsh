; Pottira used to be called Linkord, installed as %LOCALAPPDATA%\Linkord with its own registry keys. The renamed
; installer can't see that install (it looks under the new name), so an update would leave it next to the new one:
; the old app in Apps & features, a second Start menu entry, an autostart entry starting the old exe, and pins
; pointing at it. These hooks close the old app, move its shortcuts, pins and autostart over to the new one, and
; remove the old install. The app moves its own data on its first start (lib.rs move_old_app_data).
; Safe to delete once every installed app is a 2.0 build.
!define OLD_NAME "Linkord"
!define OLD_UNINSTKEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\Linkord"
!define OLD_DIRKEY "Software\linkord\Linkord"
!define RUNKEY "Software\Microsoft\Windows\CurrentVersion\Run"
!define PINNED "$APPDATA\Microsoft\Internet Explorer\Quick Launch\User Pinned"

Var OldDir
Var OldExe
Var OldRun

!macro NSIS_HOOK_PREINSTALL
  StrCpy $OldDir ""
  StrCpy $OldExe ""
  ReadRegStr $OldExe HKCU "${OLD_UNINSTKEY}" "MainBinaryName"
  ${If} $OldExe == ""
    StrCpy $OldExe "${OLD_NAME}.exe"
  ${EndIf}
  ReadRegStr $OldDir HKCU "${OLD_DIRKEY}" ""
  ${If} $OldDir == ""
    StrCpy $OldDir "$LOCALAPPDATA\${OLD_NAME}"
  ${EndIf}
  ${If} ${FileExists} "$OldDir\$OldExe"
    ; The updater quits the old app before running this; a copy started by hand is asked to close like the new one.
    !insertmacro CheckIfAppIsRunning "$OldDir\$OldExe" "${OLD_NAME}"
  ${Else}
    StrCpy $OldDir ""
  ${EndIf}
!macroend

!macro POTTIRA_MOVE_SHORTCUT old new
  ${If} ${FileExists} "${old}"
    Delete "${old}"
    ${IfNot} ${FileExists} "${new}"
      CreateShortcut "${new}" "$INSTDIR\${MAINBINARYNAME}.exe"
      !insertmacro SetLnkAppUserModelId "${new}"
    ${EndIf}
  ${EndIf}
!macroend

!macro POTTIRA_REPOINT_PIN lnk
  ; A pin can't be renamed without unpinning it, so it keeps its file and starts the new app.
  ${If} ${FileExists} "${lnk}"
    !insertmacro SetShortcutTarget "${lnk}" "$INSTDIR\${MAINBINARYNAME}.exe"
    !insertmacro SetLnkAppUserModelId "${lnk}"
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ; Shortcuts first: an update skips creating them, so without this an updated install would have none.
  !insertmacro POTTIRA_MOVE_SHORTCUT "$SMPROGRAMS\${OLD_NAME}.lnk" "$SMPROGRAMS\${PRODUCTNAME}.lnk"
  !insertmacro POTTIRA_MOVE_SHORTCUT "$DESKTOP\${OLD_NAME}.lnk" "$DESKTOP\${PRODUCTNAME}.lnk"
  !insertmacro POTTIRA_REPOINT_PIN "${PINNED}\TaskBar\${OLD_NAME}.lnk"
  !insertmacro POTTIRA_REPOINT_PIN "${PINNED}\StartMenu\${OLD_NAME}.lnk"

  ; Start with Windows: the same choice, for the new app (tauri-plugin-autostart names the entry after the app).
  ReadRegStr $OldRun HKCU "${RUNKEY}" "${OLD_NAME}"
  ${If} $OldRun != ""
    DeleteRegValue HKCU "${RUNKEY}" "${OLD_NAME}"
    WriteRegStr HKCU "${RUNKEY}" "${PRODUCTNAME}" '"$INSTDIR\${MAINBINARYNAME}.exe" --minimized'
  ${EndIf}
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "${OLD_NAME}"

  ; The old install itself: only its own two files, then the folder if that left it empty (never a folder the
  ; person chose for other things). Its uninstaller isn't run: it could delete the app data being moved.
  ${If} $OldDir != ""
  ${AndIf} $OldDir != $INSTDIR
    Delete "$OldDir\$OldExe"
    Delete "$OldDir\uninstall.exe"
    RMDir "$OldDir"
  ${EndIf}
  DeleteRegKey HKCU "${OLD_UNINSTKEY}"
  DeleteRegKey HKCU "${OLD_DIRKEY}"
  DeleteRegKey /ifempty HKCU "Software\linkord"
!macroend
