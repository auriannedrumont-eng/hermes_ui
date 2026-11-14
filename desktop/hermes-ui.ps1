# ─────────────────────────────────────────────────────────────────────────
# Hermes Web — lanceur unique (Windows), appele par Hermes-Web.bat a la
# racine du dossier hermes.
#
# Demarre la pile complete (mini-service chat, interface Next, passerelle
# Caddy), ouvre le navigateur, puis surveille les composants.
#
# Usage (normalement via Hermes-Web.bat, pas en ligne de commande) :
#   hermes-ui.ps1 start | stop | status | restart
#
# Installation portable automatique :
#   Au premier demarrage, tout ce qui manque est installe DANS le dossier
#   hermes (sous-dossier tools\) : Node.js v22 LTS, Bun, Caddy, puis
#   dependances npm/bun, client Prisma et build de production. Sans admin,
#   sans registre, sans ecrire hors du dossier : il reste mobile (cle USB
#   comprise). Les fois suivantes, le double-clic est immediat : verification
#   silencieuse des mises a jour GitHub (dossier clone en git : fusion
#   rapide, jamais bloquante, dependances/build refaits seulement si
#   necessaire), puis demarrage de la pile.
#
# Securite de fermeture :
#   • Tous les processus sont places dans un Job Object noyau avec
#     KILL_ON_JOB_CLOSE : si le lanceur meurt DE N'IMPORTE QUELLE maniere
#     (fermeture de la fenetre, deconnexion, taskkill), Windows tue tout
#     l'arbre — zero orphelin garanti par le noyau.
#   • Ctrl-C dans la fenetre : arret ordonne (passerelle -> interface ->
#     mini-service en dernier).
#   • Sur arret brutal, SQLite recupere le fichier WAL automatiquement au
#     demarrage suivant : aucune donnee perdue (mode WAL = securise crash).
#
# Ne sont JAMAIS tues les processus hors de ce projet : chaque cible est
# validee (chemin du projet dans la ligne de commande) avant arret.
# Encodage : UTF-8 avec BOM (requis par PowerShell 5.1 pour les accents).
# ─────────────────────────────────────────────────────────────────────────
param([ValidateSet('start','stop','status','restart')][string]$Action = 'start')
$ErrorActionPreference = 'Stop'

# ── Chemins ─────────────────────────────────────────────────────────────
$ScriptDir  = Split-Path -Parent $MyInvocation.MyCommand.Path
$Root       = Split-Path -Parent $ScriptDir
$RuntimeDir = Join-Path $ScriptDir 'runtime'
$LogDir     = Join-Path $ScriptDir 'logs'
$StateFile  = Join-Path $RuntimeDir 'state.env'
New-Item -ItemType Directory -Force -Path $RuntimeDir, $LogDir | Out-Null

$LauncherLog = Join-Path $LogDir 'launcher.log'

# Ports fixes imposes par le client (constantes SERVICE_PORT/FILES_PORT)
$ChatPort = 3003; $FilesPort = 3004
# Ordre de preference pour les ports mobiles
$GwPorts = @(81, 8081, 8181, 18081)
$UiPorts = @(3000, 3001, 3002, 3005)
$MaxRestarts = 3

# Marqueurs d'arbre de processus (separateurs Windows/Unix toleres)
$MChat = 'index\.ts|hermes-chat'
$MUii  = 'next dev|standalone[\\/]server\.js|next-server'
$MGw   = 'caddy run'

function Log([string]$msg) {
    $line = '[{0}] {1}' -f (Get-Date -Format 'HH:mm:ss'), $msg
    Write-Host $line
    Add-Content -Path $LauncherLog -Value $line
}
function Die([string]$msg) {
    Log "ERREUR : $msg"
    Write-Host ''
    Write-Host "  Hermes Web n'a pas demarre : $msg" -ForegroundColor Red
    Write-Host ''
    exit 1
}

# ── Etat persistant (PID/ports/ownership) ───────────────────────────────
$Script:State = @{}
function Load-State {
    $Script:State = @{}
    if (Test-Path $StateFile) {
        foreach ($l in (Get-Content $StateFile)) {
            $p = $l.Split('=', 2)
            if ($p.Count -eq 2) { $Script:State[$p[0]] = $p[1] }
        }
    }
}
function Save-State {
    $lines = $Script:State.GetEnumerator() | Sort-Object Name | ForEach-Object { "{0}={1}" -f $_.Key, $_.Value }
    if ($lines) { $lines | Set-Content -Path $StateFile -Encoding ASCII } else { Remove-Item $StateFile -ErrorAction SilentlyContinue }
}
function State-Set([string]$k, $v) { $Script:State[$k] = [string]$v; Save-State }
function State-Get([string]$k) { if ($Script:State.ContainsKey($k)) { return $Script:State[$k] } else { return '' } }

