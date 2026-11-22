# PIANIFICATORE CON L'ACQUA ALTA E LE PASSERELLE (v33.12), con il server di prova già avviato (vedi run.py) e una copia del ramo «dati»
# (rete pedonale vera, servita come se fosse il CDN):
#   git worktree add /tmp/dati origin/dati   (oppure: git archive origin/dati pedoni indice.json | tar -x -C /tmp/dati)
#   DATI_DIR=/tmp/dati python3 tests/ui/passerelle.py http://localhost:3111 /tmp/ui
# A +110 cm simulati (?marea=110, solo in locale) i percorsi a piedi lungo Zattere, Giudecca e Lista di Spagna devono dire «su passerella»;
# senza acqua alta nessuna indicazione. Senza DATI_DIR la prova si salta (la rete pedonale non è su main).
import sys, os, json, pathlib
from playwright.sync_api import sync_playwright
BASE = sys.argv[1] if len(sys.argv) > 1 else 'http://localhost:3111'
OUT = pathlib.Path(sys.argv[2] if len(sys.argv) > 2 else '/tmp/ui'); OUT.mkdir(parents=True, exist_ok=True)
DATI = pathlib.Path(os.environ.get('DATI_DIR', ''))
if not os.environ.get('DATI_DIR') or not (DATI / 'indice.json').is_file():
    print('DATI_DIR non indicata o senza indice.json: prova saltata'); sys.exit(0)
IND = json.loads((DATI / 'indice.json').read_text())
CDN = 'https://cdn.jsdelivr.net/gh/prova/prova@' + 'a' * 40
GUIDE = "try{localStorage.setItem('tpl.guida', JSON.stringify({v:'v33.12', mappa:true, pannello:true}))}catch(e){}"
fails = []
def check(ok, msg):
    print(('  ok   ' if ok else '  FAIL ') + msg)
    if not ok: fails.append(msg)
def fissi(r):
    m = json.loads(r.fetch().text()); m['cdn'] = [CDN]; m['pedoni'] = IND['pedoni']; r.fulfill(body=json.dumps(m), content_type='application/json')
def cdn(r):
    f = DATI / r.request.url.split('@' + 'a' * 40, 1)[-1].lstrip('/')
    r.fulfill(body=f.read_bytes(), content_type='application/json', headers={'Access-Control-Allow-Origin': '*'}) if f.is_file() else r.fulfill(status=404, body='')
CASI = [('Zattere', '45.43000,12.32790', '45.42940,12.32630', 'Rio Terà Foscarini'), ('Giudecca', '45.42554,12.33100', '45.42540,12.33400', 'Campo San Giacomo'),
        ('Lista di Spagna', '45.44130,12.32285', '45.44281,12.32459', 'Lista di Spagna')]
with sync_playwright() as p:
    br = p.chromium.launch()
    for marea in (110, None):
        for nome, a, b, desc in CASI:
            ctx = br.new_context(viewport={'width': 390, 'height': 844}, has_touch=True); ctx.add_init_script(GUIDE)
            ctx.route('**/api/fissi', fissi); ctx.route(CDN + '/**', cdn); ctx.route('**/*tile.openstreetmap.org/**', lambda r: r.abort())
            pg = ctx.new_page(); errs = []; pg.on('pageerror', lambda e: errs.append(str(e)))
            pg.goto(f"{BASE}/?{'marea=%d&' % marea if marea else ''}da=p:{a}&a=p:{b}")
            try:
                pg.wait_for_selector('.pp-walkonly', timeout=30000); pg.wait_for_timeout(6000)
                t = pg.inner_text('.pp-walkonly')
                if marea: check('su passerella' in t and desc in t, f'+{marea} cm, {nome}: «{t.splitlines()[-1][:120]}»')
                else: check('passerella' not in t, f'marea normale, {nome}: nessuna passerella')
                if marea and nome == 'Zattere': pg.screenshot(path=str(OUT / 'passerelle-zattere.png'))
            except Exception as ex: check(False, f'{nome}: nessuna soluzione a piedi ({str(ex)[:60]})')
            check(not errs, f'{nome}: nessun errore {errs[:1]}')
            ctx.close()
    br.close()
print(f'\nFALLITI: {len(fails)}')
sys.exit(1 if fails else 0)
