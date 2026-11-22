# PROVE DELL'INTERFACCIA DEL VIAGGIO GUIDATO e di «I miei viaggi» (Playwright + Chromium), con il server di prova già avviato:
#   AVVISI_ARCHIVIO=0 DATI_CDN=0 MAREA_ARCHIVIO=0 TRUST_PROXY=1 PORT=3111 node -r ./tests/fakefeed.js server.js      poi:   python3 tests/ui/viaggio.py http://localhost:3111 /tmp/ui
# Chromium senza servizio push: gli avvisi passano per la lettura con l'app aperta (la strada dei dispositivi senza Web Push).
import re, sys, os, json, pathlib, time, math, datetime
from playwright.sync_api import sync_playwright
BASE = sys.argv[1] if len(sys.argv) > 1 else 'http://localhost:3111'
OUT = pathlib.Path(sys.argv[2] if len(sys.argv) > 2 else '/tmp/ui'); OUT.mkdir(parents=True, exist_ok=True)
STUB = (pathlib.Path(__file__).parent / 'leaflet-stub.js').read_text()
GUIDE_OFF = "try{localStorage.setItem('tpl.guida', JSON.stringify({v:'v33.12', mappa:true, pannello:true}))}catch(e){}"
fails = []
def check(ok, msg):
    print(('  ok   ' if ok else '  FAIL ') + msg)
    if not ok: fails.append(msg)
def rectf(page, sel):
    return page.evaluate("s=>{const e=document.querySelector(s);if(!e||e.hidden)return null;const r=e.getBoundingClientRect();return r.width&&r.height?{l:r.left,t:r.top,r:r.right,b:r.bottom,w:r.width,h:r.height}:null}", sel)
def tide_fake(route):   # acqua alta: 120 cm per le prossime ore (nota sulla marea nei tratti a piedi a Venezia)
    n = int(time.time() * 1000); H = 3600000
    obs = [[n - k * 600000, 90] for k in range(36, -1, -1)]; fc = [[n + k * 600000, 120] for k in range(0, 37)]
    d = {'station': 'Punta Salute', 'cm': 90, 'ts': n, 'ageMin': 1, 'stale': False, 'category': {'key': 'sostenuta', 'label': 'Marea sostenuta'}, 'trend': {'dir': 'up'},
         'next': [{'type': 'max', 'cm': 120, 'ts': n + 3 * H}], 'history': obs, 'source': {'name': 'CPSM', 'license': 'CC BY', 'url': 'https://dati.venezia.it/'},
         'chart': {'from': n - 6 * H, 'to': n + 18 * H, 'now': n, 'observed': obs, 'forecast': fc, 'extremes': []}, 'mose': {'stato': 'programmato', 'sem': 'giallo'}}
    route.fulfill(body=json.dumps(d), content_type='application/json')
def wait_js(page, expr, ms=15000):
    t0 = time.time()
    while time.time() - t0 < ms / 1000:
        if page.evaluate(expr): return True
        page.wait_for_timeout(200)
    return False

