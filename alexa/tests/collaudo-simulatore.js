// COLLAUDO NEL SIMULATORE AMAZON (Alexa Developer Console → Test → Alexa Simulator, con «Skill I/O» attivo).
// Incolla questo file nella console del browser (F12 → Console) sulla pagina del simulatore, poi:
//   await collaudo(['apri venezia t. p. l.', 'ogni quanto passa il t1 a san marco cattaneo', ...])
// Per ogni frase scrive nel campo del simulatore, attende la risposta e registra intento, slot (valore → risoluzione) e risposta.
// Restituisce una tabella (console.table) e il testo da copiare. Una frase ogni 3-5 secondi: la sessione resta aperta per i seguiti.
// Non invia dati altrove; usa solo la pagina aperta.
(() => {
  const attendi = ms => new Promise(r => setTimeout(r, ms));
  const risposte = () => [...document.querySelectorAll('.askt-dialog__message--active-response, .askt-dialog__message--response')];
  function ultimoIntento() {
    try {
      const ed = [...document.querySelectorAll('.ace_editor')].map(x => x.env.editor.getValue());
      const r = JSON.parse(ed[0]).request;
      if (!r.intent) return { intento: r.type, slot: '' };
      const slot = Object.values(r.intent.slots || {}).filter(s => s.value).map(s => {
        const a = s.resolutions && s.resolutions.resolutionsPerAuthority[0];
        return `${s.name}=${s.value}→${a && a.values ? a.values.map(v => v.value.name).slice(0, 2).join('/') : '-'}`;
      }).join('; ');
      return { intento: r.intent.name, slot };
    } catch { return { intento: '?', slot: '' }; }
  }
  async function chiedi(frase) {
    const inp = [...document.querySelectorAll('input')].find(i => /Type or click/i.test(i.placeholder || ''));
    if (!inp) throw new Error('campo del simulatore non trovato');
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    inp.focus(); set.call(inp, frase); inp.dispatchEvent(new Event('input', { bubbles: true }));
    const n0 = risposte().length, t0 = Date.now();
    inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
    for (let i = 0; i < 30; i++) { await attendi(400); if (risposte().length > n0) break; }
    await attendi(700);
    const r = risposte();
    return { frase, ...ultimoIntento(), ms: Date.now() - t0, risposta: r.length > n0 ? r[r.length - 1].textContent.trim() : '(nessuna risposta)' };
  }
  window.collaudo = async (frasi, attesi = {}) => {
    const out = [];
    for (const f of frasi) { const x = await chiedi(f); if (attesi[f]) x.ok = attesi[f] === '*' || attesi[f] === x.intento; out.push(x); await attendi(800); }
    console.table(out.map(({ frase, intento, ok, slot, risposta }) => ({ frase, intento, ok, slot, risposta: risposta.slice(0, 160) })));
    const ok = out.filter(x => x.ok === true).length, tot = out.filter(x => x.ok != null).length;
    if (tot) console.log(`Comprensione: ${ok}/${tot} (${Math.round(100 * ok / tot)}%)`);
    return out.map(x => `> ${x.frase}\n  [${x.intento}${x.ok === false ? ' ✗' : ''}] ${x.slot}\n  ${x.risposta}`).join('\n');
  };
  // campione inedito: collaudoInedite(json) con il contenuto di alexa/tests/frasi-inedite.json
  window.collaudoInedite = j => window.collaudo([j.sessione, ...j.frasi.map(x => x[0])], Object.fromEntries(j.frasi));
  return 'pronto: await collaudo([...frasi]) oppure await collaudoInedite({...json})';
})();
