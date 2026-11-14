@echo off
rem ---------------------------------------------------------------------
rem  Hermes Web -- ICONE UNIQUE, a la racine du dossier hermes.
rem  Un seul double-clic fait tout :
rem    1er lancement  : installe automatiquement tout ce qui manque DANS
rem                     ce dossier (sous-dossier tools\ : Node.js, Bun,
rem                     Caddy, dependances, build) -- aucune ligne a taper,
rem                     aucun droit admin, rien d'ecrit hors du dossier ;
rem    lancements suivants : met a jour le dossier depuis GitHub (si le
rem                     dossier est un clone git -- jamais bloquant),
rem                     demarre Hermes et ouvre le navigateur.
rem  Fermer cette fenetre (ou Ctrl-C) arrete proprement toute la pile.
rem ---------------------------------------------------------------------
title Hermes Web - fermez cette fenetre pour tout arreter
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0desktop\hermes-ui.ps1" start
if errorlevel 1 pause
