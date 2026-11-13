# ─────────────────────────────────────────────────────────────────────────
# Hermes Web — lanceur bureau (Windows)
# Demarre la pile complete (mini-service chat, interface Next, passerelle
# Caddy), ouvre le navigateur, puis surveille les composants.
#
# Usage (normalement via Hermes-Web.bat, pas en ligne de commande) :
#   hermes-ui.ps1 start | stop | status | restart
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
# Fichier volontairement en ASCII (compatibilite PowerShell 5.1 sans BOM).
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
function Check-Deps {
    if (-not (Test-Command 'bun'))  { Die "« bun » est introuvable. Installez-le puis relancez : winget install Oven-sh.Bun" }
    if (-not (Test-Command 'node')) { Die "« node » est introuvable. Installez-le puis relancez : winget install OpenJS.NodeJS" }
    if (-not (Test-Path (Join-Path $Root 'mini-services\hermes-chat\index.ts'))) { Die "projet introuvable autour de $Root" }
    if (-not (Test-Path (Join-Path $Root 'node_modules'))) { Die "node_modules absent — faites un clic droit sur Installer-Hermes.bat n'est pas suffisant : ouvrez un terminal dans $Root et lancez npm install" }
    if (-not (Test-Path (Join-Path $Root 'mini-services\hermes-chat\node_modules'))) { Die "dependances du mini-service absentes — lancez bun install dans $Root\mini-services\hermes-chat" }
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
        Log "  (pour le mode production : npm run build une fois, puis relancez)"
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
    Check-Deps
    Initialize-JobObject

    # Pile deja lancee par un lanceur precedent encore vivant ?
    $lpid = 0; [int]::TryParse((State-Get 'LAUNCHER_PID'), [ref]$lpid) | Out-Null
    $lproc = Get-ProcById $lpid
    if ($lproc -and ($lproc.CommandLine -match 'hermes-ui\.ps1')) {
        Log "Pile deja demarree (lanceur pid $lpid) — ouverture du navigateur uniquement."
        Open-Browser ("http://127.0.0.1:{0}/" -f (State-Get 'GW_PORT'))
        Write-Host ("Hermes Web est deja lance : http://127.0.0.1:{0}/" -f (State-Get 'GW_PORT'))
        return
    }
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
