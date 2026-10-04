!macro NSIS_HOOK_POSTINSTALL
  WriteRegStr SHCTX "Software\Classes\Folio.PDF\DefaultIcon" "" "$INSTDIR\pdf-file.ico,0"
!macroend
