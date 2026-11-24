
$ErrorActionPreference = 'Stop'
$Root = 'F:\hermes_web'
$env:HERMES_HOME = 'F:\hermes_web\data'
$maison = if ($env:HERMES_HOME) { $env:HERMES_HOME } else { Join-Path $Root 'data' }
$envFile = Join-Path $maison '.env'
$cfgFile = Join-Path $maison 'config.yaml'
Write-Output ("envFile: $envFile taille: " + (Get-Item $envFile).Length)
if (-not (Test-Path $envFile) -or ((Get-Item $envFile -ErrorAction SilentlyContinue).Length -le 10)) {
    Write-Output 'branche: cles manquantes (annonce)'
}
$providerDefaut = 'zai'; $modelDefaut = 'glm-5.3-flash'
$aRegler = $true
if (Test-Path $cfgFile) {
    $cfgTxt = Get-Content $cfgFile -Raw
    if ($cfgTxt -match '(?m)^model:\s*$') {
        $apres = ($cfgTxt -split '(?m)^model:\s*$', 2)[1]
        if ($apres -match '(?m)^\s{2,}provider:\s*\S' -and $apres -match '(?m)^\s{2,}model:\s*\S') { $aRegler = $false }
    }
}
Write-Output ("aRegler: $aRegler (attendu: False, config deja reglee)")
