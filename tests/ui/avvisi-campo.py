# SIMULAZIONE «SUL CAMPO» (v34): fermate sospese, nebbia, acqua alta e corse soppresse in pianificatore, pannello della fermata e viaggio
# guidato, con il server di prova già avviato (vedi run.py):   python3 tests/ui/avvisi-campo.py http://localhost:3111 /tmp/ui   (anche TESTO=1.3)
# Regola dell'app: gli avvisi NON cambiano le soluzioni (i dati ACTV di solito non tolgono il passaggio di una fermata sospesa), ma ogni
# soluzione che sale o scende a una fermata segnalata sospesa lo dice chiaramente («il mezzo potrebbe non fermarsi»), e con avvisi generali
# (nebbia, acqua alta) o marea alta compare la nota che una fermata o una corsa può non esserci. Il viaggio guidato lo ripete in cima.
import sys, os, json, time, pathlib
from playwright.sync_api import sync_playwright
BASE = sys.argv[1] if len(sys.argv) > 1 else 'http://localhost:3111'
OUT = pathlib.Path(sys.argv[2] if len(sys.argv) > 2 else '/tmp/ui'); OUT.mkdir(parents=True, exist_ok=True)
TS = os.environ.get('TESTO', '')
INIT = "try{localStorage.setItem('tpl.guida', JSON.stringify({v:'v34', mappa:true, pannello:true}));" + (f"localStorage.setItem('tpl.testo','{TS}');" if TS else '') + "}catch(e){}"
fails = []
def check(ok, msg):
    print(('  ok   ' if ok else '  FAIL ') + msg)
    if not ok: fails.append(msg)
DA, A = 'f:nav:5031', 'f:aut:6073'                     # P.le Roma «G» -> Stazione Mestre FS (come viaggio.py)
now = int(time.time() * 1000); H = 3600000
def avvisi(stop_ids, extra=()):
    it = [{'id': 'sospesa01', 'source': 'actv', 'title': 'Prova: pontile sospeso', 'text': 'Sospesa la fermata per lavori.', 'published': now - H, 'from': now - H, 'to': now + 48 * H,
           'dated': True, 'lines': [], 'stops': stop_ids, 'stopNames': [], 'effect': 'no_service', 'effectLabel': 'Sospeso', 'severity': 'severe', 'ambito': 'fermate', 'state': 'active'}] if stop_ids else []
    return {'updated': now, 'stale': False, 'errors': {'rss': None, 'tg': None}, 'items': it + list(extra)}
NEBBIA = {'id': 'nebbia001', 'source': 'actv', 'title': 'Nebbia: navigazione rallentata, possibili corse soppresse', 'text': 'Per nebbia possibili ritardi e soppressioni.', 'published': now - H,
          'from': now - H, 'to': now + 5 * H, 'dated': False, 'general': True, 'lines': [], 'stops': [], 'effect': 'reduced', 'effectLabel': 'Servizio ridotto', 'severity': 'info', 'state': 'active'}
