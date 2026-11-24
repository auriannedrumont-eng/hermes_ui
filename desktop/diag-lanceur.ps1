# Diagnostic : lance le lanceur en avant, capture tout, sans mise à jour du dépôt.
$log = "F:\hermes_web\desktop\logs\lanceur-manuel.log"
"=== depart $(Get-Date -Format 'HH:mm:ss') ===" | Out-File $log -Encoding utf8
Set-Location F:\hermes_web
try {
  powershell -NoProfile -ExecutionPolicy Bypass -File "F:\hermes_web\desktop\hermes-ui.ps1" start *>> $log
  "=== fin code $LASTEXITCODE ===" | Out-File $log -Append -Encoding utf8
} catch {
  "=== EXCEPTION : $_ ===" | Out-File $log -Append -Encoding utf8
}
