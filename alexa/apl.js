'use strict';
// SCHEDE APL per Echo Show (e altri dispositivi con schermo). Un solo documento adattabile: titolo, dato grande, righe (partenze, tratte,
// avvisi, marea), nota e fonte. Senza schermo la skill funziona uguale: la voce dice già tutto, la scheda è un di più.
const P = require('./parlato');
const U = require('./util');

const TOKEN = 'veneziaTpl';
const INTERFACCIA = 'Alexa.Presentation.APL';
const COLORE_STATO = { ok: '#2E7D6B', ritardo: '#C99A2E', soppressa: '#C0392B', stima: '#7A8794', prog: '#4A6B82' };

// il dispositivo ha uno schermo APL?
function haSchermo(envelope) {
  const si = envelope?.context?.System?.device?.supportedInterfaces;
  return !!(si && si[INTERFACCIA]);
}
// profilo dallo schermo dichiarato nella richiesta: rotondo (Echo Spot / Hub rotondo), piccolo, medio, largo (Show 10 / TV)
function profilo(envelope) {
  const v = envelope?.context?.Viewport;
  if (!v) return 'medio';
  const w = v.pixelWidth || v.currentPixelWidth || 1024;
  if (v.shape === 'ROUND') return 'rotondo';
  if (w <= 600) return 'piccolo';
  return w >= 1280 ? 'largo' : 'medio';
}
const DIM = {
  rotondo: { righe: 3, pad: 56, titolo: 34, grande: 40, sotto: 22, riga: 24, dett: 18, ora: 26, nota: 16, badge: 22, minBadge: 56, centro: true },
  piccolo: { righe: 4, pad: 24, titolo: 34, grande: 40, sotto: 22, riga: 24, dett: 18, ora: 26, nota: 16, badge: 22, minBadge: 56, centro: false },
  medio: { righe: 5, pad: 40, titolo: 44, grande: 56, sotto: 26, riga: 30, dett: 22, ora: 34, nota: 20, badge: 28, minBadge: 76, centro: false },
  largo: { righe: 6, pad: 64, titolo: 54, grande: 72, sotto: 32, riga: 36, dett: 26, ora: 42, nota: 24, badge: 32, minBadge: 92, centro: false }
};
const px = n => `${n}dp`;
const taglia = (s, n) => { s = P.senzaTag(String(s ?? '')); return s.length > n ? s.slice(0, n - 1).replace(/\s+\S*$/, '') + '…' : s; };

// dati per il documento: stringhe pulite (mai SSML né tag), colori con testo leggibile
function dati(scheda, prof = 'medio') {
  const d = DIM[prof] || DIM.medio;
  const righe = (scheda.righe || []).slice(0, d.righe).map(r => {
    const col = U.colore(r.colore || COLORE_STATO[r.stato] || '#4A6B82');
    return { badge: taglia(r.badge, 9), colore: col, testoBadge: U.coloreTesto(col), testo: taglia(r.testo, prof === 'largo' ? 48 : 34), dett: taglia(r.dett, prof === 'largo' ? 60 : 42), ora: taglia(r.ora, 8), attesa: taglia(r.attesa, 14), barra: COLORE_STATO[r.stato] || COLORE_STATO.prog };
  });
  return {
    titolo: taglia(scheda.titolo, 40), sottotitolo: taglia(scheda.sottotitolo, 60), grande: taglia(scheda.grande, 14),
    righe, nota: taglia(scheda.nota, prof === 'largo' ? 170 : 110), fonte: taglia(scheda.fonte, 90),
    dim: { pad: px(d.pad), titolo: px(d.titolo), grande: px(d.grande), sotto: px(d.sotto), riga: px(d.riga), dett: px(d.dett), ora: px(d.ora), nota: px(d.nota), badge: px(d.badge), minBadge: px(d.minBadge), allineamento: d.centro ? 'center' : 'start' }
  };
}

