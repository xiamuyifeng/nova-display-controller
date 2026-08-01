Var NovaDiagnosticLogDirectory

!macro NSIS_HOOK_POSTINSTALL
  ; Remove the development probe left by early 0.1.0 preview installers.
  Delete "$INSTDIR\hid_probe.exe"

  ReadRegStr $0 HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "NovaDisplayController"
  StrCmp $0 "" 0 nova_startup_enabled
  ReadRegStr $0 HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "SteelSeriesOLEDController"
  StrCmp $0 "" nova_startup_done

  nova_startup_enabled:
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "NovaDisplayController" '$\"$INSTDIR\nova-display-controller.exe$\" --hidden'
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "SteelSeriesOLEDController"

  nova_startup_done:
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ReadRegStr $NovaDiagnosticLogDirectory HKCU "Software\xiamuyifeng\Nova Display Controller" "DiagnosticLogDirectory"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "NovaDisplayController"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "SteelSeriesOLEDController"
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ; Tauri clears the current bundle ID. Also clear data from the preview bundle ID
  ; so the one-time migration cannot restore it after a clean reinstall.
  ${If} $DeleteAppDataCheckboxState = 1
  ${AndIf} $UpdateMode <> 1
    SetShellVarContext current
    RMDir /r "$APPDATA\com.steelseries-oled.app"
    RMDir /r "$LOCALAPPDATA\com.steelseries-oled.app"
    ${If} $NovaDiagnosticLogDirectory != ""
      Delete "$NovaDiagnosticLogDirectory\nova-display.log"
      Delete "$NovaDiagnosticLogDirectory\nova-display.old.log"
      RMDir "$NovaDiagnosticLogDirectory"
    ${EndIf}
    DeleteRegValue HKCU "Software\xiamuyifeng\Nova Display Controller" "DiagnosticLogDirectory"
    DeleteRegKey /ifempty HKCU "Software\xiamuyifeng\Nova Display Controller"
    RMDir "$INSTDIR\logs"
    RMDir "$INSTDIR"
  ${EndIf}
!macroend
