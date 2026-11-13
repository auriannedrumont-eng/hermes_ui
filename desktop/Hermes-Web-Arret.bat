@echo off
rem ── Hermes Web — arret propre (double-clic) ──────────────────────────
rem N'arrete que les processus qu'Hermes a demarres dans ce projet.
title Hermes Web - Arret propre
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0hermes-ui.ps1" stop
pause
