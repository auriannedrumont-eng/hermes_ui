@echo off
setlocal EnableExtensions
rem ---------------------------------------------------------------------
rem  Hermes Web -- ICONE UNIQUE (a la racine du dossier F:\hermes_web).
rem  Loi « lanceur autonome » (24/11) : le double-clic LANCE, point.
rem  Aucun menu, aucune question : demarrage (ou reprise de la pile deja
rem  vivante + focus sur l'onglet existant). La fenetre RESTE OUVERTE tant
rem  qu'Hermes tourne : la fermer (ou Ctrl-C) arrete proprement toute la pile.
rem
rem  Arret volontaire : fermez cette fenetre — c'est tout. (L'ancien choix
rem  « 2 = Arreter » reste disponible en ligne de commande :
rem  "Hermes-Web.bat" stop — pour un raccourci d'arret, par exemple.)
rem  Aucun droit admin ; rien d'ecrit hors du dossier.
rem ---------------------------------------------------------------------
title Hermes Web

if /i "%~1"=="stop" (
  title Hermes Web - Arret propre
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0desktop\hermes-ui.ps1" stop
  echo.
  echo   Hermes Web est arrete.
  timeout /t 3 >nul
  exit /b 0
)

rem -- Demarrage (le seul comportement) : le lanceur hermes-ui.ps1 est le
rem    SEUL responsable : mise a jour GitHub, demarrage, surveillance,
rem    arret propre a la fermeture de cette fenetre.
title Hermes Web - fermez cette fenetre pour tout arreter
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0desktop\hermes-ui.ps1" start
if errorlevel 1 pause
exit /b 0
