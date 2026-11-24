# SCENARI DI MAREA NEL PIANIFICATORE (v34), con il server di prova già avviato (vedi run.py):
#   python3 tests/ui/marea-scenari.py http://localhost:3111 /tmp/ui
# A bassa marea (-70 cm), B acqua alta moderata (105 cm), C marea che sale durante il viaggio (80 → 118), dati della marea vecchi
# (ultima misura di 5 ore fa), servizio della marea non raggiungibile, risposta rovinata. Percorso a piedi da Piazzale Roma a San Marco.
import sys, json, pathlib, time, os
from playwright.sync_api import sync_playwright
BASE = sys.argv[1] if len(sys.argv) > 1 else 'http://localhost:3111'
OUT = pathlib.Path(sys.argv[2] if len(sys.argv) > 2 else '/tmp/ui'); OUT.mkdir(parents=True, exist_ok=True)
STUB = (pathlib.Path(__file__).parent / 'leaflet-stub.js').read_text()
GUIDE_OFF = "try{localStorage.setItem('tpl.guida', JSON.stringify({v:'v34', mappa:true, pannello:true}))}catch(e){}"
DA, A = 'p:45.4379,12.3187', 'p:45.4341,12.3388'
fails = []
def check(ok, msg):
    print(('  ok   ' if ok else '  FAIL ') + msg)
    if not ok: fails.append(msg)

def marea(f, eta_min=1, stale=False, mose='riposo'):
    n = int(time.time() * 1000); H = 3600000; ts = n - eta_min * 60000
    obs = [[ts - k * 600000, round(f(ts - k * 600000))] for k in range(36, -1, -1)]
    fc = [[ts + k * 600000, round(f(ts + k * 600000))] for k in range(0, 37)]
    peak = max(fc, key=lambda x: x[1])
    return {'station': 'Punta Salute', 'cm': round(f(ts)), 'ts': ts, 'ageMin': eta_min, 'stale': stale,
            'category': {'key': 'x', 'label': 'Marea'}, 'trend': {'dir': 'up'}, 'next': [{'type': 'max', 'cm': peak[1], 'ts': peak[0]}], 'history': obs,
            'source': {'name': 'CPSM', 'license': 'CC BY', 'url': 'https://dati.venezia.it/'},
            'chart': {'from': ts - 6 * H, 'to': ts + 6 * H, 'now': n, 'observed': obs, 'forecast': fc, 'extremes': []}, 'mose': {'stato': mose, 'sem': 'verde'}}

n0 = time.time() * 1000
SCEN = [
    ('A-bassa', lambda r: r.fulfill(body=json.dumps(marea(lambda t: -70)), content_type='application/json')),
    ('B-105', lambda r: r.fulfill(body=json.dumps(marea(lambda t: 105)), content_type='application/json')),
    ('C-sale', lambda r: r.fulfill(body=json.dumps(marea(lambda t: min(118, 80 + max(0, t - n0) / 60000 * 1.2))), content_type='application/json')),
    ('C-vecchia', lambda r: r.fulfill(body=json.dumps(marea(lambda t: 112, eta_min=300, stale=True)), content_type='application/json')),
    ('C-assente', lambda r: r.fulfill(status=503, body='non disponibile', content_type='text/plain')),
    ('C-rovinata', lambda r: r.fulfill(body='{"station":', content_type='application/json')),
]
with sync_playwright() as p:
    br = p.chromium.launch()
    for i, (nome, fake) in enumerate(SCEN):
        print(f'== {nome}')
        ctx = br.new_context(viewport={'width': 390, 'height': 844}, has_touch=True, extra_http_headers={'X-Forwarded-For': f'10.12.{os.getpid() % 250}.{i}'})
        ctx.add_init_script(GUIDE_OFF)
        if os.environ.get('TESTO') in ('1.15', '1.3'): ctx.add_init_script(f"try{{localStorage.setItem('tpl.testo','{os.environ['TESTO']}')}}catch(e){{}}")
        pg = ctx.new_page(); errs = []
        pg.on('pageerror', lambda e: errs.append(str(e)))
        pg.route('**/vendor/leaflet/leaflet.js', lambda r: r.fulfill(body=STUB, content_type='application/javascript'))
        pg.route('**/vendor/leaflet/leaflet.css', lambda r: r.fulfill(body='', content_type='text/css'))
        pg.route('https://tile.openstreetmap.org/**', lambda r: r.abort())
        pg.route('**/api/tide*', fake)
        pg.goto(f'{BASE}/?da={DA}&a={A}'); pg.wait_for_selector('.pp-opt', timeout=60000); pg.wait_for_timeout(1500)
        nsol = len(pg.query_selector_all('.pp-opt'))
        pg.click('.pp-opt'); pg.wait_for_timeout(1500)
        det = pg.inner_text('#plist') if pg.query_selector('#plist') else pg.inner_text('body')
        tide = pg.inner_text('.pp-tide') if pg.query_selector('.pp-tide') else ''
        pg.screenshot(path=str(OUT / f'marea-{nome}.png'))
        check(nsol >= 1, f'soluzioni trovate ({nsol})')
        if nome == 'A-bassa':
            check(tide == '', 'bassa marea: nessuna nota di acqua alta')
        elif nome == 'B-105':
            check('105 cm' in tide and ('passerelle' in tide or 'allagat' in tide), f'105 cm: nota con livello e indicazioni per i tratti a piedi «{tide[:110]}»')
        elif nome == 'C-sale':
            check(tide != '' and any(f'{c} cm' in tide for c in range(95, 119)), f'marea in salita: si usa il colmo previsto durante il viaggio, non la misura di adesso «{tide[:90]}»')
        elif nome == 'C-vecchia':
            check('non aggiornati' in tide and '5 ore' in tide, f'dati di 5 ore fa: la previsione resta ma si dice che è vecchia «{tide[-140:]}»')
        else:
            check(tide == '' and 'Inizia il viaggio' in det, 'senza dati della marea: nessuna nota inventata, il pianificatore funziona')
        check(not errs, f'nessun errore nella pagina {errs[:2]}')
        ctx.close()
    br.close()
print(f'\nFALLITI: {len(fails)}')
for f in fails: print(' -', f)
sys.exit(1 if fails else 0)