with sync_playwright() as p:
    br = p.chromium.launch()
    def nuovo(feed):
        ctx = br.new_context(viewport={'width': 390, 'height': 844}, has_touch=True, permissions=['geolocation'], geolocation={'latitude': 45.4386, 'longitude': 12.3195})
        ctx.add_init_script(INIT); ctx.route('**/*tile.openstreetmap.org/**', lambda r: r.abort())
        ctx.route('**/api/avvisi*', lambda r: r.fulfill(body=json.dumps(feed()), content_type='application/json'))
        pg = ctx.new_page(); errs = []; pg.on('pageerror', lambda e: errs.append(str(e))); return ctx, pg, errs
    # 1) prima soluzione senza avvisi: si legge la fermata di salita
    ctx, pg, errs = nuovo(lambda: avvisi([]))
    sol = {}
    def cattura(r):
        resp = r.fetch();
        try: sol.setdefault('d', json.loads(resp.text()))
        except Exception: pass
        r.fulfill(response=resp)
    pg.route('**/api/percorso?*', cattura)
    pg.goto(f'{BASE}/?da={DA}&a={A}'); pg.wait_for_selector('.pp-opt', timeout=60000); pg.wait_for_timeout(800)
    o = (sol.get('d') or {}).get('opzioni') or (sol.get('d') or {}).get('soluzioni') or []
    rides = [t for t in (o[0]['tratte'] if o else []) if t.get('tipo') == 'mezzo']
    check(bool(rides), f'soluzione con almeno un mezzo ({len(rides)})')
    first = rides[0]['da'] if rides else {'id': 'nav:5031', 'name': ''}
    check(not pg.query_selector('.pp-opt .pp-avl[data-sev=severe]'), 'senza avvisi: nessuna fermata segnalata sulle schede')
    ctx.close()
    # 2) la fermata di salita segnalata sospesa + nebbia su tutta la rete: soluzioni uguali, avvertenze chiare
    feed = lambda: avvisi([first['id']], [NEBBIA])
    ctx, pg, errs = nuovo(feed); sol2 = {}
    pg.route('**/api/percorso?*', lambda r: (lambda resp: (sol2.setdefault('d', resp.text()), r.fulfill(response=resp)))(r.fetch()))
    pg.goto(f'{BASE}/?da={DA}&a={A}'); pg.wait_for_selector('.pp-opt', timeout=60000); pg.wait_for_timeout(1500)
    o2 = json.loads(sol2.get('d') or '{}'); o2 = o2.get('opzioni') or o2.get('soluzioni') or []
    check(o and o2 and o[0]['tratte'][0].get('tipo') == o2[0]['tratte'][0].get('tipo') and [t.get('tripId') for t in o[0]['tratte']] == [t.get('tripId') for t in o2[0]['tratte']],
          'gli avvisi non cambiano le soluzioni (stessa corsa: il passaggio resta nei dati)')
    card = pg.inner_text('.pp-opt .pp-avl') if pg.query_selector('.pp-opt .pp-avl') else ''
    check('potrebbe non fermarsi' in card and pg.query_selector('.pp-opt .pp-avl[data-sev=severe]') is not None, f'scheda: «{card[:90]}»')
    pg.click('.pp-opt'); pg.wait_for_timeout(1200)
    det = pg.inner_text('#plist')
    check(pg.query_selector('.pp-sosp') is not None and 'sospesa' in pg.inner_text('.pp-sosp') and 'potrebbe non fermarsi' in pg.inner_text('.pp-sosp'), 'dettaglio: fermata sospesa in evidenza')
    check('Tutta la rete' in det and 'Nebbia' in det, 'dettaglio: avviso generale di nebbia, «Tutta la rete»')
    check(pg.query_selector('.pp-incerto') is not None and 'nebbia' in pg.inner_text('.pp-incerto'), 'dettaglio: nota «una fermata o una corsa può non esserci»')
    b = pg.evaluate("(()=>{const e=document.querySelector('.pp-sosp');const r=e.getBoundingClientRect();return r.right<=innerWidth+1&&r.left>=-1})()")
    check(b, 'nota della fermata sospesa dentro lo schermo')
    pg.screenshot(path=str(OUT / 'campo-dettaglio.png'))
    # viaggio guidato: la fermata sospesa sopra l'indicazione del momento
    if pg.query_selector('.pp-go'):
        pg.click('.pp-go'); pg.wait_for_timeout(2500)
        vs = pg.query_selector('.vg-sosp'); now_el = pg.query_selector('.vg-now')
        check(vs is not None and now_el is not None and vs.bounding_box()['y'] < now_el.bounding_box()['y'], '«In viaggio»: fermata sospesa in cima, sopra l\'indicazione')
        check(pg.query_selector('.vg-avs .pp-incerto') is not None, '«In viaggio»: avvisi del viaggio e nota sull\'incertezza')
        pg.screenshot(path=str(OUT / 'campo-viaggio.png'))
        pg.click('.vg-end'); pg.wait_for_timeout(300); pg.click('.vg-end') if pg.query_selector('.vg-end') else None
    else: check(False, 'pulsante «Inizia il viaggio» assente')
    # pannello della fermata sospesa: passaggi in elenco + frase esplicita
    pg.goto(f"{BASE}/?fermata={first['id']}"); pg.wait_for_selector('#panel:not([hidden]) #plist .dep, #panel:not([hidden]) #plist p', timeout=20000); pg.wait_for_timeout(1500)
    check(pg.query_selector('#plist .pp-sosp') is not None and 'potrebbero non fermarsi' in pg.inner_text('#plist .pp-sosp'), 'pannello della fermata: «i mezzi potrebbero non fermarsi»')
    check(pg.evaluate("document.querySelectorAll('#plist .dep').length") > 0, 'pannello della fermata: i passaggi restano in elenco')
    check(not errs, f'nessun errore {errs[:1]}'); ctx.close()
    # 3) marea alta (110 cm, prova in locale) senza avvisi: nota sull'incertezza nel dettaglio
    ctx, pg, errs = nuovo(lambda: avvisi([]))
    pg.goto(f'{BASE}/?marea=115&da={DA}&a={A}'); pg.wait_for_selector('.pp-opt', timeout=60000); pg.wait_for_timeout(1000); pg.click('.pp-opt'); pg.wait_for_timeout(1500)
    check(pg.query_selector('.pp-incerto') is not None, 'marea 115 cm: nota «con acqua alta una fermata o una corsa può non esserci»')
    check(not errs, f'marea alta: nessun errore {errs[:1]}'); ctx.close()
    br.close()
print(f'\nFALLITI: {len(fails)}')
sys.exit(1 if fails else 0)
