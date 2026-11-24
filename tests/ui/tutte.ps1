# TUTTE LE PROVE DELL'INTERFACCIA in fila (PowerShell di Windows), con l'app simulata già avviata in un'altra finestra (README §9.3).
#   powershell -ExecutionPolicy Bypass -File tests\ui\tutte.ps1 http://localhost:3111 C:\temp\ui
#   ($env:TESTO="1.3" prima per ripeterle con il testo «Molto grande»; $env:DATI_DIR="C:\temp\dati" per le passerelle)
# Ogni prova scrive il suo registro in <cartella>\log\<nome>.log; alla fine il riepilogo; codice di uscita 1 se qualcosa è fallito.
param([string]$Base = 'http://localhost:3111', [string]$Out = 'C:\temp\ui')
$ErrorActionPreference = 'Continue'
New-Item -ItemType Directory -Force -Path (Join-Path $Out 'log') | Out-Null
Set-Location (Join-Path $PSScriptRoot '..\..')
$prove = 'run','sistema','acqua','marea','marea-scenari','modifica','offline','viaggio','viaggio-gps','avvisi-campo','copertura','guasti','passerelle'
$fallite = @()
foreach ($t in $prove) {
  $log = Join-Path $Out "log\$t.log"
  python -u "tests\ui\$t.py" $Base $Out *> $log
  if ($LASTEXITCODE -eq 0) { Write-Host ('{0,-14} ok' -f $t) } else { Write-Host ('{0,-14} FALLITA (vedi {1})' -f $t, $log) -ForegroundColor Red; $fallite += $t }
}
if ($fallite.Count -eq 0) { Write-Host "Tutte le prove dell'interfaccia: ok" -ForegroundColor Green; exit 0 }
Write-Host ('Fallite: ' + ($fallite -join ', ')) -ForegroundColor Red; exit 1