tomorrow = (datetime.date.today() + datetime.timedelta(days=1)).strftime('%Y%m%d')
with sync_playwright() as p:
    br = p.chromium.launch()
    for name, w, h, theme in [('phone', 390, 844, 'light'), ('phone-dark', 390, 844, 'dark'), ('small', 360, 640, 'light'), ('desktop', 1440, 900, 'dark')]:
        print(f'== {name} {w}x{h} {theme}')
        ctx = br.new_context(viewport={'width': w, 'height': h}, has_touch=w < 500, permissions=['geolocation', 'notifications', 'clipboard-read', 'clipboard-write'],
                             geolocation={'latitude': 45.4386, 'longitude': 12.3195}, accept_downloads=True)
        ctx.add_init_script(GUIDE_OFF)
        if os.environ.get('TESTO') in ('1.15', '1.3'): ctx.add_init_script(f"try{{localStorage.setItem('tpl.testo','{os.environ['TESTO']}')}}catch(e){{}}")   # TESTO=1.3: stesse prove con il testo grande
        # Chromium senza interfaccia nega sempre le notifiche: permesso simulato come concesso (l'iscrizione push fallisce: si prova la strada «app aperta»)
        ctx.add_init_script("try{Object.defineProperty(Notification,'permission',{get:()=>'granted'});Notification.requestPermission=()=>Promise.resolve('granted')}catch(e){}")
        ctx.add_init_script(f"try{{localStorage.setItem('theme','{theme}')}}catch(e){{}}")
        page = ctx.new_page(); errs = []
        page.on('pageerror', lambda e: errs.append(str(e)))
        page.on('console', lambda m: errs.append(m.text) if m.type == 'error' and 'tile' not in m.text and 'push service' not in m.text.lower() and 'incognito' not in m.text and 'ERR_FAILED' not in m.text and '409' not in m.text else None)
        page.route('**/vendor/leaflet/leaflet.js', lambda r: r.fulfill(body=STUB, content_type='application/javascript'))
        page.route('**/vendor/leaflet/leaflet.css', lambda r: r.fulfill(body='', content_type='text/css'))
        page.route('**/api/tide', tide_fake)
        page.route('https://tile.openstreetmap.org/**', lambda r: r.abort())
        # percorso con «Adesso»: P.le Roma "G" -> Stazione Mestre FS
        page.goto(BASE + '/?da=f:nav:5031&a=f:aut:6073'); page.wait_for_selector('.pp-opt', timeout=30000); page.wait_for_timeout(800)
        page.screenshot(path=str(OUT / f'vg-{name}-1-list.png'))
        page.click('.pp-top .pp-opt'); page.wait_for_selector('.pp-acts', timeout=8000); page.wait_for_timeout(500)
        check(page.inner_text('.pp-go').strip() == 'Inizia il viaggio', '«Inizia il viaggio» nel dettaglio di una soluzione che parte adesso')
        acts = page.evaluate("[...document.querySelectorAll('.pp-acts2 .pp-act')].map(b=>b.innerText.trim())")
        check(acts == ['Salva viaggio', 'Condividi'], f'azioni secondarie (niente calendario) {acts}')
        check(page.query_selector('.pp-tide') is not None and '120 cm' in page.inner_text('.pp-tide'), 'nota sulla marea (120 cm) per i tratti a piedi a Venezia')
        check('MOSE' in page.inner_text('.pp-tide'), 'nota sul MOSE programmato')
        b = rectf(page, '.pp-go'); check(b and b['h'] >= 44 and b['r'] <= w, f'pulsante principale grande e dentro lo schermo {b}')
        page.screenshot(path=str(OUT / f'vg-{name}-2-detail.png'))
        # condividi come testo (senza navigator.share: negli appunti)
        page.evaluate("try{delete navigator.share}catch(e){}; navigator.share=undefined")
        page.click('.pp-txt'); page.wait_for_timeout(600)
        clip = page.evaluate("navigator.clipboard.readText()")
        check(clip.startswith('🧭 ') and '📅 ' in clip and '🏁 ' in clip and '[' in clip and 'Apri questa proposta: ' in clip and 'sol=' in clip, 'testo della proposta negli appunti, con simboli, linee e link alla proposta')
        check(page.query_selector('.pp-cal') is None, 'niente pulsante del calendario')
        # «Programmato» con il pianificatore aperto: nessuna richiesta di partenze di una fermata, nessun errore nel pannello (difetto trovato sul sito)
        page.click('label:has(input[value=sched])'); page.wait_for_timeout(1500)
        check('parametro id' not in page.inner_text('#plist') and page.query_selector('.pp-acts') is not None, '«Programmato» con il pianificatore aperto: dettaglio intatto')
        page.click('label:has(input[value=live])'); page.wait_for_timeout(800)
        # inizia il viaggio
        page.click('.pp-go'); page.wait_for_selector('.vg-now', timeout=8000)
        check(wait_js(page, "document.querySelector('.vg-note')?.innerText.length>20 && !/Attivo gli avvisi/.test(document.querySelector('.vg-note').innerText)"), 'stato delle notifiche detto chiaramente')
        note = page.inner_text('.vg-note'); print('     nota:', note)
        ws = page.evaluate("JSON.parse(localStorage.getItem('tpl.watches')||'[]').filter(w=>w.viaggio).map(w=>w.ruolo)")
        check(len(ws) >= 1 and ws[-1] == 'scendi', f'avvisi del viaggio creati {ws}')
        check(page.evaluate("!!JSON.parse(localStorage.getItem('tpl.viaggio')||'null')"), 'viaggio salvato sul dispositivo')
        check(page.inner_text('#pname').strip() == 'In viaggio', 'titolo «In viaggio»')
        v = rectf(page, '.vg-now'); check(v and v['r'] <= w + 1, 'indicazione del momento dentro lo schermo')
        page.screenshot(path=str(OUT / f'vg-{name}-3-live.png'))
        page.evaluate("document.querySelector('#plist').scrollTop=9999"); page.wait_for_timeout(200)
        page.screenshot(path=str(OUT / f'vg-{name}-3b-live-bottom.png'))
        # chiudi il pannello: il pulsante diventa «In viaggio»
        page.click('#pclose'); page.wait_for_timeout(500)
        fab = page.evaluate("(()=>{const b=document.getElementById('plan-btn');return {on:b.classList.contains('vg-on'),t:b.innerText,vis:!!b.offsetParent}})()")
        check(fab['on'] and 'IN VIAGGIO' in fab['t'].upper() and fab['vis'], f'pulsante «In viaggio» sulla mappa {fab}')
        fr = rectf(page, '#plan-btn'); check(fr and fr['r'] <= w - 50, f'pulsante non sotto i controlli a destra {fr}')
        page.screenshot(path=str(OUT / f'vg-{name}-4-fab.png'))
        page.click('#plan-btn'); page.wait_for_selector('.vg-now', timeout=5000)
        check(True, 'il pulsante riapre la schermata «In viaggio»')
        # «Pianifica un altro percorso»: il viaggio resta, in cima ai suggerimenti
        page.click('.vg-plan'); page.wait_for_timeout(400)
        check(page.query_selector('.pp-ends .pp-f') is not None, '«Pianifica un altro percorso» apre i campi di partenza e arrivo')
        page.click('.pp-f'); page.wait_for_timeout(300)
        check(page.query_selector('.pp-sug.vg-cur') is not None, '«Viaggio in corso» in cima ai suggerimenti del pianificatore')
        page.click('.pp-sug.vg-cur'); page.wait_for_selector('.vg-now', timeout=5000)
        # schermo acceso: interruttore; posizione a fasi e spiegazione di schermo spento / app chiusa
        check(page.query_selector('.vg-lockcb') is not None, 'interruttore «Schermo sempre acceso»')
        check(page.query_selector('.vg-gpscb') is not None, 'interruttore «Usa la posizione durante il viaggio»')
        gp = page.evaluate("[...document.querySelectorAll('.vg-gps')].map(x=>x.innerText).join(' | ')")
        check('Posizione' in gp or 'Sei a' in gp, f'stato della posizione detto chiaramente ({gp[:120]})')
        check('schermo spento' in gp, 'spiegato cosa succede con lo schermo spento o l\'app chiusa')
        # termina (due tocchi)
        page.click('.vg-end'); page.wait_for_timeout(200)
        check('di nuovo' in page.inner_text('.vg-end'), 'primo tocco su «Termina viaggio» chiede conferma')
        page.click('.vg-end'); page.wait_for_timeout(800)
        check(not page.evaluate("localStorage.getItem('tpl.viaggio')"), 'viaggio terminato')
        check(page.evaluate("JSON.parse(localStorage.getItem('tpl.watches')||'[]').filter(w=>w.viaggio).length") == 0, 'avvisi del viaggio annullati')
        check(page.query_selector('.vg-now') is None, 'si torna al pianificatore')
        # viaggio futuro (domani alle 8:20): salva, poi «I miei viaggi»
        page.goto(BASE + f'/?da=f:nav:5031&a=f:aut:6073&quando=partenza&ora=0820&data={tomorrow}'); page.wait_for_selector('.pp-opt', timeout=90000); page.wait_for_timeout(500)
        page.click('.pp-top .pp-opt'); page.wait_for_selector('.pp-acts', timeout=8000)
        check(page.query_selector('.pp-go') is None, 'viaggio di domani: niente «Inizia» (compare 2 ore prima)')
        page.click('.pp-svtrip'); page.wait_for_timeout(300)
        check(page.get_attribute('.pp-svtrip', 'aria-pressed') == 'true', 'salvato in «I miei viaggi»')
        page.screenshot(path=str(OUT / f'vg-{name}-5-future.png'))
        # link della proposta: si riapre il suo dettaglio (non l'elenco)
        page.evaluate("navigator.share=undefined"); page.click('.pp-txt'); page.wait_for_timeout(500)
        link = [l for l in page.evaluate("navigator.clipboard.readText()").split() if l.startswith('http')][0]
        dep = page.inner_text('.pp-dsum .pp-times').split()[0]
        page.goto(link); page.wait_for_selector('.pp-acts', timeout=90000); page.wait_for_timeout(300)
        check(page.inner_text('.pp-dsum .pp-times').split()[0] == dep, f'il link apre il dettaglio della stessa proposta ({dep})')
        # proposta scaduta (ieri): messaggio chiaro e soluzioni di adesso, nessuna schermata vuota
        yday = (datetime.date.today() - datetime.timedelta(days=1)).strftime('%Y%m%d')
        old = re.sub(r'data=\d{8}', 'data=' + yday, link)
        page.goto(old); page.wait_for_selector('.pp-notice', timeout=90000); page.wait_for_selector('.pp-opt', timeout=90000)
        check('già partita' in page.inner_text('.pp-notice'), 'proposta scaduta: «già partita» e alternative di adesso')
        page.goto(BASE + f'/?da=f:nav:5031&a=f:aut:6073&quando=partenza&ora=0820&data={tomorrow}'); page.wait_for_selector('.pp-opt', timeout=90000)
        page.click('#pclose'); page.wait_for_timeout(300)
        page.evaluate("localStorage.removeItem('tpl.percorso')")
        page.goto(BASE); page.wait_for_timeout(1500); page.click('#plan-btn'); page.wait_for_timeout(800)
        if not page.query_selector('.vg-open'):
            if page.query_selector('[data-expand]'): page.click('[data-expand]'); page.wait_for_timeout(300)
            page.click('.pp-f'); page.wait_for_timeout(300)
        check(page.query_selector('.vg-open') is not None, '«I miei viaggi» nella schermata iniziale del pianificatore')
        page.screenshot(path=str(OUT / f'vg-{name}-6-saved.png'))
        page.click('.vg-open'); page.wait_for_selector('.pp-acts', timeout=90000)
        check(page.get_attribute('.pp-svtrip', 'aria-pressed') == 'true', 'il viaggio salvato si riapre sulla stessa soluzione')
        check(not errs, 'nessun errore in console/pagina ' + (str(errs[:3]) if errs else ''))
        ctx.close()
    br.close()
print('\nFALLITI:' if fails else '\nTutto ok', *fails, sep='\n  ')
sys.exit(1 if fails else 0)
