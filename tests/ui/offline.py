# PROVE SENZA CONNESSIONE (service worker attivo, Leaflet vero) con il server di prova già avviato (vedi run.py):
#   python3 tests/ui/offline.py http://localhost:3111 /tmp/ui        (TESTO=1.3 per il testo «Molto grande»)
# Prima con la rete: l'app salva guscio, marea, avvisi e dati dell'acqua alta. Poi senza rete e ricaricando: l'app si apre, dice che è
# senza connessione e mostra i dati salvati come tali (con l'ora), senza errori; tornata la rete l'avviso sparisce.
# v33.12: orari programmati di oggi salvati dal CDN (finto: file generati da tests/ui/orari-finti.js) e mostrati senza rete nel pannello
# della fermata come «Senza rete · orari programmati», mai come tempo reale; fermate e linee dai dati fissi salvati.
import sys, json, pathlib, os, math, subprocess, tempfile, collections
from playwright.sync_api import sync_playwright
BASE = sys.argv[1] if len(sys.argv) > 1 else 'http://localhost:3111'
OUT = pathlib.Path(sys.argv[2] if len(sys.argv) > 2 else '/tmp/ui'); OUT.mkdir(parents=True, exist_ok=True)
TESTO = os.environ.get('TESTO', '')
TESTO_JS = f"try{{localStorage.setItem('tpl.testo','{TESTO}')}}catch(e){{}}" if TESTO in ('1.15', '1.3') else "0"
GUIDE_OFF = "try{localStorage.setItem('tpl.guida', JSON.stringify({v:'v33.12', mappa:true, pannello:true}))}catch(e){}"
fails = []
def check(ok, msg):
    print(('  ok   ' if ok else '  FAIL ') + msg)
    if not ok: fails.append(msg)