# ── Reseau ──────────────────────────────────────────────────────────────
function Test-PortBusy([int]$port) {
    $c = New-Object System.Net.Sockets.TcpClient
    try {
        $t = $c.BeginConnect('127.0.0.1', $port, $null, $null)
        if ($t.AsyncWaitHandle.WaitOne(400)) { $c.EndConnect($t); return $true }
        return $false
    } catch { return $false } finally { $c.Close() }
}
function Get-HttpCode([string]$url, [int]$timeoutSec = 4) {
    try {
        $r = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec $timeoutSec
        return [int]$r.StatusCode
    } catch {
        if ($_.Exception.Response) { return [int]$_.Exception.Response.StatusCode }
        return 0
    }
}
function Wait-Http([string]$url, [int]$want, [int]$tries, [string]$label) {
    $code = 0
    for ($i = 1; $i -le $tries; $i++) {
        $code = Get-HttpCode $url 3
        if ($code -eq $want) { Log "  OK $label pret (HTTP $code)"; return $true }
        Start-Sleep -Seconds 1
    }
    Log "  ECHEC $label : HTTP $code apres ${tries}s (attendu $want)"
    return $false
}
function Pick-Port([int[]]$candidates) {
    foreach ($p in $candidates) { if (-not (Test-PortBusy $p)) { return $p } }
    return 0
}

# ── Sante des composants ────────────────────────────────────────────────
function Test-ChatHealthy { (Get-HttpCode "http://127.0.0.1:$ChatPort/socket.io/?EIO=4&transport=polling" 3) -eq 200 }
function Test-UiHealthy   { (Get-HttpCode ("http://127.0.0.1:{0}/" -f (State-Get 'UI_PORT')) 6) -eq 200 }
function Test-GwHealthy   { (Get-HttpCode ("http://127.0.0.1:{0}/" -f (State-Get 'GW_PORT')) 4) -eq 200 }

# ── Processus ───────────────────────────────────────────────────────────
function Get-ProcById([int]$procId) {
    try { return (Get-CimInstance Win32_Process -Filter "ProcessId=$procId" -ErrorAction SilentlyContinue) } catch { return $null }
}
# Un processus nous appartient-il ? (chemin du projet dans sa ligne de
# commande) — garde anti « kill d'un processus innocent ».
function Test-OurProcess([int]$procId) {
    if ($procId -le 1) { return $false }
    $p = Get-ProcById $procId
    if (-not $p) { return $false }
    $cl = [string]$p.CommandLine
    if ($cl -match [regex]::Escape($Root)) { return $true }
    if ($cl -match 'hermes-chat') { return $true }
    return $false
}
function Get-Descendants([int]$procId) {
    $out = @()
    $kids = Get-CimInstance Win32_Process -Filter "ParentProcessId=$procId" -ErrorAction SilentlyContinue
    foreach ($k in $kids) {
        $out += [int]$k.ProcessId
        $out += Get-Descendants ([int]$k.ProcessId)
    }
    return $out
}
# Processus du systeme portant le marqueur ET vivant dans notre projet
function Get-MarkedOurs([string]$marker) {
    $rootEsc = [regex]::Escape($Root)
    $list = @()
    # boucle foreach (pas ForEach-Object : son bloc s'execute dans une
    # portee locale et « += » n'y modifierait jamais $list)
    $found = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
        $_.CommandLine -and ($_.CommandLine -match $marker) -and
        (($_.CommandLine -match $rootEsc) -or ($_.CommandLine -match 'hermes-chat'))
    }
    foreach ($p in $found) { $list += [int]$p.ProcessId }
    return $list
}
# Arret de l'arbre complet d'un composant (descendants compris)
function Stop-Tree([string]$pidVar, [string]$marker) {
    $targets = @(Get-MarkedOurs $marker)
    $lp = 0; [int]::TryParse((State-Get $pidVar), [ref]$lp) | Out-Null
    if ((Test-OurProcess $lp) -and ($targets -notcontains $lp)) { $targets += $lp }
    $all = @()
    foreach ($t in ($targets | Sort-Object -Unique)) {
        $all += $t
        $all += Get-Descendants $t
    }
    $all = @($all | Sort-Object -Unique)
    if ($all.Count -eq 0) { Log "  (rien a arreter pour $marker)"; return }
    Log ("  arret force " + $marker + " [" + ($all -join ' ') + "]")
    foreach ($p in ($all | Sort-Object -Descending)) {
        try { Stop-Process -Id $p -Force -ErrorAction SilentlyContinue } catch { }
    }
}
function Wait-Gone([string]$marker, [int]$timeout = 10) {
    for ($i = 0; $i -lt $timeout; $i++) {
        if ((Get-MarkedOurs $marker).Count -eq 0) { return }
        Start-Sleep -Seconds 1
    }
    foreach ($p in (Get-MarkedOurs $marker)) {
        try { Stop-Process -Id $p -Force -ErrorAction SilentlyContinue } catch { }
    }
    Start-Sleep -Seconds 1
}
function Wait-PortFree([int]$port, [int]$timeout = 10) {
    for ($i = 0; $i -lt $timeout; $i++) {
        if (-not (Test-PortBusy $port)) { return $true }
        Start-Sleep -Seconds 1
    }
    return $false
}

