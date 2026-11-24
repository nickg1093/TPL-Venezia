#!/usr/bin/env bash
# TUTTE LE PROVE DELL'INTERFACCIA in fila, con il server di prova già avviato (feed finto, vedi run.py). Uso:
#   bash tests/ui/tutte.sh [http://localhost:3111] [/tmp/ui]          (TESTO=1.3 per ripeterle con il testo «Molto grande»;
#   DATI_DIR=/tmp/dati per la prova delle passerelle, che senza la rete pedonale si salta)
# Ogni prova scrive il suo registro in <cartella>/log/<nome>.log; alla fine il riepilogo e l'uscita 1 se qualcosa è fallito.
BASE=${1:-http://localhost:3111}; OUT=${2:-/tmp/ui}; mkdir -p "$OUT/log"
cd "$(dirname "$0")/../.." || exit 1
falliti=()
for t in run sistema acqua marea marea-scenari modifica offline viaggio viaggio-gps avvisi-campo copertura guasti passerelle; do
  printf '%-14s ' "$t"
  if timeout 1200 python3 -u "tests/ui/$t.py" "$BASE" "$OUT" > "$OUT/log/$t.log" 2>&1; then echo ok
  else echo "FALLITA (vedi $OUT/log/$t.log)"; falliti+=("$t"); fi
done
[ ${#falliti[@]} -eq 0 ] && { echo 'Tutte le prove dell'"'"'interfaccia: ok'; exit 0; }
echo "Fallite: ${falliti[*]}"; exit 1
