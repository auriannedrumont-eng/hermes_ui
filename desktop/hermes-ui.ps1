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
#   dependances npm/bun et build de production. Sans admin, sans registre,
#   sans ecrire hors du dossier — les caches npm/bun sont AUSSI rediriges
#   dans tools\ : il reste mobile (cle USB comprise), meme deplace sur une
#   machine vierge sans Node ni Bun. Les copies de tools\ sont ensuite
#   preferees a celles du systeme : une fois le dossier rempli, il se
#   suffit a lui-meme. Les fois suivantes, le double-clic est immediat :
#   nettoyage
#   des restes d'une session plantee AVANT toute chose (un ancien serveur
#   vivant verrouillerait .next et ferait echouer le build), verification
#   silencieuse des mises a jour GitHub (fusion rapide ; en cas d'ecart
#   local, sauvegarde des fichiers modifies puis alignement sur GitHub),
#   dependances/build refaits seulement si necessaire, puis demarrage.
#
# Sobriete processeur :
#   • l interface tourne en build de production ; le mode developpement
#     (next dev, tres gourmand en CPU) n est qu un repli signale par un
#     avertissement visible, et son build echoue est retente apres 24 h ;
#   • surveillance des composants toutes les 15 s, verifications legeres ;
#   • pile entiere en priorite BASSE (Job Object) : Hermes cede le
#     processeur a vos autres logiciels des qu ils en ont besoin.
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

# Rotation du journal : au-dela de ~512 Ko, ne garder que les 2000
# dernieres lignes (le dossier reste propre apres des mois d utilisation).
if (Test-Path $LauncherLog) {
    try {
        if ((Get-Item $LauncherLog).Length -gt 524288) {
            (Get-Content $LauncherLog -Tail 2000) | Set-Content -Path $LauncherLog -Encoding UTF8
        }
    } catch { }
}

# Ports fixes imposes par le client (constantes SERVICE_PORT/FILES_PORT)
$ChatPort = 3003; $FilesPort = 3004
# Ordre de preference pour les ports mobiles
$GwPorts = @(81, 8081, 8181, 18081)
$UiPorts = @(3000, 3001, 3002, 3005)
$MaxRestarts = 3
$Script:SupCycle = 0   # cycle de surveillance courant (voir Supervise-One)

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
        # 0x2000 = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE (arbre tue si le
        # lanceur meurt) ; 0x40 = JOB_OBJECT_LIMIT_PRIORITY_CLASS (la
        # priorite fixee ci-dessous s applique a toute la pile).
        # 0x4000 = BELOW_NORMAL_PRIORITY_CLASS : Hermes cede le processeur
        # a vos autres logiciels des qu ils en ont besoin (machine moins
        # chaude, ventilateurs plus discrets).
        $info.LimitFlags = 0x2000 -bor 0x40
        $info.PriorityClass = 0x4000
        $Script:JobHandle = [JobKill]::CreateJobObject([IntPtr]::Zero, $null)
        [void][JobKill]::SetInformationJobObject($Script:JobHandle, 1, [ref]$info, [Runtime.InteropServices.Marshal]::SizeOf($info))
        Log "• Job Object noyau actif (arbre entier arrete si cette fenetre se ferme ; priorite basse : Hermes cede le processeur a vos autres logiciels)"
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
# sur GitHub ; le cas echeant le dossier avance au dernier commit. Fusion
# RAPIDE quand c est possible (fast-forward) ; sinon (fichiers locaux
# modifies, fichiers parasites d'une extraction zip, historique local
# different) les fichiers locaux differents sont COPIES EN SAUVEGARDE
# dans desktop\runtime\maj-sauvegarde-<date>\ puis le dossier est aligne
# sur GitHub — si la sauvegarde echoue, on ne touche a rien (version
# locale conservee). Dependances reinstallees et interface reconstruite
# UNIQUEMENT si les fichiers concernes ont change (un push de
# documentation seule ne reconstruit rien). Jamais bloquant : git absent,
# dossier non clone, pas de reseau, connexion GitHub refusee -> message +
# demarrage avec la version presente. La premiere verification peut ouvrir
# une fenetre GitHub demandant de se connecter : c est le gestionnaire
# d identifiants de git (Git Credential Manager), il ne la rouvrira plus
# ensuite.
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