# ── Job Object noyau : arbre entier tue si le lanceur meurt ─────────────
$Script:JobHandle = [IntPtr]::Zero
function Initialize-JobObject {
    try {
        if (-not ('JobKill' -as [type])) {
            Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class JobKill {
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
  public static extern IntPtr CreateJobObject(IntPtr a, string lpName);
  [DllImport("kernel32.dll")]
  public static extern bool SetInformationJobObject(IntPtr hJob, int infoClass, ref JOBOBJECT_BASIC_LIMIT_INFORMATION lpInfo, int cbInfo);
  [DllImport("kernel32.dll")]
  public static extern bool AssignProcessToJobObject(IntPtr hJob, IntPtr hProcess);
  [StructLayout(LayoutKind.Sequential)]
  public struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
    public long PerProcessUserTimeLimit; public long PerJobUserTimeLimit;
    public uint LimitFlags; public UIntPtr MinimumWorkingSetSize;
    public UIntPtr MaximumWorkingSetSize; public uint ActiveProcessLimit;
    public UIntPtr Affinity; public uint PriorityClass; public uint SchedulingClass;
  }
}
"@
        }
        $info = New-Object 'JobKill+JOBOBJECT_BASIC_LIMIT_INFORMATION'
        $info.LimitFlags = 0x2000   # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        $Script:JobHandle = [JobKill]::CreateJobObject([IntPtr]::Zero, $null)
        [void][JobKill]::SetInformationJobObject($Script:JobHandle, 1, [ref]$info, [Runtime.InteropServices.Marshal]::SizeOf($info))
        Log "• Job Object noyau actif (arbre entier arrete si cette fenetre se ferme)"
    } catch {
        Log "• ATTENTION : Job Object indisponible ($($_.Exception.Message)) — fermeture via Ctrl-C recommandee"
    }
}
function Add-ToJob($proc) {
    if ($Script:JobHandle -ne [IntPtr]::Zero -and $proc) {
        try { [void][JobKill]::AssignProcessToJobObject($Script:JobHandle, $proc.Handle) } catch { }
    }
}
# Chaque argument protege par des guillemets si besoin : Start-Process
# joint les elements sans les echapper, un chemin avec espace eclaterait
# en plusieurs arguments sinon.
function Quote-Arg([string]$a) {
    if ($a -match '\s') { return '"' + ($a -replace '"', '\"') + '"' }
    return $a
}
function Start-Component([string]$file, [string[]]$argList, [string]$workDir, [string]$logBase) {
    $quoted = @($argList | ForEach-Object { Quote-Arg $_ })
    $p = Start-Process -FilePath $file -ArgumentList $quoted -WorkingDirectory $workDir `
        -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput (Join-Path $LogDir "$logBase.log") `
        -RedirectStandardError  (Join-Path $LogDir "$logBase-err.log")
    Add-ToJob $p
    return $p
}

# ── Dependances ─────────────────────────────────────────────────────────
function Test-Command([string]$name) { return [bool](Get-Command $name -ErrorAction SilentlyContinue) }

# ── Mise a jour automatique depuis GitHub ───────────────────────────────
# Chaque demarrage a froid verifie si de nouveaux commits ont ete pousses
# sur GitHub ; le cas echeant le dossier avance au dernier commit par
# fusion RAPIDE uniquement (fast-forward : aucun fichier local modifie
# n est jamais ecrase ; fusion impossible -> version locale conservee et
# signalee). Dependances reinstallees et interface reconstruite UNIQUEMENT
# si les fichiers concernes ont change (un push de documentation seule ne
# reconstruit rien). Jamais bloquant : git absent, dossier non clone,
# pas de reseau, connexion GitHub refusee -> message + demarrage avec la
# version presente. La premiere verification peut ouvrir une fenetre
# GitHub demandant de se connecter : c est le gestionnaire d identifiants
# de git (Git Credential Manager), il ne la rouvrira plus ensuite.
$Script:UpdateChangedFiles = @()

# Appelle git en absorbant stderr (avec $ErrorActionPreference = Stop un
# « 2>&1 » brut interromprait le script sous PowerShell 5.1) ; renvoie
# @{ Code = code de sortie ; Text = sortie compilee }.
function Invoke-Git([string[]]$GitArgs) {
    $old = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $out = & git -C $Root @GitArgs 2>&1
        $text = ($out | ForEach-Object { [string]$_ }) -join "`n"
        return @{ Code = $LASTEXITCODE; Text = $text }
    } finally { $ErrorActionPreference = $old }
}

# La mise a jour a-t-elle touche l un des fichiers listes ?
function Test-FilesChanged([string[]]$Paths) {
    foreach ($p in $Paths) { if ($Script:UpdateChangedFiles -contains $p) { return $true } }
    return $false
}

