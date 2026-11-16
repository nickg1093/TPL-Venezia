# Misure per giorno di TPL Venezia: aggiorna il file CSV oppure le mostra nel browser senza salvarle.
# Si avvia con metriche.bat (doppio clic). Il token resta cifrato con l'account di Windows in %LOCALAPPDATA%\TPL-Venezia (fuori dal progetto).
param([ValidateSet('menu', 'csv', 'browser', 'token')][string]$Azione = 'menu')

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$Url = if ($env:TPL_URL) { $env:TPL_URL.TrimEnd('/') } else { 'https://veneziatpl.onrender.com' }
$Progetto = Split-Path -Parent $PSScriptRoot
$Csv = Join-Path $Progetto 'metriche-giorni.csv'
$CartellaToken = Join-Path $env:LOCALAPPDATA 'TPL-Venezia'
$FileToken = Join-Path $CartellaToken 'diag-token.txt'
$Operazioni = @('aperture app (flusso mezzi)', 'fermate consultate', 'zone consultate', 'viaggi pianificati', 'corse aperte',
  'avvisi di arrivo attivati', 'avvisi di arrivo annullati', 'aggiunte al calendario', 'marea', 'avvisi ACTV letti', 'MOSE', 'errori segnalati dai telefoni')

function Salva-Token {
  $s = Read-Host -AsSecureString 'Incolla il DIAG_TOKEN (lo stesso impostato su Render) e premi Invio'
  if ($s.Length -lt 16) { throw 'Token troppo corto (servono almeno 16 caratteri).' }
  New-Item -ItemType Directory -Force -Path $CartellaToken | Out-Null
  $s | ConvertFrom-SecureString | Set-Content -Path $FileToken -Encoding ASCII
  Write-Host 'Token salvato (cifrato, leggibile solo dal tuo account di Windows).' -ForegroundColor Green
}

function Leggi-Token {
  if ($env:DIAG_TOKEN) { return $env:DIAG_TOKEN }
  if (-not (Test-Path $FileToken)) { Salva-Token }
  $s = (Get-Content -Path $FileToken -Raw).Trim() | ConvertTo-SecureString
  return [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))
}

function Scarica {
  $t = Leggi-Token
  Write-Host "Leggo le misure da $Url (se il server dormiva, può servire circa un minuto)..."
  try {
    return Invoke-RestMethod -Uri "$Url/api/metriche/giorni" -Headers @{ Authorization = "Bearer $t" } -TimeoutSec 120 -UseBasicParsing
  } catch {
    $code = $null; try { $code = [int]$_.Exception.Response.StatusCode } catch {}
    if ($code -eq 401) { throw 'Token rifiutato (401): controlla DIAG_TOKEN su Render, poi scegli «Cambia token».' }
    if ($code -eq 404) { throw 'Indirizzo non trovato (404): la versione con le misure per giorno non è ancora online (serve il deploy).' }
    throw "Server non raggiungibile: $($_.Exception.Message)"
  }
}

function Riga($g) {
  $p = [string]$g.persone; if ($g.persone_almeno) { $p += '+' }
  $v = @($g.data, $p)
  foreach ($k in $Operazioni) { $n = $g.operazioni.$k; if ($null -eq $n) { $n = 0 }; $v += [string]$n }
  $v += ([double]$g.MB).ToString([Globalization.CultureInfo]::InvariantCulture)
  return $v
}

function Aggiorna-Csv {
  $d = Scarica
  $righe = [ordered]@{}
  if (Test-Path $Csv) {
    Get-Content -Path $Csv -Encoding UTF8 | Select-Object -Skip 1 | Where-Object { $_.Trim() } | ForEach-Object { $v = $_ -split ';'; $righe[$v[0]] = $v }
  }
  $tutti = @($d.giorni) + @($d.oggi)
  foreach ($g in $tutti) {
    if (-not $g) { continue }
    $v = Riga $g
    $vecchia = $righe[$v[0]]
    $nuove = [double]($v[1] -replace '\+', ''); $prima = if ($vecchia) { [double]($vecchia[1] -replace '\+', '') } else { -1 }
    if ($nuove -ge $prima) { $righe[$v[0]] = $v }          # stesso giorno: resta la lettura più completa (la giornata cresce fino a mezzanotte)
  }
  $testa = (@('data', 'persone') + $Operazioni + @('MB')) -join ';'
  $corpo = $righe.Keys | Sort-Object | ForEach-Object { $righe[$_] -join ';' }
  $utf8 = New-Object System.Text.UTF8Encoding($true)       # con BOM: Excel legge bene gli accenti
  [IO.File]::WriteAllLines($Csv, [string[]](@($testa) + @($corpo)), $utf8)
  $o = $d.oggi
  Write-Host "Salvato in $Csv" -ForegroundColor Green
  Write-Host "Oggi ($($o.data)): $($o.persone) persone, $($o.operazioni.'viaggi pianificati') viaggi pianificati, $($o.operazioni.'fermate consultate') fermate consultate."
}