# Revision git courante du dossier ('' si git absent ou dossier non clone).
function Get-RepoRevision {
    if (-not (Test-Command 'git')) { return '' }
    if (-not (Test-Path (Join-Path $Root '.git'))) { return '' }
    $r = Invoke-Git @('rev-parse', 'HEAD')
    if ($r.Code -ne 0) { return '' }
    return $r.Text.Trim()
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
        # Fusion directe impossible : fichiers locaux modifies, fichiers
        # parasites d une extraction zip ou historique local different
        # (anciens patchs). Le depot GitHub est la reference du projet :
        # on met les fichiers locaux differents de cote (copie de securite
        # dans desktop\runtime\), puis on aligne le dossier sur GitHub.
        # Echec de la sauvegarde -> on ne touche a rien.
        Log "  fusion directe impossible (fichiers locaux modifies ou historique local different)..."
        $aligned = $false
        try {
            # Liste des fichiers a sauvegarder : modifications en cours et
            # fichiers non suivis (status) + fichiers differents ou absents
            # cote GitHub (commits locaux) — tout ce que l alignement
            # remplacerait ou ferait disparaitre.
            $paths = @{}
            $st = Invoke-Git @('status', '--porcelain')
            if ($st.Code -eq 0) {
                foreach ($l in ($st.Text -split "`n")) {
                    # NB : TrimEnd seulement — l espace de TETE fait partie du
                    # format (XY<espace>chemin), un Trim complet decalerait
                    # le chemin d un caractere.
                    $l = $l.TrimEnd()
                    if ($l.Length -gt 3) {
                        $p = $l.Substring(3)
                        if ($p -match ' -> ') { $p = ($p -split ' -> ')[-1] }
                        $paths[$p] = $true
                    }
                }
            }
            $df = Invoke-Git @('diff', '--name-status', 'HEAD', $upstream)
            if ($df.Code -eq 0) {
                foreach ($l in ($df.Text -split "`n")) {
                    $l = $l.Trim()
                    if ($l) {
                        $f = $l -split "`t"
                        if ($f.Count -ge 2 -and ($f[0] -match '^(M|D)')) {
                            $p = $f[-1]
                            if ($p -match ' -> ') { $p = ($p -split ' -> ')[-1] }
                            $paths[$p] = $true
                        }
                    }
                }
            }
            if ($paths.Count -gt 0) {
                $backupDir = Join-Path $RuntimeDir ('maj-sauvegarde-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
                New-Item -ItemType Directory -Force -Path $backupDir | Out-Null
                foreach ($p in @($paths.Keys)) {
                    $src = Join-Path $Root $p
                    if (Test-Path $src -PathType Leaf) {
                        $dst = Join-Path $backupDir $p
                        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dst) | Out-Null
                        Copy-Item -Path $src -Destination $dst -Force -ErrorAction SilentlyContinue
                    } elseif (Test-Path $src -PathType Container) {
                        # dossier entier (ex. repertoire parasite d une extraction)
                        $dst = Join-Path $backupDir ($p.TrimEnd('\','/'))
                        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dst) | Out-Null
                        Copy-Item -Path $src -Destination $dst -Recurse -Force -ErrorAction SilentlyContinue
                    }
                }
                @(
                    'Fichiers mis de cote par la mise a jour automatique d Hermes Web.',
                    ('Date : ' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')),
                    'La version de GitHub a ete appliquee au dossier ; ces copies',
                    'locales (vos modifications d avant la mise a jour) sont conservees ici.'
                ) | Set-Content -Path (Join-Path $backupDir 'LISEZMOI.txt') -Encoding ASCII
                Log ("  sauvegarde : {0} fichier(s) copies dans desktop\runtime\{1}" -f $paths.Count, (Split-Path -Leaf $backupDir))
            }
            $r2 = Invoke-Git @('reset', '--hard', $upstream)
            if ($r2.Code -eq 0) { $aligned = $true }
        } catch { }
        if (-not $aligned) {
            Log "  ATTENTION : nouvelle version disponible mais non appliquee — version locale conservee"
            return
        }
        Log "  version GitHub appliquee (dossier aligne sur le depot distant)"
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
# Ordre de resolution pour chaque outil : 1) deja installe dans tools\
# (installation portable precedente : le dossier se suffit a lui-meme),
# 2) telecharge puis installe dans tools\ — MEME si le systeme possede
# deja l outil, pour que le dossier reste complet une fois deplace sur
# une machine vierge ; 3) a defaut de reseau, copie du PATH systeme.
# Sans admin, sans registre, sans toucher au systeme : le dossier hermes
# reste autonome et mobile (disque externe ou cle USB compris).
$ToolsDir   = Join-Path $Root 'tools'
$NodeVer    = 'v22.20.0'    # LTS ; Next 16 exige Node >= 20.9
$NodeZipUrl = "https://nodejs.org/dist/$NodeVer/node-$NodeVer-win-x64.zip"
$BunZipUrl  = 'https://github.com/oven-sh/bun/releases/latest/download/bun-windows-x64.zip'
$CaddyExeUrl= 'https://caddyserver.com/api/download?os=windows&arch=amd64'   # renvoie l'exe directement
$ChromeZipUrl= 'https://storage.googleapis.com/chrome-for-testing-public/143.0.7499.4/win64/chrome-headless-shell-win64.zip'   # rendu PNG/PDF des artefacts et partages
$FfmpegZipUrls = @(   # transcription vocale (conversion WAV) : miroir GitHub rapide d'abord, gyan.dev en repli (serveur lent sur certains reseaux)
    'https://github.com/BtbN/FFmpeg-Builds/releases/latest/download/ffmpeg-master-latest-win64-gpl.zip',
    'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip'
)

# Tout ce que les outils ecrivent reste DANS le dossier : les caches npm
# et bun (qui vivent par defaut dans le profil Windows) sont rediriges
# vers tools\, et la telemetrie de Next.js est desactivee.
$env:npm_config_cache      = Join-Path $ToolsDir 'npm-cache'
$env:BUN_INSTALL_CACHE_DIR = Join-Path $ToolsDir 'bun-cache'
$env:NEXT_TELEMETRY_DISABLED = '1'

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
# Telechargement avec progression en direct et garde-fous. curl.exe (livre
# avec Windows 10/11) est prefere : rapide, reessaye tout seul, et abandonne
# un serveur qui ne repond plus (moins de 10 Ko/s pendant 30 s) — c'etait le
# blocage du telechargement ffmpeg sur gyan.dev. A defaut de curl,
# Invoke-WebRequest (toujours disponible, mais sans garde-fou).
function Invoke-Download([string]$url, [string]$outFile) {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $curl = Get-Command 'curl.exe' -ErrorAction SilentlyContinue
    if ($curl) {
        $cArgs = @('-L', '--fail', '--retry', '2', '--connect-timeout', '20',
                   '--speed-time', '30', '--speed-limit', '10240', '-sS',
                   '-o', (Quote-Arg $outFile), (Quote-Arg $url))
        # Le curl de Windows (Schannel) verifie la revocation des
        # certificats, ce qui echoue derriere certains proxys d'entreprise.
        $ver = (& $curl --version) -join ' '
        if ($ver -match 'Schannel') { $cArgs = @('--ssl-no-revoke') + $cArgs }
        $p = Start-Process -FilePath $curl.Source -ArgumentList $cArgs -NoNewWindow -PassThru
        $lastMb = 0
        while (-not $p.HasExited) {
            Start-Sleep -Seconds 3
            if (Test-Path $outFile) {
                $mb = [math]::Round((Get-Item $outFile).Length / 1MB)
                if ($mb -ge ($lastMb + 10)) { $lastMb = $mb; Log ("    ... {0} Mo" -f $mb) }
            }
        }
        if ($p.ExitCode -eq 0 -and (Test-Path $outFile) -and (Get-Item $outFile).Length -gt 0) { return $true }
        Log ("    (telechargement curl echoue, code {0} — essai d'une autre methode)" -f $p.ExitCode)
    }
    $oldPref = $ProgressPreference
    $ProgressPreference = 'SilentlyContinue'   # la barre de progression IWB ralentit ~10x le telechargement
    try { Invoke-WebRequest -Uri $url -OutFile $outFile -UseBasicParsing; return $true }
    catch { Log ("    (telechargement impossible : {0})" -f $_.Exception.Message); return $false }
    finally { $ProgressPreference = $oldPref }
}
# Extrait une archive et verifie que l'exe attendu y figure ; renvoie $false
# si l'archive est corrompue (telechargement interrompu, mauvaise archive).
function Try-ExtractZip([string]$zip, [string]$dest, [string]$toolName, [string]$exe) {
    try { Expand-Archive -Path $zip -DestinationPath $dest -Force }
    catch {
        Log ("    archive inexploitable ({0})" -f $_.Exception.Message)
        return $false
    }
    return [bool](Find-ExeDir $toolName $exe)
}
function Install-ZipTool([string]$toolName, [string[]]$urls, [string]$exe) {
    $dest = Join-Path $ToolsDir $toolName
    New-Item -ItemType Directory -Force -Path $dest | Out-Null
    $zip = Join-Path $ToolsDir "$toolName.zip"
    $part = "$zip.part"
    # Une archive deja presente dans tools\ (deposee a la main, ou restee la
    # lors d'un arret pendant l'extraction) est utilisee si elle est bonne :
    # c'est aussi le moyen de contourner un telechargement qui echoue.
    if (Test-Path $zip) {
        Log "  archive $toolName.zip deja presente dans tools\ : utilisation..."
        if (Try-ExtractZip $zip $dest $toolName $exe) {
            Remove-Item $zip -Force -ErrorAction SilentlyContinue
            return (Find-ExeDir $toolName $exe)
        }
        Log "    -> archive remplacee par un nouveau telechargement"
        Remove-Item $zip -Force -ErrorAction SilentlyContinue
    }
    foreach ($u in $urls) {
        $srcHost = ([regex]::Match($u, '^https?://([^/]+)/')).Groups[1].Value
        Log ("  telechargement de {0} depuis {1} (une seule fois ; l'archive peut faire 100 a 200 Mo)..." -f $toolName, $srcHost)
        if (Invoke-Download $u $part) {
            Log "  extraction de $toolName..."
            Move-Item -Path $part -Destination $zip -Force
            if (Try-ExtractZip $zip $dest $toolName $exe) {
                Remove-Item $zip -Force -ErrorAction SilentlyContinue
                return (Find-ExeDir $toolName $exe)
            }
        }
        Remove-Item $part -Force -ErrorAction SilentlyContinue
    }
    throw ("{0} : telechargement impossible — vous pouvez deposer vous-meme l'archive ZIP dans tools\{0}.zip puis relancer" -f $toolName)
}
function Install-ExeTool([string]$toolName, [string[]]$urls, [string]$exe) {
    $dest = Join-Path $ToolsDir $toolName
    New-Item -ItemType Directory -Force -Path $dest | Out-Null
    $final = Join-Path $dest $exe
    $part  = "$final.part"
    foreach ($u in $urls) {
        Log "  telechargement de $toolName (une seule fois)..."
        # telecharge en .part puis renomme : un telechargement interrompu ne
        # laissera jamais un exe incomplet qui serait pris pour le bon au
        # demarrage suivant.
        if (Invoke-Download $u $part) {
            Move-Item -Path $part -Destination $final -Force
            return $dest
        }
        Remove-Item $part -Force -ErrorAction SilentlyContinue
    }
    throw "$toolName : telechargement impossible depuis toutes les sources"
}

# Resout un outil : copie portable de tools\ si presente, sinon
# telechargement dans tools\ ; renvoie '' si le telechargement echoue
# (l appelant se rabattra sur la copie systeme eventuelle).
function Resolve-Tool([string]$toolName, [string]$exe, [string[]]$urls, [bool]$isZip) {
    $d = Get-ToolDir $toolName $exe
    if ($d) { return $d }
    try {
        if ($isZip) { return (Install-ZipTool $toolName $urls $exe) }
        return (Install-ExeTool $toolName $urls $exe)
    } catch {
        Log "  telechargement de $toolName impossible ($($_.Exception.Message)) — essai avec l outil du systeme s il existe"
        return ''
    }
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
                   -not (Get-ToolDir 'node' 'node.exe') -or
                   -not (Get-ToolDir 'bun' 'bun.exe') -or
                   -not (Get-ToolDir 'caddy' 'caddy.exe') -or
                   -not (Get-ToolDir 'chrome-headless-shell' 'chrome-headless-shell.exe') -or
                   -not (Get-ToolDir 'ffmpeg' 'ffmpeg.exe')
    if ($needInstall) {
        Write-Host ''
        Write-Host '  ═══ PREMIER DEMARRAGE : installation automatique ═══'
        Write-Host '  Les composants manquants sont installes DANS le dossier'
        Write-Host '  hermes (sous-dossier tools\) : rien n est ecrit ailleurs,'
        Write-Host '  pas de droits admin. Comptez quelques minutes.'
        Write-Host ''
    }

    New-Item -ItemType Directory -Force -Path $ToolsDir | Out-Null

    # ── 0. Mise a jour automatique depuis GitHub (TOUT D ABORD : les sources
    # de telechargement des outils ci-dessous sont celles du code le plus
    # recent, et dependances/build tiendront compte des fichiers recus) ──
    Update-FromGit

    # ── 1. Node.js (node + npm vivent dans le meme dossier) ──
    # tools\ d abord (dossier autonome), telechargement sinon, copie
    # systeme en tout dernier recours (reseau absent).
    $nodeDir = Resolve-Tool 'node' 'node.exe' $NodeZipUrl $true
    if (-not $nodeDir -and (Test-Command 'node')) {
        $npmHit = Get-Command 'npm.cmd' -ErrorAction SilentlyContinue
        if ($npmHit) { $nodeDir = Split-Path -Parent $npmHit.Source }
    }
    if (-not $nodeDir) { Die "Node.js (avec npm) introuvable : telechargement impossible et node complet absent du systeme" }
    $npmCmd = Join-Path $nodeDir 'npm.cmd'
    if (-not (Test-Path $npmCmd)) { Die "npm.cmd introuvable dans $nodeDir" }
    if (-not (Test-Path (Join-Path $nodeDir 'node.exe'))) { Die "node.exe introuvable dans $nodeDir" }

    # ── 2. Bun ──
    $bunDir = Resolve-Tool 'bun' 'bun.exe' $BunZipUrl $true
    if (-not $bunDir -and (Test-Command 'bun')) { $bunDir = Split-Path -Parent (Get-Command 'bun').Source }
    if (-not $bunDir) { Die "Bun introuvable : telechargement impossible et bun absent du systeme" }

    # ── 3. Caddy ──
    $caddyDir = Resolve-Tool 'caddy' 'caddy.exe' $CaddyExeUrl $false
    if (-not $caddyDir -and (Test-Command 'caddy')) { $caddyDir = Split-Path -Parent (Get-Command 'caddy').Source }
    if (-not $caddyDir) { Die "Caddy introuvable : telechargement impossible et caddy absent du systeme" }

    # PATH de session : les outils portables (sous tools\) passes devant,
    # pour ce lanceur et tous ses processus enfants
    $portableDirs = @($nodeDir, $bunDir, $caddyDir) | Where-Object {
        $_ -and $_.StartsWith($ToolsDir, [StringComparison]::OrdinalIgnoreCase)
    }
    if ($portableDirs) { $env:Path = ($portableDirs -join ';') + ';' + $env:Path }
    foreach ($t in @('node', 'bun', 'caddy')) {
        if (-not (Test-Command $t)) { Die "l outil « $t » reste introuvable apres l installation" }
    }

    # ── 3ter. chrome-headless-shell (rendu PNG/PDF : vignettes des artefacts,
    # documents des conversations partagees) — le mini-service lit d'abord la
    # variable CHROME_HEADLESS_PATH : on la regle sur la copie portable. ──
    $chromeDir = Resolve-Tool 'chrome-headless-shell' 'chrome-headless-shell.exe' $ChromeZipUrl $true
    $chromeExe = ''
    if ($chromeDir) { $chromeExe = Join-Path $chromeDir 'chrome-headless-shell.exe' }
    if (-not $chromeExe -and $env:LOCALAPPDATA) {
        # repli : un cache Playwright deja present sur la machine
        $pwDir = Join-Path $env:LOCALAPPDATA 'ms-playwright'
        if (Test-Path $pwDir) {
            $hit = Get-ChildItem -Path $pwDir -Filter 'chrome-headless-shell.exe' -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
            if ($hit) { $chromeExe = $hit.FullName }
        }
    }
    if ($chromeExe) { $env:CHROME_HEADLESS_PATH = $chromeExe }
    else { Log "  ATTENTION : chrome-headless-shell introuvable — vignettes/PDF/partages desactives ; le reste de l application fonctionne" }

    # ── 3quater. ffmpeg (transcription vocale : conversion des enregistrements
    # en WAV avant l appel ASR). Fonction optionnelle : absent, l application
    # demarre quand meme et la dictee est simplement indisponible. ──
    $ffDir = Resolve-Tool 'ffmpeg' 'ffmpeg.exe' $FfmpegZipUrls $true
    if (-not $ffDir -and (Test-Command 'ffmpeg')) { $ffDir = Split-Path -Parent (Get-Command 'ffmpeg').Source }
    if ($ffDir -and (Test-Path (Join-Path $ffDir 'ffmpeg.exe'))) { $env:Path = "$ffDir;$env:Path" }
    else { Log "  ATTENTION : ffmpeg introuvable — transcription vocale indisponible ; le reste de l application fonctionne" }

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
    if (Test-Path $flag) {
        # Le marqueur memorise la revision git ET l heure de la tentative
        # qui avait echoue : une meme version ne sera pas retestee en
        # boucle pendant 24 h, mais une version nouvelle — ou une tentative
        # vieille de plus de 24 h — a droit a une nouvelle chance. Le mode
        # developpement qui resulte d un build echoue chauffe fortement le
        # processeur : il ne doit jamais devenir permanent.
        $flagLines = @()
        try { $flagLines = @(Get-Content $flag -ErrorAction SilentlyContinue) } catch { }
        $flagRev = [string]$flagLines[0]
        $flagTs = [long]0
        if ($flagLines.Count -ge 2) { [long]::TryParse([string]$flagLines[1], [ref]$flagTs) | Out-Null }
        $curRev = Get-RepoRevision
        $sameRev = ($flagRev -and $curRev -and ($flagRev -eq $curRev))
        $ageH = 99
        if ($flagTs -gt 0) { $ageH = [math]::Round(([DateTimeOffset]::UtcNow.ToUnixTimeSeconds() - $flagTs) / 3600.0) }
        if ($sameRev -and ($ageH -lt 24)) {
            Log "• build production saute (tentative precedente echouee il y a $ageH h — effacez $flag pour reessayer tout de suite)"
            return
        }
        Remove-Item $flag -Force -ErrorAction SilentlyContinue
        if ($sameRev) { Log "• build retente : la tentative precedente date de plus de 24 h" }
        else { Log "• build retente : la version a change depuis l echec precedent" }
    }
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
        $revForFlag = Get-RepoRevision
        $tsForFlag  = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
        Set-Content -Path $flag -Value @($revForFlag, $tsForFlag) -Encoding ASCII
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
        Write-Host ''
        Write-Host '  ╔══════════════════════════════════════════════════════════════════╗' -ForegroundColor Yellow
        Write-Host '  ║  ATTENTION : interface en mode DEVELOPPEMENT                     ║' -ForegroundColor Yellow
        Write-Host '  ║  Ce mode sollicite fortement le processeur (ventilateur) et     ║' -ForegroundColor Yellow
        Write-Host '  ║  ralentit l interface. Le build de production sera retente      ║' -ForegroundColor Yellow
        Write-Host '  ║  automatiquement (au plus une fois par 24 h). Pour forcer       ║' -ForegroundColor Yellow
        Write-Host '  ║  maintenant : fermez, effacez tools\build-echoue.flag,          ║' -ForegroundColor Yellow
        Write-Host '  ║  relancez.                                                        ║' -ForegroundColor Yellow
        Write-Host '  ╚══════════════════════════════════════════════════════════════════╝' -ForegroundColor Yellow
        Write-Host ''
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
        # Verification d adoption allegee : une fois par minute environ
        # (1 cycle sur 4), pas a chaque cycle — les requetes WMI ont un
        # cout, et la surveillance tourne en continu, machine chaude.
        if (($Script:SupCycle % 4) -eq 0) {
            $cpid = 0; [int]::TryParse((State-Get $pidVar), [ref]$cpid) | Out-Null
            if ($cpid -gt 1 -and -not (Test-OurProcess $cpid)) {
                Log "• $name repond mais son PID a change -> re-adopte (pas de greve)"
                State-Set $ownedVar 0
            }
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
    Log "Surveillance active, verifications toutes les 15 s (Ctrl-C ou fermeture de cette fenetre = arret propre)."
    try {
        while ($true) {
            Start-Sleep -Seconds 15
            $Script:SupCycle++
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

    # Verrou perime (plantage precedent) : nettoie les restes eventuels
    # AVANT la mise a jour et le build — un ancien serveur encore vivant
    # garderait .next verrouille et ferait echouer la reconstruction
    # (erreur EBUSY observee : rmdir de .next\standalone refuse).
    if (Test-Path $StateFile) {
        Log "Verrou d'une session precedente trouve — nettoyage des restes eventuels."
        Stop-Tree 'GW_PID'   $MGw
        Stop-Tree 'UI_PID'   $MUii
        Stop-Tree 'CHAT_PID' $MChat
        Wait-Gone $MUii 10; Wait-Gone $MChat 10; Wait-Gone $MGw 10
        Start-Sleep -Seconds 1
        $Script:State = @{}; Save-State
    }

    # Installation portable automatique de tout ce qui manque (idempotente)
    Ensure-PortableSetup
    Initialize-JobObject

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
