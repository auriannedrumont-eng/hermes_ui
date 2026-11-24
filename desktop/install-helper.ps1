# Hermes Web — installateur des raccourcis Windows (appele par le choix 3
# de Hermes-Web.bat, mais utilisable aussi directement) :
#   powershell -ExecutionPolicy Bypass -File install-helper.ps1 [-Remove]
#
# Cree sur le Bureau ET dans le menu Demarrer UN SEUL raccourci :
#   • « Hermes Web »  → Hermes-Web.bat (le .bat unique : menu Demarrer /
#     Arreter / Raccourcis). L'arret passe par le meme fichier (argument 2).
# ((92)) Un seul .bat dans le projet : les anciens raccourcis
#   « Hermes Web - Arret.lnk » d'une installation anterieure sont retires.
# Volontairement en ASCII (compatibilite PowerShell 5.1 sans BOM).
param([switch]$Remove)
$ErrorActionPreference = 'Stop'

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = Split-Path -Parent $ScriptDir
$Desktop   = [Environment]::GetFolderPath('Desktop')
$StartMenu = Join-Path ([Environment]::GetFolderPath('Programs')) 'Hermes Web'

# Hermes-Web.bat vit a la RACINE du projet — icone unique, menu inclus.
$links = @(
    @{ Name = 'Hermes Web.lnk';
       Target = (Join-Path $ProjectRoot 'Hermes-Web.bat');
       Arguments = $null;
       WorkDir = $ProjectRoot }
)

if ($Remove) {
    foreach ($l in $links) {
        Remove-Item (Join-Path $Desktop $l.Name) -ErrorAction SilentlyContinue
    }
    # ((92)) retrait aussi de l'ancien raccourci d'arret des versions precedentes
    Remove-Item (Join-Path $Desktop 'Hermes Web - Arret.lnk') -ErrorAction SilentlyContinue
    Remove-Item $StartMenu -Recurse -Force -ErrorAction SilentlyContinue
    Write-Host 'Raccourcis Hermes Web retires (Bureau + menu Demarrer).'
    exit 0
}

# ── Creation du raccourci unique ─────────────────────────────────────────
$icon = Join-Path $ScriptDir 'hermes.ico'
$ws = New-Object -ComObject WScript.Shell
New-Item -ItemType Directory -Force -Path $StartMenu | Out-Null

foreach ($dir in @($Desktop, $StartMenu)) {
    foreach ($l in $links) {
        $lnkPath = Join-Path $dir $l.Name
        $s = $ws.CreateShortcut($lnkPath)
        $s.TargetPath       = $l.Target
        if ($l.Arguments) { $s.Arguments = $l.Arguments }
        $s.WorkingDirectory = $l.WorkDir
        if (Test-Path $icon) { $s.IconLocation = "$icon,0" }
        $s.Description = 'Hermes Web : demarrer, arreter, raccourcis — tout dans un seul menu'
        $s.Save()
    }
    # ((92)) l'ancien raccourci d'arret (versions precedentes) disparait :
    # l'arret vit dans le menu de Hermes-Web.bat, plus de second .lnk.
    Remove-Item (Join-Path $dir 'Hermes Web - Arret.lnk') -ErrorAction SilentlyContinue
}

Write-Host ''
Write-Host 'Raccourci « Hermes Web » cree (Bureau + menu Demarrer).'
Write-Host 'Tout se fait maintenant depuis son menu : demarrer, arreter, raccourcis.'
Write-Host ''
