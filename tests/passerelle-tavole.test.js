// Tracciati delle passerelle ricavati dalle tavole dell'Atlante (data/acqua/passerelle-tavole.json) e aggiornamenti San Marco 2023
// (data/acqua/passerelle-atlante.json): controlli di coerenza sui dati, senza i PDF (che restano fuori dal repository).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const A = require('../scripts/acqua-core');

const D = path.join(__dirname, '..', 'data', 'acqua');
const tav = JSON.parse(fs.readFileSync(path.join(D, 'passerelle-tavole.json'), 'utf8'));
const atl = JSON.parse(fs.readFileSync(path.join(D, 'passerelle-atlante.json'), 'utf8'));
const byId = new Map(atl.percorsi.map(p => [p.id.replace(/\s/g, ''), p]));
const len = s => s.reduce((a, p, i) => (i ? a + A.mDist(s[i - 1][0], s[i - 1][1], p[0], p[1]) : 0), 0);

test('tavole: solo tracciati verificati (georeferenziazione netta, lunghezza coerente, dentro Venezia)', () => {
  assert.strictEqual(tav.formato, 1);
  assert.ok(/Atlante dei percorsi in quota su passerelle/.test(tav.fonte) && /RAMSES/.test(tav.metodo));
  assert.ok(tav.percorsi.length >= 25, `tracciati usati: ${tav.percorsi.length}`);
  for (const t of tav.percorsi) {
    const p = byId.get(t.id); assert.ok(p, `${t.id} nel piano`);
    assert.ok(t.georef.score >= 0.6 && t.georef.score - t.georef.secondo >= 0.12, `${t.id}: georeferenziazione ${JSON.stringify(t.georef)}`);
    const m = t.segmenti.reduce((a, s) => a + len(s), 0);
    assert.ok(Math.abs(m - t.m_ufficiale) <= Math.max(8, t.m_ufficiale * 0.25) + 3, `${t.id}: ${m.toFixed(1)} m contro ${t.m_ufficiale} m ufficiali`);
    assert.ok(t.scarto_max_m == null || t.scarto_max_m <= 60, `${t.id}: scarto ${t.scarto_max_m} m`);
    for (const s of t.segmenti) for (const [la, lo] of s) assert.ok(la > 45.42 && la < 45.45 && lo > 12.31 && lo < 12.37, `${t.id}: punto fuori dalla città storica`);
  }
  const usati = new Set(tav.percorsi.map(t => t.id));
  for (const n of tav.non_usati) { assert.ok(!usati.has(n.id) && n.motivo, `${n.id}: motivo`); }
  assert.ok(tav.non_usati.filter(n => /^T(8|9|10)\./.test(n.id)).every(n => /isole/.test(n.motivo)), 'isole fuori dal rilievo: non georeferenziate');
});

test('San Marco: schede 2023 applicate (lunghezze, quote, descrizioni; T1.1 E aggiunto, T1.7 D escluso)', () => {
  const v = id => byId.get(id);
  assert.deepStrictEqual([v('T1.1E').metri, v('T1.1E').quota, v('T1.1E').geo], [48, 80, 'tavola']);
  assert.deepStrictEqual([v('T1.1F').metri, v('T1.1F').quota], [24, 65]);
  assert.deepStrictEqual([v('T1.7A').metri, v('T1.7B').metri, v('T1.7B').quota], [124, 72, 110]);
  assert.strictEqual(v('T1.2B').quota, 110, 'posa da +90 a +110: percorso completo a +110');
  assert.ok(!v('T1.7D'), 'T1.7 D senza posizione affidabile');
  assert.ok(atl.percorsi.filter(p => p.agg === '2023').every(p => /^T\s?1\./.test(p.id)));
  // gli altri sestieri: invariati rispetto alla tabella 2019 (tot_pass.pdf)
  assert.deepStrictEqual([v('T2.1A').metri, v('T2.1A').quota, v('T3.2A').quota, v('T9.3B').metri], [28, 90, 140, 24]);
});
