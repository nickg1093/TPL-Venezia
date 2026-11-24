# SIMULAZIONE SUL CAMPO DEL VIAGGIO GUIDATO (v34): posizioni GPS progressive con l'orologio del browser controllato.
# Server di prova già avviato (feed finto):
#   AVVISI_ARCHIVIO=0 DATI_CDN=0 MAREA_ARCHIVIO=0 TRUST_PROXY=1 PORT=3111 node -r ./tests/fakefeed.js server.js
#   python3 tests/ui/viaggio-gps.py http://localhost:3111 /tmp/ui
# Scenari: salita regolare, mezzo perso (ancora al pontile), discesa regolare, discesa mancata, salto del GPS, GPS negato,
# app in secondo piano (GPS spento), rete assente durante il viaggio, corsa soppressa dal tempo reale, fermata sospesa e nebbia.
import sys, os, json, pathlib, time, math
from playwright.sync_api import sync_playwright
BASE = sys.argv[1] if len(sys.argv) > 1 else 'http://localhost:3111'
OUT = pathlib.Path(sys.argv[2] if len(sys.argv) > 2 else '/tmp/ui'); OUT.mkdir(parents=True, exist_ok=True)
STUB = (pathlib.Path(__file__).parent / 'leaflet-stub.js').read_text()
GUIDE_OFF = "try{localStorage.setItem('tpl.guida', JSON.stringify({v:'v34', mappa:true, pannello:true}))}catch(e){}"
fails = []
info = {}
nip = [0]
def check(ok, msg):
    print(('  ok   ' if ok else '  FAIL ') + msg)
    if not ok: fails.append(msg)
def offset(lat, lon, dn, de):   # metri verso nord / est
    return lat + dn / 111320, lon + de / (111320 * math.cos(math.radians(lat)))

def nuovo(br, geo=True, avvisi=None, trip=None):
    ctx = br.new_context(viewport={'width': 390, 'height': 844}, has_touch=True,
                         permissions=['geolocation', 'notifications'] if geo else ['notifications'],
                         geolocation={'latitude': 45.4380, 'longitude': 12.3180},
                         extra_http_headers={'X-Forwarded-For': f'10.11.{os.getpid() % 250}.{nip[0] % 250}'})   # una persona = un IP: i limiti di frequenza non falsano la prova
    nip[0] += 1
    ctx.add_init_script(GUIDE_OFF)
    if os.environ.get('TESTO') in ('1.15', '1.3'): ctx.add_init_script(f"try{{localStorage.setItem('tpl.testo','{os.environ['TESTO']}')}}catch(e){{}}")
    ctx.add_init_script("try{Object.defineProperty(Notification,'permission',{get:()=>'granted'});Notification.requestPermission=()=>Promise.resolve('granted')}catch(e){}")
    page = ctx.new_page(); errs = []
    page.on('pageerror', lambda e: errs.append(str(e)))
    page.route('**/vendor/leaflet/leaflet.js', lambda r: r.fulfill(body=STUB, content_type='application/javascript'))
    page.route('**/vendor/leaflet/leaflet.css', lambda r: r.fulfill(body='', content_type='text/css'))
    page.route('https://tile.openstreetmap.org/**', lambda r: r.abort())
    if avvisi: page.route('**/api/avvisi*', avvisi)
    if trip: page.route('**/api/trip?*', trip)
    page.clock.install()
    page.goto(BASE + '/?da=f:nav:5031&a=f:aut:6073'); page.wait_for_selector('.pp-opt', timeout=30000); page.clock.run_for(800)
    page.click('.pp-top .pp-opt'); page.wait_for_selector('.pp-go', timeout=8000)
    page.click('.pp-go'); page.wait_for_selector('.vg-now', timeout=8000); page.clock.run_for(2000)
    J = page.evaluate("JSON.parse(localStorage.getItem('tpl.viaggio'))")
    return ctx, page, errs, J

