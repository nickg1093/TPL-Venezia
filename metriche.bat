@echo off
rem TPL Venezia - misure per giorno (persone e operazioni). Doppio clic per il menu.
rem Uso automatico (Utilita' di pianificazione): metriche.bat csv
cd /d "%~dp0"
if "%~1"=="" (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\metriche.ps1"
) else (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\metriche.ps1" -Azione %1
)
if errorlevel 1 if "%~1"=="" pause
