# INIEZIONE DI GUASTI (v34), con il server di prova già avviato (vedi run.py):
#   python3 tests/ui/guasti.py http://localhost:3111 /tmp/ui
# Per ogni guasto: l'app si apre, la mappa e i pulsanti principali rispondono, nessun errore non gestito nella pagina, e dove serve un
# messaggio comprensibile. Guasti: risposte rovinate (JSON troncato) o 500 su avvisi, marea, MOSE, mezzi in tempo reale, fermate e dati
# fissi; servizio lentissimo; memoria del browser piena; due schede aperte con lo stesso viaggio; fuso orario del telefono diverso.
import sys, json, pathlib, os, time
from playwright.sync_api import sync_playwright
BASE = sys.argv[1] if len(sys.argv) > 1 else 'http://localhost:3111'
OUT = pathlib.Path(sys.argv[2] if len(sys.argv) > 2 else '/tmp/ui'); OUT.mkdir(parents=True, exist_ok=True)
STUB = (pathlib.Path(__file__).parent / 'leaflet-stub.js').read_text()
GUIDE_OFF = "try{localStorage.setItem('tpl.guida', JSON.stringify({v:'v34', mappa:true, pannello:true}))}catch(e){}"
fails = []
def check(ok, msg):
    print(('  ok   ' if ok else '  FAIL ') + msg)
    if not ok: fails.append(msg)
IGN = ('push service', 'ERR_', 'tile', 'Failed to load resource', 'net::')

def apri(br, i, rotte=(), init=(), tz=None):
    ctx = br.new_context(viewport={'width': 390, 'height': 844}, has_touch=True, timezone_id=tz or 'Europe/Rome', service_workers='block',
                         extra_http_headers={'X-Forwarded-For': f'10.13.{os.getpid() % 250}.{i % 250}'})
    ctx.add_init_script(GUIDE_OFF)
    for s in init: ctx.add_init_script(s)
    pg = ctx.new_page(); errs = []
    pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.on('console', lambda m: errs.append(m.text) if m.type == 'error' and not any(x in m.text for x in IGN) else None)
    pg.route('**/vendor/leaflet/leaflet.js', lambda r: r.fulfill(body=STUB, content_type='application/javascript'))
    pg.route('**/vendor/leaflet/leaflet.css', lambda r: r.fulfill(body='', content_type='text/css'))
    pg.route('https://tile.openstreetmap.org/**', lambda r: r.abort())
    for pat, fn in rotte: pg.route(pat, fn)
    return ctx, pg, errs

def vivo(pg):           # i comandi principali rispondono
    ok = True
    for sel in ('#plan-btn', '#avvisi-btn', '#tide-btn', '#info-btn'):
        e = pg.query_selector(sel)
        if not e or not e.is_visible(): continue
        try: e.click(timeout=3000); pg.wait_for_timeout(500); pg.keyboard.press('Escape'); pg.wait_for_timeout(300)
        except Exception as x: ok = False; print('     ', sel, str(x)[:80])
    return ok

