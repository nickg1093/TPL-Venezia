@echo off
rem AVVIO IN LOCALE (Windows): doppio clic su questo file. Serve Node.js 22 (https://nodejs.org, versione LTS).
rem Impostazioni facoltative nel file .env.local (una per riga, NOME=valore): PORT, HOST, TLS_CERT, TLS_KEY, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY.
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js non trovato: installalo da https://nodejs.org ^(versione LTS 22^), poi riprova. & pause & exit /b 1)
if not exist node_modules (
  echo Prima installazione delle librerie, attendi...
  call npm install --omit=dev || (echo Installazione non riuscita: controlla la connessione. & pause & exit /b 1)
)
if exist .env.local for /f "usebackq eol=# tokens=1,* delims==" %%a in (".env.local") do set "%%a=%%b"
if "%PORT%"=="" set PORT=3000
start "" http://localhost:%PORT%
:loop
node server.js
echo.
echo L'app si e' fermata. Riavvio tra 5 secondi (chiudi questa finestra per uscire)...
timeout /t 5 /nobreak >nul
goto loop