const testo = (extra) => ({ type: 'Text', color: '#FFFFFF', fontFamily: 'amazon-ember-display', ...extra });
const DOCUMENTO = {
  type: 'APL', version: '1.9', theme: 'dark',
  mainTemplate: {
    parameters: ['dati'],
    items: [{
      type: 'Container', width: '100vw', height: '100vh', backgroundColor: '#0B2A3A', paddingLeft: '${dati.dim.pad}', paddingRight: '${dati.dim.pad}', paddingTop: '${dati.dim.pad}', paddingBottom: '${dati.dim.pad}',
      items: [
        { type: 'Container', direction: 'row', alignItems: 'center', justifyContent: 'spaceBetween', items: [
          testo({ text: '${dati.titolo}', fontSize: '${dati.dim.titolo}', fontWeight: 'bold', grow: 1, shrink: 1, maxLines: 2 }),
          testo({ text: '${dati.grande}', fontSize: '${dati.dim.grande}', fontWeight: 'bold', color: '#F2C14E', display: "${dati.grande ? 'normal' : 'none'}", paddingLeft: '16dp' })
        ] },
        testo({ text: '${dati.sottotitolo}', fontSize: '${dati.dim.sotto}', color: '#A9C1CF', maxLines: 1, display: "${dati.sottotitolo ? 'normal' : 'none'}" }),
        { type: 'Container', grow: 1, shrink: 1, marginTop: '12dp', data: '${dati.righe}', items: [{
          type: 'Container', direction: 'row', alignItems: 'center', marginBottom: '8dp', paddingTop: '8dp', paddingBottom: '8dp', paddingLeft: '10dp', paddingRight: '12dp', backgroundColor: '#12394F', borderRadius: '10dp',
          items: [
            { type: 'Frame', backgroundColor: '${data.colore}', borderRadius: '8dp', minWidth: '${dati.dim.minBadge}', paddingLeft: '8dp', paddingRight: '8dp', paddingTop: '4dp', paddingBottom: '4dp', items: [
              testo({ text: '${data.badge}', fontSize: '${dati.dim.badge}', fontWeight: 'bold', color: '${data.testoBadge}', textAlign: 'center', maxLines: 1 })
            ] },
            { type: 'Container', grow: 1, shrink: 1, paddingLeft: '14dp', items: [
              testo({ text: '${data.testo}', fontSize: '${dati.dim.riga}', maxLines: 1 }),
              testo({ text: '${data.dett}', fontSize: '${dati.dim.dett}', color: '#A9C1CF', maxLines: 1, display: "${data.dett ? 'normal' : 'none'}" })
            ] },
            { type: 'Container', alignItems: 'end', paddingLeft: '10dp', items: [
              testo({ text: '${data.ora}', fontSize: '${dati.dim.ora}', fontWeight: 'bold', maxLines: 1, display: "${data.ora ? 'normal' : 'none'}" }),
              testo({ text: '${data.attesa}', fontSize: '${dati.dim.dett}', color: '#F2C14E', maxLines: 1, display: "${data.attesa ? 'normal' : 'none'}" })
            ] }
          ]
        }] },
        testo({ text: '${dati.nota}', fontSize: '${dati.dim.nota}', color: '#D6E2EA', maxLines: 3, display: "${dati.nota ? 'normal' : 'none'}" }),
        testo({ text: '${dati.fonte}', fontSize: '${dati.dim.nota}', color: '#7F98A8', maxLines: 1, marginTop: '4dp', display: "${dati.fonte ? 'normal' : 'none'}" })
      ]
    }]
  }
};

// direttiva da aggiungere alla risposta (solo se il dispositivo ha uno schermo)
function direttiva(scheda, envelope) {
  if (!scheda || !haSchermo(envelope)) return null;
  return { type: `${INTERFACCIA}.RenderDocument`, token: TOKEN, document: DOCUMENTO, datasources: { dati: dati(scheda, profilo(envelope)) } };
}

module.exports = { haSchermo, profilo, dati, direttiva, DOCUMENTO, TOKEN, INTERFACCIA, DIM };
