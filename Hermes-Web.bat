@echo off
setlocal EnableExtensions
rem ---------------------------------------------------------------------
rem  Hermes Web -- ICONE UNIQUE (a la racine du dossier F:\hermes_web).
rem  TOUT fonctionne depuis ce seul fichier, au double-clic :
rem    * au lancement, un menu s'affiche (choix en tapant 1/2/3 + Entree,
rem      ou directement : "Hermes-Web.bat 2") :
rem        1 = Demarrer   (defaut) : arret d'une pile restante, mise a
rem            jour GitHub, demarrage complet, ouverture du navigateur.
rem            La fenetre RESTE OUVERTE tant qu'Hermes tourne : la fermer
rem            (ou Ctrl-C) arrete proprement toute la pile.
rem        2 = Arreter : arret propre de tout ce qu'Hermes a demarre.
rem        3 = Raccourcis : cree/retire « Hermes Web » sur le Bureau et
rem            dans le menu Demarrer (retire aussi l'Arret s'il existe).
rem    * aucun autre .bat n'est necessaire ; aucune ligne a taper ;
rem      aucun droit admin ; rien d'ecrit hors du dossier.
rem ---------------------------------------------------------------------
title Hermes Web

rem -- Action directe : "Hermes-Web.bat 2" = arreter, "3" = raccourcis,
rem    "1" ou sans argument = demarrer (le menu s'affiche quand meme
rem    quelques secondes pour informer, puis demarre seul).
set "ACTION=%~1"

:menu
cls
echo.
echo   ==============================================
echo     Hermes Web  -  que voulez-vous faire ?
echo   ==============================================
echo.
echo     1. Demarrer Hermes Web   (defaut)
echo     2. Arreter Hermes Web
echo     3. Raccourcis Bureau : creer / retirer
echo.
if defined ACTION echo   Choix deja fixe par la ligne de commande : %ACTION%
set /p "CHOIX=  Votre choix (Entree = 1) : "
if not defined CHOIX set "CHOIX=1"
if "%CHOIX%"=="1" set "ACTION=1"
if "%CHOIX%"=="2" set "ACTION=2"
if "%CHOIX%"=="3" set "ACTION=3"
if not defined ACTION (
  echo   Choix non valide : "%CHOIX%" -- tapez 1, 2 ou 3.
  timeout /t 2 >nul
  goto menu
)

if "%ACTION%"=="2" goto arreter
if "%ACTION%"=="3" goto raccourcis

:demarrer
rem -- Mise a jour git AVANT le demarrage : le lanceur hermes-ui.ps1 sait
rem    deja le faire (section (85)/(86)), on passe simplement la main.
rem    Le lanceur est le SEUL responsable : demarrage, surveillance,
rem    arret propre a la fermeture de cette fenetre.
title Hermes Web - fermez cette fenetre pour tout arreter
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0desktop\hermes-ui.ps1" start
if errorlevel 1 pause
exit /b 0

:arreter
rem -- Arret propre : ne coupe QUE les processus qu'Hermes a demarres
rem    (validation par chemin du projet + Job Object). Meme mecanique
rem    que la fermeture de la fenetre de demarrage.
title Hermes Web - Arret propre
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0desktop\hermes-ui.ps1" stop
echo.
echo   Hermes Web est arrete.
timeout /t 3 >nul
exit /b 0

:raccourcis
rem -- Cree/retire les raccourcis Bureau + menu Demarrer. Le raccourci
rem    d'arret pointe vers CE fichier avec l'argument 2 : un seul .bat.
title Hermes Web - Raccourcis
set "HELPER=%~dp0desktop\install-helper.ps1"
if not exist "%HELPER%" (
  echo   [ERREUR] desktop\install-helper.ps1 introuvable.
  pause
  exit /b 1
)
echo   Creation des raccourcis « Hermes Web » (Bureau + menu Demarrer)...
powershell -NoProfile -ExecutionPolicy Bypass -File "%HELPER%"
echo.
echo   Le raccourci « Hermes Web - Arret » existant est remplace par la
echo   version qui appelle CE fichier (argument 2). Retrait complet :
echo   relancez ce fichier, choix 3, puis suivez le menu du helper.
powershell -NoProfile -ExecutionPolicy Bypass -Command "try { $d=[Environment]::GetFolderPath('Desktop'); Remove-Item (Join-Path $d 'Hermes Web - Arret.lnk') -ErrorAction SilentlyContinue; $sm=Join-Path ([Environment]::GetFolderPath('Programs')) 'Hermes Web'; if (Test-Path (Join-Path $sm 'Hermes Web - Arret.lnk')) { Remove-Item (Join-Path $sm 'Hermes Web - Arret.lnk') -ErrorAction SilentlyContinue } } catch {}"
echo   Termine. Vous pouvez fermer cette fenetre.
timeout /t 4 >nul
exit /b 0
