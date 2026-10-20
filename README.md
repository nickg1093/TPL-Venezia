# Venezia TPL Live 🚢🚌

Un'applicazione web ad alte prestazioni per il monitoraggio in tempo reale del trasporto pubblico locale (TPL) di Venezia (ACTV), sviluppata con Node.js, Leaflet e protocolli GTFS / GTFS-Realtime.

## 🚀 Caratteristiche Principali

* **Tracciamento Real-Time:** Aggiornamenti in tempo reale dei veicoli (bus, tram e mezzi di navigazione) tramite flussi GTFS-RT.
* **Massima Fluidità (60 FPS):** Rendering ottimizzato su Canvas e accelerazione hardware GPU tramite transizioni CSS per lo spostamento dei marker.
* **Gestione Intelligente dei Capolinea:** Logica avanzata per evitare falsi anticipi o ritardi propagati quando il mezzo è fermo in attesa della partenza.
* **Ricerca e Zone:** Indicizzazione rapida di fermate, linee e raggruppamento in zone di banchina.
* **Basso Impatto di Memoria:** Ottimizzazione estrema del server con cache Gzip pre-compilate in RAM, assenza di cicli trigonometrici pesanti e utilizzo di strutture dati compatte.

---

## 🛠️ Requisiti di Sistema

* **Node.js** (versione 18.x o superiore consigliata)
* Dati GTFS statici e feed in tempo reale configurati.

---

## 📦 Installazione e Avvio

1. Cliona o scarica la repository nella tua directory di lavoro.
2. Installa le dipendenze essenziali:
   ```bash
   npm install
