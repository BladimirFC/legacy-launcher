; The unpacked ZIP deliberately has no installed marker.
!macro customInstall
  FileOpen $0 "$INSTDIR\.legacy-installed" w
  FileWrite $0 "NSIS"
  FileClose $0
!macroend

!macro customUnInstall
  Delete "$INSTDIR\.legacy-installed"
!macroend
