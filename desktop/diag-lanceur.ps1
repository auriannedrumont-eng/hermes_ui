# Diagnostic : lance le lanceur en avant, capture tout, sans mise à jour du dépôt.
# Revue P1-P7 : plus AUCUN chemin F:\hermes_web en dur — le script vit DANS
# le dossier de l'application et s'adapte à son emplacement réel.
$Root = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
$log = Join-Path $Root 'desktop\logs\lanceur-manuel.log'
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $log) | Out-Null
"=== depart $(Get-Date -Format 'HH:mm:ss') ===" | Out-File $log -Encoding utf8
Set-Location $Root
try {
  powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Root 'desktop\hermes-ui.ps1') start *>> $log
  "=== fin code $LASTEXITCODE ===" | Out-File $log -Append -Encoding utf8
} catch {
  "=== EXCEPTION : $_ ===" | Out-File $log -Append -Encoding utf8
}
