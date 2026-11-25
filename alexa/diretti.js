'use strict';
// CORSE DIRETTE SULL'INTERO GTFS DI UNA DATA (prima, ultima, orari programmati, verifica della direzione).
// Non è un secondo motore: legge le stesse strutture già in memoria nel server (gtfs.js: stopIndex, stopTimes, trips, routes) e lo stesso
// calendario (schedule.serviceActive), per la versione dei GTFS valida in quella data (live.dataFor, come la modalità «Programmato» della PWA).
// Nessun archivio caricato in più, nessuna copia: per ogni fermata di partenza si scorrono solo le corse che vi passano.
//
// Regole (GTFS Schedule): una corsa vale nel GIORNO DI SERVIZIO se il suo service_id è attivo (calendar + calendar_dates); gli orari possono
// superare le 24:00 (corse dopo mezzanotte dello stesso giorno di servizio). Si sale solo dove la corsa riparte (non al capolinea d'arrivo),
// si scende solo più avanti nella sequenza (stop_sequence). Corse soppresse o fermate saltate dal tempo reale sono marcate, non nascoste.
const L = require('./luoghi');

// motore: { G(src, ymd) -> G | null (nessun GTFS per la data) [può lanciare 409/503], serviceActive(G, service, ymd), equivalentStops(G, sid),
//           live(src) -> { tripId: { cancelled, skipped:Set } } | null (solo per il giorno di servizio in corso), oggi() -> ymd di servizio in corso }
// q: { da: ['src:id',…], a: ['src:id',…] | null, ymd, linee: ['5.2'] | null, tipi: [0,3,4] | null, dirTesto: 'venezia' | null,
//      daSecs, aSecs (finestra sui secondi del giorno di servizio, anche > 86400), max }
// -> { righe: [{ src, tripId, line, color, type, headsign, from, i, dep, to, j, arr, ymd, cancel }], nessunGtfs: [src…] }
async function cerca(motore, q) {
  const perSrc = new Map();
  for (const f of q.da || []) { const k = f.indexOf(':'); if (k > 0) (perSrc.get(f.slice(0, k)) || perSrc.set(f.slice(0, k), []).get(f.slice(0, k))).push(f.slice(k + 1)); }
  const destPer = new Map();
  for (const f of q.a || []) { const k = f.indexOf(':'); if (k > 0) (destPer.get(f.slice(0, k)) || destPer.set(f.slice(0, k), []).get(f.slice(0, k))).push(f.slice(k + 1)); }
  const dirK = q.dirTesto ? L.normalizza(q.dirTesto) : null;
  const righe = [], nessunGtfs = [], visti = new Set();
  const da = q.daSecs ?? -Infinity, a = q.aSecs ?? Infinity;
  for (const [src, sids] of perSrc) {
    if (q.a && !destPer.has(src)) continue;                                  // destinazione servita solo dall'altro servizio: nessuna corsa diretta
    const G = await motore.G(src, q.ymd);
    if (!G) { nessunGtfs.push(src); continue; }
    const espandi = list => { const s = new Set(); for (const x of list) for (const e of motore.equivalentStops(G, x)) s.add(e); return s; };
    const orig = espandi(sids), dest = q.a ? espandi(destPer.get(src)) : null;
    const lv = motore.oggi && motore.oggi() === q.ymd && motore.live ? motore.live(src) : null;
    const nomeK = new Map();   // fermata -> nome normalizzato (verifica della direzione a testo)
    const nk = sid => { let v = nomeK.get(sid); if (v == null) nomeK.set(sid, v = L.normalizza(G.stopBaseNames?.get(sid) || G.stops[sid] || '')); return v; };
    for (const sid of orig) {
      const list = G.stopIndex[sid]; if (!list) continue;
      for (let p = 0; p < list.length; p += 2) {
        const tid = G.tripIds[list[p]], i = list[p + 1], st = G.stopTimes.get(tid), trip = G.trips[tid];
        if (!st || !trip || i >= st.s.length - 1) continue;                    // al capolinea d'arrivo non si sale
        const dep = st.d[i]; if (dep < da || dep > a) continue;
        if (!motore.serviceActive(G, trip.service, q.ymd)) continue;
        const r = G.routes[trip.route] || {};
        if (q.linee && !q.linee.some(n => L.stessaLinea(r.name || trip.route, n))) continue;
        if (q.tipi && !q.tipi.includes(r.type ?? (src === 'nav' ? 4 : 3))) continue;
        let j = -1;
        if (dest) { for (let k = i + 1; k < st.s.length; k++) if (dest.has(st.s[k]) && !orig.has(st.s[k])) { j = k; break; } if (j < 0) continue; }
        else if (dirK) {
          const hs = L.normalizza(trip.headsign || ''), ok = t => t === dirK || t.split(' ').includes(dirK) || (dirK.length > 3 && t.includes(dirK));
          let hit = ok(hs);
          for (let k = i + 1; !hit && k < st.s.length; k++) hit = ok(nk(st.s[k]));
          if (!hit) continue;
        }
        const key = tid + '|' + (j >= 0 ? j : '');
        if (visti.has(key)) continue; visti.add(key);
        const l0 = lv && lv[tid];
        const cancel = l0 ? (l0.cancelled ? 'trip' : (l0.skipped && (l0.skipped.has(i) || (j >= 0 && l0.skipped.has(j))) ? 'stop' : null)) : null;
        righe.push({ src, tripId: tid, line: r.name || trip.route, color: r.color || null, type: r.type ?? null, headsign: trip.headsign || G.stops[st.s[st.s.length - 1]] || null,
          from: `${src}:${st.s[i]}`, i, dep, to: j >= 0 ? `${src}:${st.s[j]}` : null, j, arr: j >= 0 ? st.a[j] : null, ymd: q.ymd, cancel });
      }
    }
  }
  righe.sort((x, y) => x.dep - y.dep || (x.arr ?? 0) - (y.arr ?? 0));
  return { righe: q.max ? righe.slice(0, q.max) : righe, totale: righe.length, nessunGtfs };
}

// la corsa (tripId, fermata di salita) passa più avanti da una delle fermate `dest` (o, senza fermate, da un nome che contiene il testo)?
// Usato sulle righe del tempo reale (/api/zone in processo: ogni riga porta con sé la versione dei GTFS, _G).
function proseguePer(G, tripId, seq, dest, dirTesto) {
  const st = G && G.stopTimes && G.stopTimes.get(tripId); if (!st) return null;
  if (dest && dest.size) { for (let k = seq + 1; k < st.s.length; k++) if (dest.has(st.s[k])) return true; return false; }
  if (!dirTesto) return true;
  const dk = L.normalizza(dirTesto), ok = t => t === dk || t.split(' ').includes(dk) || (dk.length > 3 && t.includes(dk));
  if (ok(L.normalizza(G.trips[tripId]?.headsign || ''))) return true;
  for (let k = seq + 1; k < st.s.length; k++) if (ok(L.normalizza(G.stopBaseNames?.get(st.s[k]) || G.stops[st.s[k]] || ''))) return true;
  return false;
}

module.exports = { cerca, proseguePer };
