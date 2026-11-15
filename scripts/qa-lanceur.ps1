# QA lanceur (pwsh 7, Windows ou Linux) : valide la logique extraite de
# desktop/hermes-ui.ps1 sans executer le lanceur lui-meme.
#   pwsh -NoProfile -File scripts/qa-lanceur.ps1
$ErrorActionPreference = 'Stop'
function Log([string]$msg) { Write-Host "  [log] $msg" }

$fail = 0
function Check([string]$label, [bool]$ok) {
    if ($ok) { Write-Host "OK   $label" } else { Write-Host "FAIL $label"; $script:fail++ }
}

$tmpRoot = if ($env:TMPDIR) { $env:TMPDIR } elseif ($env:TEMP) { $env:TEMP } else { '/tmp' }

# ── 1. Logique du marqueur build-echoue.flag (copie conforme) ──────────
function Test-FlagLogic([string[]]$flagLines, [string]$curRev, [bool]$expectSkip) {
    $flagRev = [string]$flagLines[0]
    $flagTs = [long]0
    if ($flagLines.Count -ge 2) { [long]::TryParse([string]$flagLines[1], [ref]$flagTs) | Out-Null }
    $sameRev = ($flagRev -and $curRev -and ($flagRev -eq $curRev))
    $ageH = 99
    if ($flagTs -gt 0) { $ageH = [math]::Round(([DateTimeOffset]::UtcNow.ToUnixTimeSeconds() - $flagTs) / 3600.0) }
    return (($sameRev -and ($ageH -lt 24)) -eq $expectSkip)
}
$rev = 'abcd1234'
$old1h  = @($rev, [string]([DateTimeOffset]::UtcNow.ToUnixTimeSeconds() - 3600))
$old25h = @($rev, [string]([DateTimeOffset]::UtcNow.ToUnixTimeSeconds() - (25*3600)))
Check 'marqueur ancien format (1 ligne) -> retente'   (Test-FlagLogic @($rev) $rev $false)
Check 'marqueur vide -> retente'                       (Test-FlagLogic @('') $rev $false)
Check 'meme revision, 1 h -> saute (pas de boucle)'    (Test-FlagLogic $old1h $rev $true)
Check 'meme revision, 25 h -> retente'                 (Test-FlagLogic $old25h $rev $false)
Check 'revision differente, 1 h -> retente'            (Test-FlagLogic $old1h 'autre99' $false)
Check 'timestamp absent (0) -> retente'                (Test-FlagLogic @($rev, '0') $rev $false)

# ecriture puis relecture du marqueur (format 2 lignes)
$tmp = Join-Path $tmpRoot 'flag-test.txt'
Set-Content -Path $tmp -Value @($rev, [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()) -Encoding ASCII
$back = @(Get-Content $tmp)
Check 'relecture : revision conservee' ($back[0] -eq $rev)
$tsBack = [long]0; [long]::TryParse([string]$back[1], [ref]$tsBack) | Out-Null
Check 'relecture : timestamp parses (> 1e9)' ($tsBack -gt 1000000000)
Remove-Item $tmp -Force

# ── 2. Resolve-Tool (copie conforme + outils simules) ──────────────────
$ToolsDir = Join-Path $tmpRoot 'tools-qa'
Remove-Item $ToolsDir -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path (Join-Path $ToolsDir 'node') | Out-Null
Set-Content -Path (Join-Path $ToolsDir 'node\node.exe') -Value 'fake'
function Find-ExeDir([string]$toolName, [string]$exe) {
    $base = Join-Path $ToolsDir $toolName
    if (-not (Test-Path $base)) { return '' }
    $hit = Get-ChildItem -Path $base -Filter $exe -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($hit) { return $hit.DirectoryName }
    return ''
}
function Get-ToolDir([string]$toolName, [string]$exe) {
    $d = Find-ExeDir $toolName $exe
    if ($d) { return $d }
    return ''
}
function Install-ZipTool([string]$toolName, [string]$url, [string]$exe) { throw 'reseau coupe (simule)' }
function Install-ExeTool([string]$toolName, [string]$url, [string]$exe) { throw 'reseau coupe (simule)' }
function Resolve-Tool([string]$toolName, [string]$exe, [string]$url, [bool]$isZip) {
    $d = Get-ToolDir $toolName $exe
    if ($d) { return $d }
    try {
        if ($isZip) { return (Install-ZipTool $toolName $url $exe) }
        return (Install-ExeTool $toolName $url $exe)
    } catch {
        Log "telechargement de $toolName impossible — essai avec l outil du systeme s il existe"
        return ''
    }
}
Check 'tools\ deja rempli -> copie portable renvoyee'      ((Resolve-Tool 'node' 'node.exe' 'x' $true) -ne '')
Check 'tools\ vide + reseau coupe -> chaine vide (systeme)' ((Resolve-Tool 'bun' 'bun.exe' 'x' $true) -eq '')
Check 'exe direct (caddy) pareil'                           ((Resolve-Tool 'caddy' 'caddy.exe' 'x' $false) -eq '')

# ── 3. Constantes Job Object ───────────────────────────────────────────
Check 'LimitFlags 0x2000 -bor 0x40 = 0x2040' ((0x2000 -bor 0x40) -eq 0x2040)

Write-Host ''
if ($fail -eq 0) { Write-Host 'TOUS LES TESTS PASSENT' } else { Write-Host "$fail ECHEC(S)"; exit 1 }
