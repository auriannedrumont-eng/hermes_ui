@echo off
rem -- Hermes Web -- installateur des raccourcis Bureau (double-clic) ----
rem Cree " Hermes Web " et " Hermes Web - Arret " sur le Bureau et dans
rem le menu Demarrer. Aucune ligne de commande a taper.
rem Pour retirer les raccourcis : Installer-Hermes.bat --remove
title Hermes Web - Installation des raccourcis
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-helper.ps1" %*
pause