rovinata = lambda r: r.fulfill(body='{"items":[{"id":', content_type='application/json')
errore500 = lambda r: r.fulfill(status=500, body='errore interno', content_type='text/plain')
def lenta(r): time.sleep(8); r.continue_()
CASI = [
    ('avvisi rovinati', [('**/api/avvisi*', rovinata)]),
    ('avvisi 500', [('**/api/avvisi*', errore500)]),
    ('marea rovinata', [('**/api/tide*', rovinata)]),
    ('MOSE 500', [('**/api/mose*', errore500)]),
    ('fermate rovinate', [('**/api/stops*', rovinata)]),
    ('dati fissi 500', [('**/api/fissi*', errore500)]),
    ('mezzi rovinati', [('**/api/vehicles*', rovinata), ('**/api/stream*', errore500)]),
    ('servizio lentissimo (avvisi 8 s)', [('**/api/avvisi*', lenta)]),
]
with sync_playwright() as p:
    br = p.chromium.launch()
    for i, (nome, rotte) in enumerate(CASI):
        print(f'== {nome}')
        ctx, pg, errs = apri(br, i, rotte)
        pg.goto(BASE + '/'); pg.wait_for_timeout(5000)
        check(pg.query_selector('#map') is not None and vivo(pg), 'app aperta e comandi principali che rispondono')
        check(not errs, f'nessun errore non gestito {errs[:2]}')
        pg.screenshot(path=str(OUT / f"guasto-{nome.split(' ')[0]}-{i}.png")); ctx.close()

    print('== memoria del browser piena')
    piena = """(()=>{const o=Storage.prototype.setItem;Storage.prototype.setItem=function(k,v){if(String(k).startsWith('tpl.')&&String(k)!=='tpl.guida')throw new DOMException('pieno','QuotaExceededError');return o.call(this,k,v)}})()"""
    ctx, pg, errs = apri(br, 50, init=[piena])
    pg.goto(BASE + '/?da=f:nav:5031&a=f:aut:6073'); pg.wait_for_selector('.pp-opt', timeout=60000); pg.wait_for_timeout(800)
    pg.click('.pp-opt'); pg.wait_for_selector('.pp-acts', timeout=8000)
    sv = pg.query_selector('.pp-svtrip')
    if sv: sv.click(); pg.wait_for_timeout(800)
    toast = pg.inner_text('#toast') if pg.query_selector('#toast:not([hidden])') else ''
    check(not errs, f'memoria piena: nessun errore non gestito {errs[:2]}')
    check('Memoria del browser piena' in toast and 'Salvato' not in toast, f'«Salva viaggio» con memoria piena: lo dice, non finge il salvataggio «{toast[:70]}»')
    ctx.close()

    print('== due schede con lo stesso viaggio')
    ctx, pg, errs = apri(br, 51)
    pg.goto(BASE + '/?da=f:nav:5031&a=f:aut:6073'); pg.wait_for_selector('.pp-opt', timeout=60000); pg.wait_for_timeout(800)
    pg.click('.pp-opt'); pg.wait_for_selector('.pp-go', timeout=8000); pg.click('.pp-go'); pg.wait_for_selector('.vg-now', timeout=8000)
    p2 = ctx.new_page(); e2 = []; p2.on('pageerror', lambda e: e2.append(str(e)))
    p2.route('**/vendor/leaflet/leaflet.js', lambda r: r.fulfill(body=STUB, content_type='application/javascript'))
    p2.route('https://tile.openstreetmap.org/**', lambda r: r.abort())
    p2.goto(BASE + '/?apri=viaggio'); p2.wait_for_selector('.vg-now', timeout=15000)
    check(p2.inner_text('.vg-t') == pg.inner_text('.vg-t'), 'seconda scheda: stesso viaggio, stessa indicazione')
    p2.click('.vg-acts .vg-end'); p2.wait_for_timeout(600)
    if p2.query_selector('.vg-acts .vg-end'): p2.click('.vg-acts .vg-end'); p2.wait_for_timeout(800)   # conferma con un secondo tocco
    fine2 = p2.query_selector('.vg-now') is None
    pg.reload(); pg.wait_for_timeout(3000)
    check(fine2 and pg.evaluate("localStorage.getItem('tpl.viaggio')") in (None, 'null'), 'viaggio terminato in una scheda: chiuso anche nell\'altra dopo il ricaricamento')
    check(not errs and not e2, f'nessun errore {(errs + e2)[:2]}')
    ctx.close()

    print('== telefono con un altro fuso orario (New York)')
    ctx, pg, errs = apri(br, 52, tz='America/New_York')
    pg.goto(BASE + '/?da=f:nav:5031&a=f:aut:6073'); pg.wait_for_selector('.pp-opt', timeout=60000); pg.wait_for_timeout(800)
    t_app = pg.inner_text('#clock-time') if pg.query_selector('#clock-time') else ''
    rome = time.strftime('%H:%M', time.gmtime(time.time() + 3600))   # novembre: CET = UTC+1
    check(t_app.startswith(rome), f'orologio dell\'app sull\'ora di Venezia ({t_app} contro {rome})')
    first = pg.inner_text('.pp-opt').split('\n')[0]
    check(first[:2].isdigit(), f'orari delle soluzioni ({first[:14]})')
    check(not errs, f'nessun errore {errs[:2]}')
    ctx.close()
    br.close()
print(f'\nFALLITI: {len(fails)}')
for f in fails: print(' -', f)
sys.exit(1 if fails else 0)
