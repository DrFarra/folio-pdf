Var FolioPdfBackup

!macro NSIS_HOOK_PREINSTALL
  ; Reinstalling backs up Folio's own class over the previous PDF app; keep that one.
  ReadRegStr $FolioPdfBackup SHCTX "Software\Classes\.pdf" "Folio.PDF_backup"
!macroend

!macro NSIS_HOOK_POSTINSTALL
  WriteRegStr SHCTX "Software\Classes\Folio.PDF\DefaultIcon" "" "$INSTDIR\pdf-file.ico,0"
  WriteRegStr SHCTX "Software\Classes\Folio.PDF\shell\open" "" "Abrir con Folio"
  ReadRegStr $R0 SHCTX "Software\Classes\.pdf" "Folio.PDF_backup"
  ${If} $R0 == "Folio.PDF"
    WriteRegStr SHCTX "Software\Classes\.pdf" "Folio.PDF_backup" "$FolioPdfBackup"
  ${EndIf}
  !insertmacro UPDATEFILEASSOC
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ; An empty or dangling .pdf class would hide the system's PDF app.
  ReadRegStr $R0 SHCTX "Software\Classes\.pdf" ""
  ${If} $R0 == "Folio.PDF"
  ${OrIf} $R0 == ""
    DeleteRegValue SHCTX "Software\Classes\.pdf" ""
  ${EndIf}
  DeleteRegValue SHCTX "Software\Classes\.pdf" "Folio.PDF_backup"
  ${If} $DeleteAppDataCheckboxState = 1
  ${AndIf} $UpdateMode <> 1
    ; The Google Drive sign-in kept in Windows Credential Manager (CRED_TYPE_GENERIC).
    System::Call 'advapi32::CredDeleteW(w "refresh-token.org.folio.pdf.google-drive", i 1, i 0) i .r0'
  ${EndIf}
  !insertmacro UPDATEFILEASSOC
!macroend
