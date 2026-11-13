# ─────────────────────────────────────────────────────────────────────────
# Hermes Web — installateur des raccourcis Windows (appele par
# Installer-Hermes.bat, mais utilisable aussi directement) :
#   powershell -ExecutionPolicy Bypass -File install-helper.ps1 [-Remove]
#
# Cree sur le Bureau ET dans le menu Demarrer :
#   • « Hermes Web »          → demarre la pile et ouvre le navigateur
#   • « Hermes Web - Arret »  → arret propre de la pile
# Volontairement en ASCII (compatibilite PowerShell 5.1 sans BOM).
# ─────────────────────────────────────────────────────────────────────────
param([switch]$Remove)
$ErrorActionPreference = 'Stop'

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Desktop   = [Environment]::GetFolderPath('Desktop')
$StartMenu = Join-Path ([Environment]::GetFolderPath('Programs')) 'Hermes Web'

$links = @(
    @{ Name = 'Hermes Web.lnk';         Target = 'Hermes-Web.bat' },
    @{ Name = 'Hermes Web - Arret.lnk'; Target = 'Hermes-Web-Arret.bat' }
)

if ($Remove) {
    foreach ($l in $links) {
        Remove-Item (Join-Path $Desktop $l.Name) -ErrorAction SilentlyContinue
    }
    Remove-Item $StartMenu -Recurse -Force -ErrorAction SilentlyContinue
    Write-Host 'Raccourcis Hermes Web retires (Bureau + menu Demarrer).'
    exit 0
}

# ── Verification des dependances (informationnelle) ─────────────────────
Write-Host ''
Write-Host 'Verification des dependances :'
$ok = $true
foreach ($dep in @('bun', 'node', 'caddy')) {
    if (Get-Command $dep -ErrorAction SilentlyContinue) {
        Write-Host "  [OK]      $dep"
    } else {
        $winget = @{ bun = 'Oven-sh.Bun'; node = 'OpenJS.NodeJS'; caddy = 'CaddyServer.Caddy' }[$dep]
        Write-Host "  [MANQUE]  $dep  ->  winget install $winget"
        $ok = $false
    }
}
if (-not (Test-Path (Join-Path (Split-Path -Parent $ScriptDir) 'node_modules'))) {
    Write-Host '  [MANQUE]  node_modules -> dans le dossier du projet : npm install'
    $ok = $false
}
if (-not $ok) {
    Write-Host ''
    Write-Host 'Installez les elements manquants ci-dessus, puis relancez Installer-Hermes.bat.'
    Write-Host '(les raccourcis sont tout de meme crees ci-dessous)'
}
if (-not (Get-Command 'caddy' -ErrorAction SilentlyContinue)) {
    Write-Host ''
    Write-Host 'Note : sans caddy, le lanceur cherchera une passerelle existante ;'
    Write-Host 'sinon il expliquera quoi installer au premier demarrage.'
}

# ── Creation des raccourcis ─────────────────────────────────────────────
$icon = Join-Path $ScriptDir 'hermes.ico'
$ws = New-Object -ComObject WScript.Shell
New-Item -ItemType Directory -Force -Path $StartMenu | Out-Null

foreach ($dir in @($Desktop, $StartMenu)) {
    foreach ($l in $links) {
        $lnkPath = Join-Path $dir $l.Name
        $s = $ws.CreateShortcut($lnkPath)
        $s.TargetPath       = Join-Path $ScriptDir $l.Target
        $s.WorkingDirectory = $ScriptDir
        $s.IconLocation     = "$icon,0"
        if ($l.Name -like '*Arret*') { $s.Description = 'Arret propre de la pile Hermes Web' }
        else { $s.Description = 'Demarre Hermes Web et ouvre le navigateur' }
        $s.Save()
    }
}

Write-Host ''
Write-Host 'Raccourcis crees :'
Write-Host "  Bureau       : $Desktop"
Write-Host "  Menu Demarrer : $StartMenu"
Write-Host ''
Write-Host 'Double-cliquez sur « Hermes Web » pour demarrer.'
Write-Host 'Retrait des raccourcis : Installer-Hermes.bat --remove'
