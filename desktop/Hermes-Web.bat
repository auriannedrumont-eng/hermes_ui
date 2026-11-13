@echo off
rem ── Hermes Web — demarrage (double-clic) ─────────────────────────────
rem Cette fenetre reste ouverte tant qu'Hermes tourne : la fermer arrete
rem toute la pile proprement (Job Object noyau + arret ordonne sur Ctrl-C).
title Hermes Web - fermez cette fenetre pour tout arreter
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0hermes-ui.ps1" start
if errorlevel 1 pause
