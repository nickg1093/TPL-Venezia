#!/usr/bin/env bash
# AVVIO IN LOCALE (macOS / Linux):  ./avvia.sh   (su macOS anche doppio clic su avvia.command). Serve Node.js 22 (https://nodejs.org).
# Impostazioni facoltative nel file .env.local (una per riga, NOME=valore): PORT, HOST, TLS_CERT, TLS_KEY, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY.
cd "$(dirname "$0")" || exit 1
command -v node >/dev/null 2>&1 || { echo "Node.js non trovato: installalo da https://nodejs.org (versione LTS 22), poi riprova."; exit 1; }
if [ ! -d node_modules ]; then echo "Prima installazione delle librerie, attendi..."; npm install --omit=dev || { echo "Installazione non riuscita: controlla la connessione."; exit 1; }; fi
if [ -f .env.local ]; then set -a; . ./.env.local; set +a; fi
PORT="${PORT:-3000}"; export PORT
( sleep 3; URL="http://localhost:$PORT"; command -v open >/dev/null && open "$URL" || { command -v xdg-open >/dev/null && xdg-open "$URL"; } ) >/dev/null 2>&1 &
while true; do
  node server.js
  echo; echo "L'app si è fermata. Riavvio tra 5 secondi (Ctrl+C per uscire)..."; sleep 5
done