def vai(page, ms):              # porta l'orologio del browser all'istante ms (in passi, così girano i timer)
    now = page.evaluate('Date.now()')
    if ms > now: page.clock.run_for(int(ms - now))
def pos(ctx, page, lat, lon, acc=15, passi=2):   # letture GPS ripetute (ogni 12 s), come un telefono fermo o in movimento
    for i in range(passi):
        j = (i % 2) * 0.00002      # piccolo tremolio: Chromium avvisa il sito solo se la posizione cambia (come un telefono vero, che oscilla)
        ctx.set_geolocation({'latitude': lat + j, 'longitude': lon, 'accuracy': acc}); page.clock.run_for(12000)
    page.clock.run_for(16000)    # un giro del timer del viaggio (15 s): ridisegno
def gw(page):
    e = page.query_selector('.vg-gw'); return e.inner_text().strip() if e else ''
def mod(page, expr):            # stato del modulo del viaggio (stessa istanza della pagina)
    return page.evaluate(f"import('/js/viaggio.js').then(m=>{expr})")

with sync_playwright() as p:
    br = p.chromium.launch()
    # ---- 1. salita regolare poi mezzo perso: stesso viaggio, due persone ----
    print('== salita: regolare e mezzo perso')
    ctx, page, errs, J = nuovo(br)
    R = [l for l in J['legs'] if l['t'] == 'r']; r0 = R[0]; info['stop'] = r0['da']['id']
    da = r0['da']; dep = da.get('live') or da['ms']
    check(bool(R) and isinstance(da.get('lat'), (int, float)), f"viaggio iniziato: {len(R)} corse, prima da {da['name']} alle {time.strftime('%H:%M', time.localtime(dep / 1000))}")
    vai(page, dep - 4 * 60000)
    pos(ctx, page, *offset(da['lat'], da['lon'], 150, 0))
    check(mod(page, 'm.gpsOn()'), 'GPS acceso a piedi verso la fermata')
    check('da ' + da['name'] in page.inner_text('.vg-gpst') or 'Sei a ' in page.inner_text('.vg-gpst'), f"distanza dalla fermata: «{page.inner_text('.vg-gpst')}»")
    pos(ctx, page, da['lat'], da['lon'])
    check(page.inner_text('.vg-gpst').startswith('Sei a ' + da['name']), f"arrivato al pontile: «{page.inner_text('.vg-gpst')}»")
    vai(page, dep + 30000)
    check(page.get_attribute('.vg', 'data-ph').startswith('bordo') or page.get_attribute('.vg', 'data-ph').startswith('scendi'), 'dopo la partenza la guida passa a «a bordo»')
    # 1a. a bordo: si allontana dal pontile lungo la linea
    lat1, lon1 = da['lat'], da['lon']
    a0 = r0['a']; steps = 4
    for i in range(1, steps + 1):
        f = i / (steps + 6)
        pos(ctx, page, lat1 + (a0['lat'] - lat1) * f, lon1 + (a0['lon'] - lon1) * f, passi=1)
    check(mod(page, 'm.gpsOn()'), 'a bordo nei primi minuti: GPS acceso per controllare la salita')
    check(gw(page) == '', 'a bordo in movimento: nessun avviso di mezzo perso')
    page.screenshot(path=str(OUT / 'gps-1-bordo.png'))
    ctx.close()
    # 1b. ancora al pontile 2 minuti e mezzo dopo la partenza
    ctx, page, errs2, J = nuovo(br)
    da = [l for l in J['legs'] if l['t'] == 'r'][0]['da']; dep = da.get('live') or da['ms']
    vai(page, dep - 60000); pos(ctx, page, da['lat'], da['lon'])
    vai(page, dep + 150000); pos(ctx, page, *offset(da['lat'], da['lon'], 10, 5))
    t = gw(page)
    check(t.startswith('Sei ancora a ' + da['name']) and 'Ricalcola da qui' in t, f'mezzo perso: «{t}»')
    check(page.query_selector('.vg-gw[role=alert]') is not None, 'avviso annunciato ai lettori di schermo (role=alert)')
    page.screenshot(path=str(OUT / 'gps-2-perso.png'))
    # 1c. salto del GPS isolato: una lettura lontana non cancella né crea avvisi a caso
    vai(page, dep + 200000)
    ctx.set_geolocation({'latitude': da['lat'] + 0.01, 'longitude': da['lon'], 'accuracy': 15}); page.clock.run_for(16000)
    check(page.query_selector('.vg') is not None, 'salto del GPS: la guida resta')
    pos(ctx, page, da['lat'], da['lon'])      # di nuovo letture buone al pontile
    page.click('.vg-acts .vg-recalc')
    for _ in range(40):
        page.clock.run_for(500); page.wait_for_timeout(250)
        if page.query_selector('.vg') is None and page.query_selector('.pp-opt, .pp-empty, .pp-err'): break
    rc = page.evaluate("[...document.querySelectorAll('.pp-opt, .pp-empty, .pp-err, .vg')].map(e=>e.className).slice(0,3)")
    check(page.query_selector('.vg') is None and page.query_selector('.pp-opt') is not None, f'«Ricalcola da qui» riapre il pianificatore con nuove soluzioni {rc}')
    fr = page.get_attribute('.pp-sum', 'aria-label') if page.query_selector('.pp-sum') else ''
    check('da La mia posizione' in fr, f'ricalcolo dalla posizione del telefono (ancora al pontile), non dalla fermata stimata di arrivo «{fr[40:110]}»')
    page.screenshot(path=str(OUT / 'gps-2b-ricalcola.png'))
    ctx.close(); errs += errs2

    # ---- 2. discesa regolare e discesa mancata ----
    print('== discesa: regolare e mancata')
    for caso in ('regolare', 'mancata'):
        ctx, page, e3, J = nuovo(br)
        R = [l for l in J['legs'] if l['t'] == 'r']; rl = R[0]; a = rl['a']; arr = a.get('live') or a['ms']
        vai(page, arr - 2 * 60000); pos(ctx, page, *offset(a['lat'], a['lon'], -400, 0))
        check(mod(page, 'm.gpsOn()'), f'{caso}: GPS acceso prima di scendere')
        vai(page, arr + 3 * 60000)
        if caso == 'regolare': pos(ctx, page, *offset(a['lat'], a['lon'], 60, 80))      # a piedi vicino
        else: pos(ctx, page, *offset(a['lat'], a['lon'], 1800, 900))                   # rimasto a bordo
        t = gw(page)
        if caso == 'regolare': check(t == '', 'discesa regolare: nessun avviso')
        else: check('se non sei sceso' in t and a['name'] in t, f'discesa mancata: «{t}»')
        page.screenshot(path=str(OUT / f'gps-3-discesa-{caso}.png'))
        vai(page, arr + 8 * 60000)
        check(gw(page) == '', f'{caso}: dopo 8 minuti il controllo finisce')
        ctx.close(); errs += e3

    # ---- 3. GPS negato: la guida funziona con i soli orari ----
    print('== GPS negato')
    ctx, page, e4, J = nuovo(br, geo=False)
    da = [l for l in J['legs'] if l['t'] == 'r'][0]['da']; vai(page, (da.get('live') or da['ms']) - 3 * 60000)
    g = page.inner_text('.vg-gpst') if page.query_selector('.vg-gpst') else ''
    check(page.query_selector('.vg-now') is not None and g != '', f'senza permesso: guida a orari e riga chiara «{g}»')
    check(gw(page) == '', 'senza permesso: nessun avviso dalla posizione')
    ctx.close(); errs += e4

    # ---- 4. secondo piano, rete assente, soppressa dal tempo reale ----
    print('== secondo piano, rete assente, corsa soppressa')
    stato = {'canc': False}
    def trip(route):
        r = route.fetch(); d = r.json()
        if stato['canc']: d['cancelled'] = True
        route.fulfill(response=r, body=json.dumps(d))
    ctx, page, e5, J = nuovo(br, trip=trip)
    da = [l for l in J['legs'] if l['t'] == 'r'][0]['da']; dep = da.get('live') or da['ms']
    vai(page, dep - 3 * 60000); pos(ctx, page, *offset(da['lat'], da['lon'], 100, 0))
    check(mod(page, 'm.gpsOn()'), 'GPS acceso verso la fermata')
    page.evaluate("Object.defineProperty(document,'hidden',{configurable:true,get:()=>true});document.dispatchEvent(new Event('visibilitychange'))")
    check(not mod(page, 'm.gpsOn()'), 'app in secondo piano: GPS spento')
    page.evaluate("Object.defineProperty(document,'hidden',{configurable:true,get:()=>false});document.dispatchEvent(new Event('visibilitychange'))")
    for _ in range(20):
        page.clock.run_for(500); page.wait_for_timeout(100)      # il permesso si legge in modo asincrono
        if mod(page, 'm.gpsOn()'): break
    check(mod(page, 'm.gpsOn()'), 'di nuovo davanti: GPS riacceso')
    ctx.set_offline(True); page.clock.run_for(60000)
    check(page.query_selector('.vg-now') is not None, 'rete assente per un minuto: la guida resta con gli orari salvati')
    ctx.set_offline(False); stato['canc'] = True
    page.clock.run_for(35000); page.wait_for_timeout(500); page.clock.run_for(16000)
    w = page.inner_text('.vg-warn') if page.query_selector('.vg-warn') else ''
    check('soppressa' in w and 'Ricalcola da qui' in w, f'corsa soppressa dal tempo reale: «{w}»')
    page.screenshot(path=str(OUT / 'gps-4-soppressa.png'))
    ctx.close(); errs += e5

    # ---- 5. fermata di salita sospesa e nebbia durante il viaggio ----
    print('== fermata sospesa e nebbia')
    def avvisi(route):
        r = route.fetch(); d = r.json(); n = int(time.time() * 1000); H = 3600000
        items = d.get('items', [])
        items.insert(0, {'id': 'prova-sosp', 'src': 'nav', 'title': 'Pontile sospeso per lavori', 'text': 'Le corse non fermano.', 'effect': 'no_service', 'severity': 'severe',
                         'dated': True, 'from': n - H, 'to': n + 6 * H, 'stops': [info['stop']], 'lines': [], 'url': None})
        items.insert(0, {'id': 'prova-nebbia', 'src': 'nav', 'title': 'Nebbia: possibili corse soppresse', 'text': 'Visibilità ridotta in laguna.', 'effect': 'reduced', 'general': True,
                         'dated': False, 'from': n - H, 'to': n + 4 * H, 'lines': [], 'stops': [], 'url': None})
        d['items'] = items; route.fulfill(response=r, body=json.dumps(d))
    ctx, page, e6, J = nuovo(br, avvisi=avvisi)
    info['stop'] = [l for l in J['legs'] if l['t'] == 'r'][0]['da']['id']   # la fermata di salita del viaggio appena iniziato
    page.goto(BASE + '/?apri=viaggio'); page.wait_for_selector('.vg-now', timeout=15000); page.clock.run_for(2000)   # riaperta dalla notifica
    page.screenshot(path=str(OUT / 'gps-5-avvisi.png'))
    sosp_ok = 'potrebbe non fermarsi' in page.inner_text('body')
    check(sosp_ok, 'in viaggio: fermata di salita sospesa detta chiaramente («potrebbe non fermarsi»)')
    check('Nebbia' in page.inner_text('body'), 'in viaggio: avviso di nebbia su tutta la rete visibile')
    ctx.close(); errs += e6

    errs = [e for e in errs if 'push service' not in e.lower() and 'ERR_' not in e and 'tile' not in e]
    check(not errs, f'nessun errore nella pagina {errs[:3]}')
    br.close()
print(f'\nFALLITI: {len(fails)}')
for f in fails: print(' -', f)
sys.exit(1 if fails else 0)