function H($s) { return [Net.WebUtility]::HtmlEncode([string]$s) }

function Mostra-Browser {
  $d = Scarica
  $giorni = @($d.oggi) + @($d.giorni) | Where-Object { $_ }
  $sb = New-Object Text.StringBuilder
  [void]$sb.Append('<!DOCTYPE html><html lang="it"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>TPL Venezia - misure per giorno</title>')
  [void]$sb.Append('<style>body{font:14px system-ui,sans-serif;margin:20px;color:#222}table{border-collapse:collapse;margin:12px 0}th,td{border:1px solid #ccc;padding:4px 8px;text-align:right}th{background:#eef;position:sticky;top:0}td:first-child,th:first-child{text-align:left}.k{font-size:2em;font-weight:700}.box{display:inline-block;margin:0 24px 8px 0}small{color:#666}@media(prefers-color-scheme:dark){body{background:#111;color:#ddd}th{background:#223}td,th{border-color:#444}}</style></head><body>')
  $o = $d.oggi
  [void]$sb.Append("<h1>TPL Venezia - oggi $(H $o.data)</h1>")
  [void]$sb.Append("<div class='box'><div class='k'>$(H $o.persone)$(if($o.persone_almeno){'+'})</div>persone</div>")
  foreach ($k in @('aperture app (flusso mezzi)', 'viaggi pianificati', 'fermate consultate', 'avvisi di arrivo attivati')) {
    [void]$sb.Append("<div class='box'><div class='k'>$(H $o.operazioni.$k)</div>$(H $k)</div>")
  }
  [void]$sb.Append('<h2>Per giorno</h2><table><tr><th>data</th><th>persone</th>')
  foreach ($k in $Operazioni) { [void]$sb.Append("<th>$(H $k)</th>") }
  [void]$sb.Append('<th>MB</th></tr>')
  foreach ($g in $giorni) {
    $v = Riga $g
    [void]$sb.Append('<tr>'); foreach ($x in $v) { [void]$sb.Append("<td>$(H $x)</td>") }; [void]$sb.Append('</tr>')
  }
  [void]$sb.Append('</table><h2>Tutte le richieste di oggi</h2><table><tr><th>endpoint</th><th>richieste</th></tr>')
  foreach ($p in $o.richieste.PSObject.Properties) { [void]$sb.Append("<tr><td>$(H $p.Name)</td><td>$(H $p.Value)</td></tr>") }
  [void]$sb.Append("</table><p><small>$(H $d.nota). Pagina creata il $(Get-Date -Format 'dd/MM/yyyy HH:mm'), non salvata.</small></p></body></html>")
  # file temporaneo: il browser lo apre e dopo pochi secondi viene cancellato (la pagina resta visibile finché non la chiudi)
  $tmp = Join-Path $env:TEMP ("tpl-metriche-" + [guid]::NewGuid().ToString('N') + '.html')
  [IO.File]::WriteAllText($tmp, $sb.ToString(), (New-Object System.Text.UTF8Encoding($false)))
  Start-Process $tmp
  Start-Sleep -Seconds 8
  Remove-Item -Path $tmp -Force -ErrorAction SilentlyContinue
  Write-Host 'Aperto nel browser (nessun file conservato).' -ForegroundColor Green
}

function Esegui($a) {
  try {
    switch ($a) { 'csv' { Aggiorna-Csv } 'browser' { Mostra-Browser } 'token' { Salva-Token } }
    return $true
  } catch { Write-Host $_.Exception.Message -ForegroundColor Red; return $false }
}

if ($Azione -ne 'menu') { if (Esegui $Azione) { exit 0 } else { exit 1 } }

while ($true) {
  Write-Host ''
  Write-Host 'TPL Venezia - misure per giorno' -ForegroundColor Cyan
  Write-Host '  1  Aggiorna il file CSV (metriche-giorni.csv)'
  Write-Host '  2  Mostra nel browser senza salvare'
  Write-Host '  3  Fai entrambe le cose'
  Write-Host '  4  Cambia token'
  Write-Host '  0  Esci'
  $c = Read-Host 'Scelta'
  switch ($c) {
    '1' { [void](Esegui 'csv') }
    '2' { [void](Esegui 'browser') }
    '3' { if (Esegui 'csv') { [void](Esegui 'browser') } }
    '4' { [void](Esegui 'token') }
    '0' { exit 0 }
    default { Write-Host 'Scelta non valida.' }
  }
}
