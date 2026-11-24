# Démarre la pile Hermes Web dans une fenêtre PowerShell indépendante
# (le superviseur du lanceur doit survivre à l'appel qui le lance).
# diag-lanceur.ps1 journalise tout dans logs\lanceur-manuel.log.
Start-Process -FilePath "powershell.exe" `
  -ArgumentList "-NoExit","-ExecutionPolicy","Bypass","-File","F:\hermes_web\desktop\diag-lanceur.ps1" `
  -WorkingDirectory "F:\hermes_web"