import time
n, H = int(time.time() * 1000) // 600000 * 600000, 3600000
obs = [[n - k * 600000, 100 + k // 6] for k in range(36, -1, -1)]; fc = [[n + k * 600000, 108 + min(k, 18) // 2] for k in range(1, 72)]
TIDE = {'station': 'Punta Salute', 'cm': 108, 'ts': n, 'ageMin': 1, 'stale': False, 'category': {'key': 'sostenuta', 'label': 'Marea sostenuta'}, 'trend': {'dir': 'up', 'rate': 3, 'basis': 'misure'},
        'next': [{'type': 'max', 'cm': 117, 'ts': n + 3 * H}], 'source': {'name': 'CPSM', 'license': 'CC BY', 'url': 'https://dati.venezia.it/'},
        'chart': {'from': n - 6 * H, 'to': n + 12 * H, 'now': n, 'observed': obs, 'forecast': fc, 'extremes': [{'type': 'max', 'cm': 117, 'ts': n + 3 * H}]}, 'mose': {'stato': 'recesso'}}
# file degli orari di oggi come sul CDN (ramo «dati»), per le versioni dei GTFS del server di prova
ROOT = pathlib.Path(__file__).resolve().parents[2]; CDNDIR = pathlib.Path(tempfile.mkdtemp(prefix='orari-cdn-'))
gen = json.loads(subprocess.run(['node', str(ROOT / 'tests/ui/orari-finti.js'), str(CDNDIR)], capture_output=True, text=True, cwd=ROOT, check=True).stdout.strip().splitlines()[-1])
CDN = 'https://cdn.jsdelivr.net/gh/prova/prova@' + 'a' * 40
def cdn_route(r):
    rel = r.request.url.split('@' + 'a' * 40, 1)[-1].lstrip('/'); f = CDNDIR / rel
    r.fulfill(body=f.read_bytes(), content_type='application/json', headers={'Access-Control-Allow-Origin': '*'}) if f.is_file() else r.fulfill(status=404, body='')
def fissi_route(r):
    m = json.loads(r.fetch().text()); m['cdn'] = [CDN]
    for s_ in m.get('src', []):
        if gen['v'].get(s_['id']) == s_['v']: s_['orari'] = [gen['oggi']]
    r.fulfill(body=json.dumps(m), content_type='application/json')
# fermata della navigazione con più passaggi oggi (dal file generato)
nv = gen['v'].get('nav'); dayf = json.loads((CDNDIR / 'orari/nav' / (nv + '.json')).read_text())['giorni'][gen['oggi']]
D = json.loads((CDNDIR / 'orari/nav/g' / (dayf + '.json')).read_text()); cnt = collections.Counter()
for t in D['t']:
    if t[7] >= 0: cnt.update(D['p'][t[7]][0][:-1])
STOP = 'nav:' + cnt.most_common(1)[0][0]
with sync_playwright() as p:
    br = p.chromium.launch()
    ctx = br.new_context(viewport={'width': 390, 'height': 844}, has_touch=True)
    for s in (GUIDE_OFF, TESTO_JS): ctx.add_init_script(s)
    ctx.route('**/api/tide', lambda r: r.fulfill(body=json.dumps(TIDE), content_type='application/json'))
    ctx.route('**/*tile.openstreetmap.org/**', lambda r: r.abort())
    ctx.route('**/api/fissi', fissi_route); ctx.route(CDN + '/**', cdn_route)
    page = ctx.new_page(); errs = []; page.on('pageerror', lambda e: errs.append(str(e)))
    page.goto(BASE + '/'); page.wait_for_function('navigator.serviceWorker && navigator.serviceWorker.ready.then(()=>true)', timeout=30000)
    page.wait_for_timeout(3000); page.reload(); page.wait_for_timeout(4000)
    check(page.evaluate('!!navigator.serviceWorker.controller'), 'service worker attivo')
    page.click('#tide-btn'); page.wait_for_timeout(1500); page.keyboard.press('Escape')
    page.click('#avvisi-btn') if page.query_selector('#avvisi-btn') else None; page.wait_for_timeout(1500); page.keyboard.press('Escape')
    page.wait_for_timeout(3000)                                                   # livelli accesi da soli (+108): dati dell'acqua salvati
    saved = page.evaluate("({m: !!localStorage.getItem('tpl.marea'), a: !!localStorage.getItem('tpl.avvisi')})")
    check(saved['m'] and saved['a'], f'con la rete: marea e avvisi salvati nel telefono {saved}')
    check(page.is_hidden('#offline-bar'), 'con la rete: nessun avviso di connessione')
    page.evaluate("(async()=>{const O=await import('/js/orarioggi.js'); await O.prepara();})()"); page.wait_for_timeout(500)
    om = page.evaluate("JSON.parse(localStorage.getItem('tpl.orari')||'null')")
    check(bool(om) and all(gen['oggi'] in (om['s'].get(k) or {}).get('g', {}) for k in gen['v']), f'con la rete: orari programmati di oggi salvati per navigazione e autobus {list((om or {}).get("s", {}).keys())}')
    nc = page.evaluate("(async()=>{const c=await caches.open('tpl-fissi-1');return (await c.keys()).filter(r=>new URL(r.url).pathname.startsWith('/__orari/')).length})()")
    check(nc == len(gen['v']), f'un file per servizio nel telefono ({nc})')
    # ---- senza rete ----
    ctx.unroute('**/api/tide'); ctx.set_offline(True); page.reload(); page.wait_for_timeout(5000)
    check(page.query_selector('#map .leaflet-pane') is not None, 'senza rete: l\'app si apre (guscio dal service worker, mappa pronta)')
    check(page.is_visible('#offline-bar'), 'senza rete: avviso «Senza connessione» visibile')
    lab = page.get_attribute('#tide-btn', 'aria-label') or ''
    check('dati salvati' in lab, f'marea: dati salvati dichiarati «{lab}»')
    page.click('#tide-btn'); page.wait_for_timeout(800)
    tt = page.inner_text('#tide-body')
    check('Senza connessione: dati salvati' in tt, 'scheda della marea: dati salvati con l\'ora')
    page.screenshot(path=str(OUT / 'offline-marea.png')); page.keyboard.press('Escape'); page.wait_for_timeout(300)
    if page.query_selector('#avvisi-btn'):
        page.click('#avvisi-btn'); page.wait_for_timeout(800)
        check('avvisi salvati' in page.inner_text('#avvisi'), 'avvisi: salvati con l\'ora'); page.keyboard.press('Escape')
    page.evaluate("__map && __map.setView ? 0 : 0") if False else None
    acq = page.evaluate("(async()=>{const L=await import('/js/livelli.js'); const d=await L.carica(); return !!d && !!d.Q && !!d.P})()")
    check(acq, 'acqua alta: quote e passerelle dai dati salvati, senza rete')
    # pannello della fermata senza rete: solo orari programmati di oggi, dichiarati
    page.goto(BASE + '/?fermata=' + STOP) if False else page.evaluate(f"history.replaceState(null,'','/?fermata={STOP}')"); page.reload(); page.wait_for_timeout(6000)
    try:
        page.wait_for_selector('#panel:not([hidden]) #psub', timeout=8000); page.wait_for_timeout(1500)
        sub = page.inner_text('#psub'); lst = page.inner_text('#plist')
        check('Senza rete · orari programmati' in sub, f'fermata senza rete: «{sub}»')
        check('solo gli orari programmati' in lst and 'Live' not in sub, 'nota «Senza connessione: solo gli orari programmati di oggi»')
        rows = page.evaluate("document.querySelectorAll('#plist .dep').length")
        check(rows > 0, f'passaggi programmati mostrati ({rows})')
        check(page.evaluate("[...document.querySelectorAll('#plist .dst')].every(e=>/Da orario/.test(e.textContent))"), 'ogni passaggio «Da orario», nessun ritardo o mezzo')
        page.screenshot(path=str(OUT / 'offline-fermata.png'))
    except Exception as ex: check(False, f'pannello della fermata senza rete: {str(ex)[:80]} | {page.url} | idx={page.evaluate("!!localStorage.getItem(\'tpl.fissi.indice\')")} toast={page.evaluate("document.getElementById(\'toast\')?.textContent||\'\'")}')
    bar = page.evaluate("(()=>{const b=document.getElementById('offline-bar').getBoundingClientRect();const o=['#plan-btn','#info-fab','#controls .group','#sciopero-btn'].flatMap(s=>[...document.querySelectorAll(s)]).filter(e=>e.offsetParent!==null).map(e=>e.getBoundingClientRect());return o.every(r=>!(r.left<b.right&&r.right>b.left&&r.top<b.bottom&&r.bottom>b.top))&&b.left>=0&&b.right<=innerWidth})()")
    check(bar, 'avviso di connessione dentro lo schermo, non copre i pulsanti')
    page.screenshot(path=str(OUT / 'offline-mappa.png'))
    check(not errs, f'senza rete: nessun errore {errs[:2]}')
    # ---- di nuovo in rete ----
    ctx.set_offline(False); page.wait_for_timeout(800)
    check(page.is_hidden('#offline-bar'), 'tornata la rete: l\'avviso sparisce')
    br.close()
print(f'\nFALLITI: {len(fails)}')
sys.exit(1 if fails else 0)