function Update-FromGit {
    if (-not (Test-Command 'git')) {
        Log "• mise a jour auto : git n est pas installe — Hermes demarre avec la version presente"
        return
    }
    if (-not (Test-Path (Join-Path $Root '.git'))) {
        Log "• mise a jour auto : le dossier n est pas un clone git — ignoree"
        return
    }
    $r = Invoke-Git @('remote', 'get-url', 'origin')
    if ($r.Code -ne 0 -or $r.Text.Trim() -notmatch '^https?://') {
        Log "• mise a jour auto : pas de depot GitHub distant — ignoree"
        return
    }
    # Ne jamais rester bloque sur une demande de saisie console ; la
    # connexion GitHub passe par la fenetre du gestionnaire d identifiants.
    $env:GIT_TERMINAL_PROMPT = '0'
    $r = Invoke-Git @('rev-parse', 'HEAD')
    if ($r.Code -ne 0) { Log "• mise a jour auto : etat du depot illisible — ignoree"; return }
    $before = $r.Text.Trim()
    Log "• verification des mises a jour sur GitHub..."
    $r = Invoke-Git @('fetch', '--quiet', 'origin')
    if ($r.Code -ne 0) {
        Log "  pas de mise a jour recuperee (reseau ou connexion GitHub) — version locale conservee"
        return
    }
    $r = Invoke-Git @('rev-parse', '@{u}')
    if ($r.Code -ne 0) { Log "  pas de branche distante suivie — mise a jour ignoree"; return }
    $upstream = $r.Text.Trim()
    if ($upstream -eq $before) { Log "  a jour : aucune nouvelle version"; return }
    $r = Invoke-Git @('merge', '--ff-only', $upstream)
    if ($r.Code -ne 0) {
        Log "  ATTENTION : nouvelle version disponible mais non appliquee (fichiers locaux modifies ?) — version locale conservee"
        return
    }
    $r = Invoke-Git @('diff', '--name-only', $before, $upstream)
    $Script:UpdateChangedFiles = @($r.Text -split "`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ })
    Log ("  mise a jour appliquee : {0} fichier(s) recupere(s) de GitHub" -f $Script:UpdateChangedFiles.Count)
    # Interface a reconstruire ? seulement si son code ou sa configuration
    # a change (src/, public/, configs racine) — sinon le build actuel reste
    # valable et le demarrage reste rapide.
    $cfgTouched = Test-FilesChanged @('package.json', 'package-lock.json', 'next.config.ts',
                                      'postcss.config.mjs', 'tailwind.config.ts', 'tsconfig.json',
                                      'components.json')
    $srcTouched = @($Script:UpdateChangedFiles | Where-Object { $_ -match '^(src|public)/' }).Count -gt 0
    if ($cfgTouched -or $srcTouched) {
        if (Test-Path (Join-Path $Root '.next')) {
            Log "  code de l interface modifie : il sera reconstruit apres la mise a jour..."
            Remove-Item -Recurse -Force (Join-Path $Root '.next') -ErrorAction SilentlyContinue
        }
        $flag = Join-Path $ToolsDir 'build-echoue.flag'
        if (Test-Path $flag) {
            Remove-Item $flag -Force -ErrorAction SilentlyContinue
            Log "  (marqueur de build echoue efface : le build de la nouvelle version sera retente)"
        }
    }
}

# ── Installation portable automatique (tout dans <projet>\tools\) ───────
# Ordre de resolution pour chaque outil : 1) deja sur le PATH systeme,
# 2) deja installe dans tools\ (installation portable precedente),
# 3) telecharge puis installe dans tools\ — sans admin, sans registre,
# sans toucher au systeme : le dossier hermes reste autonome et mobile
# (disque externe ou cle USB compris).
$ToolsDir   = Join-Path $Root 'tools'
$NodeVer    = 'v22.20.0'    # LTS ; Next 16 exige Node >= 20.9
$NodeZipUrl = "https://nodejs.org/dist/$NodeVer/node-$NodeVer-win-x64.zip"
$BunZipUrl  = 'https://github.com/oven-sh/bun/releases/latest/download/bun-windows-x64.zip'
$CaddyExeUrl= 'https://caddyserver.com/api/download?os=windows&arch=amd64'   # renvoie l'exe directement

# Repertoire de tools\<outil>\ contenant l'exe (1 niveau de sous-dossier
# tolere : les zips s'extraient dans un sous-dossier nomme par l'editeur)
function Find-ExeDir([string]$toolName, [string]$exe) {
    $base = Join-Path $ToolsDir $toolName
    if (-not (Test-Path $base)) { return '' }
    $hit = Get-ChildItem -Path $base -Filter $exe -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($hit) { return $hit.DirectoryName }
    return ''
}
# Outil disponible dans l'installation portable ? Renvoie le dossier a
# mettre dans le PATH, sinon ''.
function Get-ToolDir([string]$toolName, [string]$exe) {
    $d = Find-ExeDir $toolName $exe
    if ($d) { return $d }
    return ''
}
function Invoke-Download([string]$url, [string]$outFile) {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $oldPref = $ProgressPreference
    $ProgressPreference = 'SilentlyContinue'   # la barre de progression IWB ralentit ~10x le telechargement
    try { Invoke-WebRequest -Uri $url -OutFile $outFile -UseBasicParsing }
    finally { $ProgressPreference = $oldPref }
}
function Install-ZipTool([string]$toolName, [string]$url, [string]$exe) {
    $dest = Join-Path $ToolsDir $toolName
    New-Item -ItemType Directory -Force -Path $dest | Out-Null
    $zip = Join-Path $ToolsDir "$toolName.zip"
    Log "  telechargement de $toolName (une seule fois)..."
    Invoke-Download $url $zip
    Log "  extraction de $toolName..."
    Expand-Archive -Path $zip -DestinationPath $dest -Force
    Remove-Item $zip -Force -ErrorAction SilentlyContinue
    $d = Find-ExeDir $toolName $exe
    if (-not $d) { Die "$toolName telecharge mais $exe est introuvable dans l'archive — effacez $dest et reessayez" }
    return $d
}
function Install-ExeTool([string]$toolName, [string]$url, [string]$exe) {
    $dest = Join-Path $ToolsDir $toolName
    New-Item -ItemType Directory -Force -Path $dest | Out-Null
    Log "  telechargement de $toolName (une seule fois)..."
    Invoke-Download $url (Join-Path $dest $exe)
    return $dest
}
# Execute une commande en affichant sa sortie EN DIRECT dans la fenetre
# (installations, build) puis renvoie son code de sortie.
function Invoke-Live([string]$file, [string[]]$argList, [string]$workDir) {
    $p = Start-Process -FilePath $file -ArgumentList ($argList | ForEach-Object { Quote-Arg $_ }) `
        -WorkingDirectory $workDir -NoNewWindow -Wait -PassThru
    return $p.ExitCode
}

# Installe ce qui manque (idempotent : au 2e double-clic, ne refait rien)
function Ensure-PortableSetup {
    $needInstall = -not (Test-Path (Join-Path $Root 'node_modules')) -or
                   -not (Test-Path (Join-Path $Root 'mini-services\hermes-chat\node_modules')) -or
                   -not ((Get-ToolDir 'node' 'node.exe') -or (Test-Command 'node')) -or
                   -not ((Get-ToolDir 'bun' 'bun.exe') -or (Test-Command 'bun')) -or
                   -not ((Get-ToolDir 'caddy' 'caddy.exe') -or (Test-Command 'caddy'))
    if ($needInstall) {
        Write-Host ''
        Write-Host '  ═══ PREMIER DEMARRAGE : installation automatique ═══'
        Write-Host '  Les composants manquants sont installes DANS le dossier'
        Write-Host '  hermes (sous-dossier tools\) : rien n est ecrit ailleurs,'
        Write-Host '  pas de droits admin. Comptez quelques minutes.'
        Write-Host ''
    }

    New-Item -ItemType Directory -Force -Path $ToolsDir | Out-Null

    # ── 1. Node.js (node + npm vivent dans le meme dossier) ──
    $nodeDir = ''
    if (Test-Command 'node') {
        $npmHit = Get-Command 'npm.cmd' -ErrorAction SilentlyContinue
        if ($npmHit) { $nodeDir = Split-Path -Parent $npmHit.Source }
    }
    if (-not $nodeDir) {
        $nodeDir = Get-ToolDir 'node' 'node.exe'
        if (-not $nodeDir) { $nodeDir = Install-ZipTool 'node' $NodeZipUrl 'node.exe' }
    }
    $npmCmd = Join-Path $nodeDir 'npm.cmd'
    if (-not (Test-Path $npmCmd)) { Die "npm.cmd introuvable dans $nodeDir" }
    if (-not (Test-Path (Join-Path $nodeDir 'node.exe'))) { Die "node.exe introuvable dans $nodeDir" }

    # ── 2. Bun ──
    $bunDir = ''
    if (Test-Command 'bun') { $bunDir = Split-Path -Parent (Get-Command 'bun').Source }
    if (-not $bunDir) {
        $bunDir = Get-ToolDir 'bun' 'bun.exe'
        if (-not $bunDir) { $bunDir = Install-ZipTool 'bun' $BunZipUrl 'bun.exe' }
    }
    # ── 3. Caddy ──
    $caddyDir = ''
    if (Test-Command 'caddy') { $caddyDir = Split-Path -Parent (Get-Command 'caddy').Source }
    if (-not $caddyDir) {
        $caddyDir = Get-ToolDir 'caddy' 'caddy.exe'
        if (-not $caddyDir) { $caddyDir = Install-ExeTool 'caddy' $CaddyExeUrl 'caddy.exe' }
    }

    # PATH de session : les outils portables (sous tools\) passes devant,
    # pour ce lanceur et tous ses processus enfants
    $portableDirs = @($nodeDir, $bunDir, $caddyDir) | Where-Object {
        $_ -and $_.StartsWith($ToolsDir, [StringComparison]::OrdinalIgnoreCase)
    }
    if ($portableDirs) { $env:Path = ($portableDirs -join ';') + ';' + $env:Path }
    foreach ($t in @('node', 'bun', 'caddy')) {
        if (-not (Test-Command $t)) { Die "l outil « $t » reste introuvable apres l installation" }
    }

    # ── 3bis. Mise a jour automatique depuis GitHub (AVANT dependances et
    # build : elles tiendront compte des fichiers recus) ──
    Update-FromGit

    # ── 4. Dependances npm de l interface ──
    $npmDepsChanged = Test-FilesChanged @('package.json', 'package-lock.json')
    if ((-not (Test-Path (Join-Path $Root 'node_modules'))) -or $npmDepsChanged) {
        if ($npmDepsChanged) { Log "• dependances de l interface modifiees par la mise a jour -> reinstallation (npm install)..." }
        else { Log "• installation des dependances de l interface (npm install, quelques minutes)..." }
        $code = Invoke-Live $npmCmd @('install', '--no-audit', '--no-fund') $Root
        if ($code -ne 0) { Die "npm install a echoue (code $code) — relancez, ou verifiez votre connexion" }
    }

    # ── 5. Dependances bun du mini-service ──
    $chatDir = Join-Path $Root 'mini-services\hermes-chat'
    $bunDepsChanged = Test-FilesChanged @('mini-services/hermes-chat/package.json', 'mini-services/hermes-chat/bun.lock')
    if ((-not (Test-Path (Join-Path $chatDir 'node_modules'))) -or $bunDepsChanged) {
        if ($bunDepsChanged) { Log "• dependances du mini-service modifiees par la mise a jour -> reinstallation (bun install)..." }
        else { Log "• installation des dependances du mini-service (bun install)..." }
        $code = Invoke-Live (Join-Path $bunDir 'bun.exe') @('install') $chatDir
        if ($code -ne 0) { Die "bun install a echoue (code $code) — relancez, ou verifiez votre connexion" }
    }

    # ── 6. Build de production (une seule fois, meilleur effort) ──
    # NB : on ne passe PAS par « npm run build » : son script package.json
    # utilise « cp » (Unix) et echouerait sous Windows. On fait next build
    # puis les copies static/public en PowerShell.
    Ensure-Build $nodeDir
}

function Ensure-Build([string]$nodeDir) {
    if (Test-Path (Join-Path $Root '.next\standalone\server.js')) { return }
    $flag = Join-Path $ToolsDir 'build-echoue.flag'
    if (Test-Path $flag) { Log "• build production saute (tentative precedente echouee — effacez $flag pour reessayer)"; return }
    Log "• build de production de l interface (1 a 3 minutes, une seule fois)..."
    $nextBin = Join-Path $Root 'node_modules\next\dist\bin\next'
    $code = Invoke-Live (Join-Path $nodeDir 'node.exe') @($nextBin, 'build') $Root
    if ($code -eq 0 -and (Test-Path (Join-Path $Root '.next\standalone\server.js'))) {
        # reproduit le script build du package.json (cp unix) : static + public -> standalone
        Copy-Item -Path (Join-Path $Root '.next\static') -Destination (Join-Path $Root '.next\standalone\.next\static') -Recurse -Force
        if (Test-Path (Join-Path $Root 'public')) {
            Copy-Item -Path (Join-Path $Root 'public') -Destination (Join-Path $Root '.next\standalone\public') -Recurse -Force
        }
        Log "  OK build production pret"
    } else {
        New-Item -ItemType File -Path $flag -Force | Out-Null
        Log "  ATTENTION build echoue (code $code) — l interface demarrera en mode developpement ; detail dans les messages ci-dessus"
    }
}

# ── Demarrage des composants ────────────────────────────────────────────
function Start-Chat {
    if (Test-ChatHealthy) { Log "• mini-service deja actif sur :$ChatPort (adopte)"; State-Set 'CHAT_OWNED' 0; return $true }
    if ((Test-PortBusy $ChatPort) -or (Test-PortBusy $FilesPort)) {
        Die "les ports $ChatPort/$FilesPort sont occupes par un autre programme alors que le service Hermes n'y repond pas (netstat -ano | findstr ""$ChatPort $FilesPort"")."
    }
    Log "• demarrage du mini-service (ports $ChatPort/$FilesPort)..."
    $chatScript = Join-Path $Root 'mini-services\hermes-chat\index.ts'   # chemin absolu : marque le processus comme nôtre
    $p = Start-Component 'bun' @($chatScript) (Join-Path $Root 'mini-services\hermes-chat') 'mini-service'
    State-Set 'CHAT_PID' $p.Id; State-Set 'CHAT_OWNED' 1
    if (-not (Wait-Http "http://127.0.0.1:$ChatPort/socket.io/?EIO=4&transport=polling" 200 40 'mini-service')) {
        Die "le mini-service ne repond pas — consultez $LogDir\mini-service-err.log"
    }
    return $true
}
function Start-Ui {
    $port = [int](State-Get 'UI_PORT')
    if ((Get-HttpCode "http://127.0.0.1:$port/" 4) -eq 200) {
        Log "• interface deja active sur :$port (adopte)"; State-Set 'UI_OWNED' 0; return $true
    }
    if (Test-PortBusy $port) { Die "le port $port est occupe sans servir l'interface." }
    $standalone = Join-Path $Root '.next\standalone\server.js'
    if (Test-Path $standalone) {
        Log "• demarrage de l'interface (build production) sur :$port..."
        $oldPort, $oldHost = $env:PORT, $env:HOSTNAME
        $env:PORT = "$port"; $env:HOSTNAME = '127.0.0.1'
        $p = Start-Component 'bun' @($standalone) $Root 'interface'
        if ($oldPort) { $env:PORT = $oldPort } else { Remove-Item Env:\PORT -ErrorAction SilentlyContinue }
        if ($oldHost) { $env:HOSTNAME = $oldHost } else { Remove-Item Env:\HOSTNAME -ErrorAction SilentlyContinue }
        State-Set 'UI_MODE' 'production'
    } else {
        Log "• demarrage de l'interface (mode developpement) sur :$port..."
        Log "  (le build production automatique a ete saute ou a echoue — voir tools\build-echoue.flag)"
        $nextBin = Join-Path $Root 'node_modules\next\dist\bin\next'
        $p = Start-Component 'node' @($nextBin, 'dev', '-p', "$port") $Root 'interface'
        State-Set 'UI_MODE' 'developpement'
    }
    State-Set 'UI_PID' $p.Id; State-Set 'UI_OWNED' 1
    # le premier build dev peut etre long : 120 s de marge
    if (-not (Wait-Http "http://127.0.0.1:$port/" 200 120 ("interface (" + (State-Get 'UI_MODE') + ")"))) {
        Die "l'interface ne repond pas — consultez $LogDir\interface-err.log"
    }
    return $true
}
function Start-Gateway {
    $port = [int](State-Get 'GW_PORT')
    $url = "http://127.0.0.1:$port/"
    if ((Get-HttpCode $url 4) -eq 200) {
        Log "• passerelle deja active sur :$port (adopte)"; State-Set 'GW_OWNED' 0; return $true
    }
    if (-not (Test-Command 'caddy')) {
        Die "« caddy » est introuvable et le port $port est libre. Installez-le puis relancez : winget install CaddyServer.Caddy"
    }
    if (Test-PortBusy $port) { Die "le port $port est occupe sans servir l'interface." }
    # Caddyfile genere avec les ports choisis a l'execution
    $cf = Join-Path $RuntimeDir 'Caddyfile'
    $tpl = Get-Content (Join-Path $Root 'Caddyfile') -Raw
    $tpl = $tpl -replace ':81 \{', ":$port {"
    $tpl = $tpl -replace 'localhost:3000', ("localhost:{0}" -f (State-Get 'UI_PORT'))
    Set-Content -Path $cf -Value $tpl -Encoding ASCII
    Log ("• demarrage de la passerelle Caddy sur :$port (-> interface :" + (State-Get 'UI_PORT') + ")...")
    $p = Start-Component 'caddy' @('run', '--config', $cf, '--adapter', 'caddyfile') $Root 'passerelle'
    State-Set 'GW_PID' $p.Id; State-Set 'GW_OWNED' 1
    if (-not (Wait-Http $url 200 20 'passerelle')) { Die "la passerelle ne repond pas — consultez $LogDir\passerelle-err.log" }
    return $true
}
function Open-Browser([string]$url) {
    try { Start-Process $url } catch { Log "• impossible d'ouvrir le navigateur : $url" }
    Log "• navigateur : $url"
}

# ── ARRET PROPRE ────────────────────────────────────────────────────────
function Stop-All {
    Log "Arret demande..."
    Stop-Tree 'GW_PID'   $MGw
    Stop-Tree 'UI_PID'   $MUii
    Start-Sleep -Seconds 1
    # mini-service en dernier : ses donnees sont en WAL, recuperees
    # automatiquement au demarrage suivant meme en cas d'arret force
    Stop-Tree 'CHAT_PID' $MChat
    Wait-Gone $MChat 10; Wait-Gone $MUii 10; Wait-Gone $MGw 10
    # etat vide : le verrou disparait avec la pile
    $Script:State = @{}
    Save-State
    Log "Arret termine."
}

# ── SURVEILLANCE ────────────────────────────────────────────────────────
# Sante = l'endpoint repond. PID disparu avec service qui repond ->
# re-adoption (pas de greve). Greve = service inaccessible -> arret de
# l'arbre puis relance (3 essais max), puis arret general.
function Supervise-One([string]$name, $healthyFn, $startFn, [string]$pidVar, [string]$ownedVar, [string]$marker, [ref]$strikes) {
    if ((State-Get $ownedVar) -ne '1') { return }
    if (& $healthyFn) {
        $cpid = 0; [int]::TryParse((State-Get $pidVar), [ref]$cpid) | Out-Null
        if ($cpid -gt 1 -and -not (Test-OurProcess $cpid)) {
            Log "• $name repond mais son PID a change -> re-adopte (pas de greve)"
            State-Set $ownedVar 0
        }
        return
    }
    if ($strikes.Value -ge $MaxRestarts) {
        Log "ATTENTION $name : trop de redemarrages — arret propre de tout."
        Stop-All; exit 1
    }
    $strikes.Value++
    Log "ATTENTION $name inaccessible -> redemarrage ($($strikes.Value)/$MaxRestarts)"
    Stop-Tree $pidVar $marker
    Wait-Gone $marker 5
    if ((State-Get 'UI_PORT') -and $pidVar -eq 'UI_PID') { Wait-PortFree ([int](State-Get 'UI_PORT')) 10 | Out-Null }
    & $startFn
}
function Supervise {
    $nGw = 0; $nUi = 0; $nChat = 0
    Log "Surveillance active (Ctrl-C ou fermeture de cette fenetre = arret propre)."
    try {
        while ($true) {
            Start-Sleep -Seconds 5
            Supervise-One 'passerelle'   ${function:Test-GwHealthy}   ${function:Start-Gateway} 'GW_PID'   'GW_OWNED'   $MGw   ([ref]$nGw)
            Supervise-One 'interface'    ${function:Test-UiHealthy}   ${function:Start-Ui}      'UI_PID'   'UI_OWNED'   $MUii  ([ref]$nUi)
            Supervise-One 'mini-service' ${function:Test-ChatHealthy} ${function:Start-Chat}    'CHAT_PID' 'CHAT_OWNED' $MChat ([ref]$nChat)
        }
    }
    finally {
        # Ctrl-C : PowerShell declenche le finally -> arret propre.
        if ((State-Get 'GW_OWNED') -eq '1' -or (State-Get 'UI_OWNED') -eq '1' -or (State-Get 'CHAT_OWNED') -eq '1') {
            Log "Signal recu — arret propre."
            Stop-All
        }
    }
}

# ── COMMANDES ───────────────────────────────────────────────────────────
function Show-Status {
    Load-State
    Write-Host "── Hermes Web ─────────────────────────────────────"
    if (-not (Test-Path $StateFile)) {
        Write-Host "  etat      : arrete (aucune pile enregistree)"
    } else {
        Write-Host ("  adresse   : http://127.0.0.1:{0}/" -f (State-Get 'GW_PORT'))
        Write-Host ("  interface : port {0} ({1}), mini-service : {2}/{3}" -f (State-Get 'UI_PORT'), (State-Get 'UI_MODE'), $ChatPort, $FilesPort)
        foreach ($spec in @(
            @('GW_PID',   'GW_OWNED',   'passerelle'),
            @('UI_PID',   'UI_OWNED',   'interface'),
            @('CHAT_PID', 'CHAT_OWNED', 'mini-service'))) {
            $procId = 0; [int]::TryParse((State-Get $spec[0]), [ref]$procId) | Out-Null
            if (($procId -gt 1) -and (Test-OurProcess $procId)) {
                Write-Host ("  {0} : actif (pid {1}, a nous)" -f $spec[2], $procId)
            } elseif ((State-Get $spec[1]) -eq '0') {
                Write-Host ("  {0} : actif (externe/adopte)" -f $spec[2])
            } else {
                Write-Host ("  {0} : ARRETE" -f $spec[2])
            }
        }
    }
    Write-Host "── derniers logs ($LauncherLog) ──────────────────"
    if (Test-Path $LauncherLog) { Get-Content $LauncherLog -Tail 8 }
}

function Do-Start {
    # Pile deja lancee par un lanceur precedent encore vivant ? (reponse
    # immediate, sans meme verifier les installations)
    $lpid = 0; [int]::TryParse((State-Get 'LAUNCHER_PID'), [ref]$lpid) | Out-Null
    $lproc = Get-ProcById $lpid
    if ($lproc -and ($lproc.CommandLine -match 'hermes-ui\.ps1')) {
        Log "Pile deja demarree (lanceur pid $lpid) — ouverture du navigateur uniquement."
        Open-Browser ("http://127.0.0.1:{0}/" -f (State-Get 'GW_PORT'))
        Write-Host ("Hermes Web est deja lance : http://127.0.0.1:{0}/" -f (State-Get 'GW_PORT'))
        return
    }

    # Installation portable automatique de tout ce qui manque (idempotente)
    Ensure-PortableSetup
    Initialize-JobObject

    # Verrou perime (plantage precedent) : nettoie les restes eventuels
    if (Test-Path $StateFile) {
        Log "Verrou d'une session precedente trouve — nettoyage des restes eventuels."
        Stop-Tree 'UI_PID' $MUii; Stop-Tree 'CHAT_PID' $MChat; Stop-Tree 'GW_PID' $MGw
        Start-Sleep -Seconds 1
        $Script:State = @{}; Save-State
    }

    # Choix des ports AVANT le moindre demarrage (tout ou rien)
    $gw = Pick-Port $GwPorts
    if ($gw -eq 0) { Die "aucun port libre pour la passerelle (essayes : $($GwPorts -join ' '))." }
    $ui = Pick-Port $UiPorts
    if ($ui -eq 0) { Die "aucun port libre pour l'interface (essayes : $($UiPorts -join ' '))." }
    State-Set 'GW_PORT' $gw; State-Set 'UI_PORT' $ui
    State-Set 'LAUNCHER_PID' $PID
    Log "════ Demarrage Hermes Web (passerelle :$gw, interface :$ui) ════"

    [void](Start-Chat)
    [void](Start-Ui)
    [void](Start-Gateway)
    Open-Browser "http://127.0.0.1:$gw/"

    Write-Host ''
    Write-Host '  ┌────────────────────────────────────────────────┐'
    Write-Host ("  │  Hermes Web est pret : http://127.0.0.1:$gw/")
    Write-Host '  │  Fermez cette fenetre (ou Ctrl-C) pour tout    │'
    Write-Host '  │  arreter PROPREMENT (donnees sauvegardees).    │'
    Write-Host '  └────────────────────────────────────────────────┘'
    Write-Host ''

    Supervise
}

Load-State
switch ($Action) {
    'start'   { Do-Start }
    'stop'    { Stop-All }
    'status'  { Show-Status }
    'restart' { Stop-All; Start-Sleep -Seconds 1; Do-Start }
}
