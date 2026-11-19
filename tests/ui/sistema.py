# PROVE DELLE PROTEZIONI DELL'APP (v31) con il server di prova già avviato:
#   AVVISI_ARCHIVIO=0 DATI_CDN=0 MAREA_ARCHIVIO=0 TRUST_PROXY=1 PORT=3111 node -r ./tests/fakefeed.js server.js      poi:   python3 tests/ui/sistema.py http://localhost:3111 /tmp/ui
#  · «indietro» nell'app installata (simulata): primo «indietro» con niente aperto = avviso, secondo = esce; nel browser normale esce subito;
#  · dimensione del testo (Informazioni): tutta l'interfaccia più grande, ricordata, nessuno scorrimento orizzontale;
#  · notifiche perse (permesso concesso ma iscrizione sparita): barra «Riattiva»;
#  · errori imprevisti: dopo 3 in un minuto, barra «Ricarica»; al server solo la segnalazione tecnica.
import sys, json, pathlib, time
from playwright.sync_api import sync_playwright
BASE = sys.argv[1] if len(sys.argv) > 1 else 'http://localhost:3111'
OUT = pathlib.Path(sys.argv[2] if len(sys.argv) > 2 else '/tmp/ui'); OUT.mkdir(parents=True, exist_ok=True)
STUB = (pathlib.Path(__file__).parent / 'leaflet-stub.js').read_text()
GUIDE_OFF = "try{localStorage.setItem('tpl.guida', JSON.stringify({v:'v31', mappa:true, pannello:true}))}catch(e){}"
STANDALONE = "(()=>{const mm=window.matchMedia.bind(window);window.matchMedia=q=>/display-mode:\\s*standalone/.test(q)?{matches:true,media:q,addEventListener(){},removeEventListener(){},addListener(){},removeListener(){}}:mm(q)})()"
fails = []
def check(ok, msg):
    print(('  ok   ' if ok else '  FAIL ') + msg)
    if not ok: fails.append(msg)
def setup(ctx):
    ctx.add_init_script(GUIDE_OFF)
    ctx.route('**/vendor/leaflet/leaflet.js', lambda r: r.fulfill(body=STUB, content_type='application/javascript'))
    ctx.route('**/vendor/leaflet/leaflet.css', lambda r: r.fulfill(body='', content_type='text/css'))
    ctx.route('https://tile.openstreetmap.org/**', lambda r: r.abort())
def tap_marker(page):   # tocco vero (con attivazione dell'utente), non un clic da script: il browser tratta la cronologia in modo diverso
    b = page.evaluate("(()=>{const m=[...document.querySelectorAll('.leaflet-marker-icon.bus-marker')].find(m=>{const r=m.getBoundingClientRect();return r.top>120&&r.bottom<innerHeight-160&&r.left>20&&r.right<innerWidth-80});if(!m)return null;const r=m.getBoundingClientRect();return [r.left+r.width/2,r.top+r.height/2]})()")
    if b: page.mouse.click(b[0], b[1])
    return b
def wait_js(page, expr, ms=10000):
    t0 = time.time()
    while time.time() - t0 < ms / 1000:
        if page.evaluate(expr): return True
        page.wait_for_timeout(200)
    return False

with sync_playwright() as p:
    br = p.chromium.launch()
    # --- 1) «indietro» nell'app installata
    print('== indietro, app installata (Android)')
    ctx = br.new_context(viewport={'width': 390, 'height': 844}, has_touch=True, is_mobile=True,
                         user_agent='Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Mobile Safari/537.36')
    setup(ctx); ctx.add_init_script(STANDALONE)
    page = ctx.new_page(); errs = []; page.on('pageerror', lambda e: errs.append(str(e)))
    page.goto(BASE + '/'); page.wait_for_selector('.bus-marker', timeout=30000); page.wait_for_timeout(1500)
    h0 = page.evaluate('history.length')
    page.mouse.click(200, 300); page.wait_for_timeout(400)                       # primo tocco: la protezione si aggiunge
    check(page.evaluate('history.length') == h0 + 1 and page.evaluate('history.state.tpl') == 0, 'protezione aggiunta al primo tocco')
    tap_marker(page); page.wait_for_selector('#panel:not([hidden])', timeout=8000); page.wait_for_timeout(500)
    page.go_back(); page.wait_for_timeout(600)
    check(page.evaluate("document.getElementById('panel').hidden") and BASE in page.url, '«indietro» con un pannello aperto: chiude il pannello')
    page.go_back(); page.wait_for_timeout(600)
    toast = page.evaluate("(()=>{const t=document.getElementById('toast');return t&&!t.hidden?t.innerText:''})()")
    check(BASE in page.url and 'Premi di nuovo' in toast, f'primo «indietro» con niente aperto: resta nell\'app e avvisa ({toast[:60]})')
    page.screenshot(path=str(OUT / 'sys-indietro-avviso.png'))
    page.go_back(); page.wait_for_timeout(800)
    check(BASE not in page.url, f'secondo «indietro»: esce dall\'app ({page.url})')
    check(not errs, 'nessun errore ' + (str(errs[:2]) if errs else ''))
    ctx.close()

    print('== indietro, browser normale')
    ctx = br.new_context(viewport={'width': 390, 'height': 844}, has_touch=True); setup(ctx)
    page = ctx.new_page(); page.goto(BASE + '/'); page.wait_for_selector('.bus-marker', timeout=30000); page.wait_for_timeout(800)
    page.mouse.click(200, 300); page.wait_for_timeout(300); page.go_back(); page.wait_for_timeout(800)
    check(BASE not in page.url, 'nel browser normale «indietro» lascia il sito come sempre (nessuna protezione)')
    ctx.close()

    # --- 2) dimensione del testo
    for name, w, h in [('phone', 390, 844), ('small', 360, 640), ('desktop', 1280, 800)]:
        print(f'== dimensione del testo {name}')
        ctx = br.new_context(viewport={'width': w, 'height': h}, has_touch=w < 500); setup(ctx)
        page = ctx.new_page(); page.goto(BASE + '/'); page.wait_for_selector('.bus-marker', timeout=30000); page.wait_for_timeout(800)
        f0 = page.evaluate("parseFloat(getComputedStyle(document.documentElement).fontSize)")
        page.click('#info-btn'); page.wait_for_selector('.ip-ts', timeout=5000)
        page.click('.ip-ts [data-ts="1.3"]'); page.wait_for_timeout(300)
        f1 = page.evaluate("parseFloat(getComputedStyle(document.documentElement).fontSize)")
        check(abs(f1 / f0 - 1.3) < 0.02, f'«Molto grande»: testo ×1,3 ({f0:.1f} → {f1:.1f} px)')
        check(page.get_attribute('.ip-ts [data-ts="1.3"]', 'aria-checked') == 'true', 'scelta segnata')
        page.keyboard.press('Escape'); page.wait_for_timeout(300)
        page.reload(); page.wait_for_selector('.bus-marker', timeout=30000); page.wait_for_timeout(800)
        f2 = page.evaluate("parseFloat(getComputedStyle(document.documentElement).fontSize)")
        check(abs(f2 - f1) < 0.5, 'ricordata dopo la riapertura')
        tap_marker(page); page.wait_for_selector('#panel:not([hidden])', timeout=8000); page.wait_for_timeout(800)
        ov = page.evaluate("document.documentElement.scrollWidth - innerWidth")
        check(ov <= 1, f'nessuno scorrimento orizzontale con il testo grande ({ov})')
        dock = page.evaluate("(()=>{const a=document.querySelector('#bottom-bar .seg').getBoundingClientRect(),b=document.getElementById('clock-time').getBoundingClientRect();return Math.abs((a.top+a.bottom)/2-(b.top+b.bottom)/2)})()")
        check(dock < 12, f'barra in basso su una riga (modalità e orologio allineati, scarto {dock:.0f} px)')
        page.screenshot(path=str(OUT / f'sys-testo-{name}.png'))
        ctx.close()

    # --- 2b) testi che non entrano: scorrono ovunque, anche dopo aver cambiato la dimensione del testo (senza ricaricare)
    print('== testi che scorrono')
    ctx = br.new_context(viewport={'width': 360, 'height': 640}, has_touch=True); setup(ctx)
    page = ctx.new_page(); page.goto(BASE + '/'); page.wait_for_selector('.bus-marker', timeout=30000); page.wait_for_timeout(800)
    tap_marker(page); page.wait_for_selector('#plist .st', timeout=8000); page.wait_for_timeout(800)
    stato = "(sel)=>{const out={over:0,run:0};for(const h of document.querySelectorAll(sel)){const box=h.querySelector(':scope > .mq')?h:h; const m=h.querySelector('.mq'); const o=(m&&m.classList.contains('run'))||h.scrollWidth-h.clientWidth>2; if(o){out.over++; if(m&&m.classList.contains('run'))out.run++;}}return out}"
    page.evaluate("document.querySelector('.ip-ts [data-ts=\"1.3\"]').click()"); page.wait_for_timeout(1200)   # (pulsanti delle Informazioni, con il pannello aperto)
    r = page.evaluate(stato, '#plist .nm')
    check(r['over'] > 0 and r['run'] == r['over'], f'corsa, testo «Molto grande» scelto ora: ogni fermata che non entra scorre ({r})')
    t = page.evaluate(stato, '#pname .ph-tx')
    check(t['run'] == t['over'], f'titolo del pannello ({t})')
    b = page.evaluate("[...document.querySelectorAll('#plist .st')].findIndex(e=>e.querySelector('.nm'))")
    page.evaluate("document.querySelectorAll('#plist .st')[2].click()"); page.wait_for_selector('#plist .dep', timeout=8000); page.wait_for_timeout(1500)
    d = page.evaluate(stato, '#plist .dh, #plist .dn>span:last-child')
    check(d['run'] == d['over'], f'passaggi della fermata: destinazioni e righe che non entrano scorrono ({d})')
    page.screenshot(path=str(OUT / 'sys-scorrono.png'))
    page.evaluate("document.querySelector('.ip-ts [data-ts=\"1.3\"]').click()"); page.wait_for_timeout(300)
    page.goto(BASE + '/?da=f:nav:5031&a=f:aut:6073'); page.wait_for_selector('.pp-opt', timeout=30000); page.wait_for_timeout(1500)
    if page.query_selector('.pp-sum'): page.click('.pp-sum'); page.wait_for_selector('.pp-f', timeout=3000); page.wait_for_timeout(800)
    f = page.evaluate(stato, '.pp-v>span, .pp-sum-p>span')
    check(f['run'] == f['over'], f'pianificatore: nomi di partenza e arrivo che non entrano scorrono ({f})')
    page.screenshot(path=str(OUT / 'sys-scorrono-percorso.png'))
    page.evaluate("document.querySelector('.ip-ts [data-ts=\"1\"]').click()"); page.wait_for_timeout(1200)
    d2 = page.evaluate(stato, '#plist .dh, #plist .dn>span:last-child')
    check(d2['run'] == d2['over'] and d2['over'] <= d['over'], f'tornati al testo normale: scorrono solo quelli che ancora non entrano ({d2})')
    ctx.close()

    # --- 2c) donazione volontaria: sezione nelle Informazioni, link sicuro a PayPal; cuore accanto alla «i» solo dal 3° giorno d'uso, nascondibile
    print('== donazione')
    for giorni, visto in [(1, False), (3, True)]:
        ctx = br.new_context(viewport={'width': 390, 'height': 844}, has_touch=True); setup(ctx)
        ctx.add_init_script("localStorage.setItem('tpl.giorni', JSON.stringify({d:'2000-01-01', n:%d}))" % (giorni - 1))
        page = ctx.new_page(); page.goto(BASE + '/'); page.wait_for_selector('.bus-marker', timeout=30000); page.wait_for_timeout(600)
        check(page.is_visible('#dona-btn') == visto, f'{giorni}° giorno d\'uso: cuore accanto alla «i» {"visibile" if visto else "nascosto"}')
        if visto:
            page.click('#dona-btn'); page.wait_for_timeout(500)
            a = page.evaluate("(()=>{const a=document.getElementById('dona-go');const r=document.getElementById('ip-dona').getBoundingClientRect();return {href:a.href,t:a.target,rel:a.rel,top:r.top,vis:r.top<innerHeight}})()")
            check(a['href'] == 'https://paypal.me/olocing' and a['t'] == '_blank' and 'noopener' in a['rel'], f'link PayPal corretto e sicuro ({a["href"]})')
            check(a['vis'], 'il cuore apre le Informazioni sulla sezione della donazione (non PayPal direttamente)')
            page.screenshot(path=str(OUT / 'sys-dona.png'))
            page.click('#dona-hide'); page.wait_for_timeout(200); page.keyboard.press('Escape'); page.wait_for_timeout(300)
            check(not page.is_visible('#dona-btn'), '«Non mostrare il cuore»: sparisce')
            page.reload(); page.wait_for_selector('.bus-marker', timeout=30000); page.wait_for_timeout(500)
            check(not page.is_visible('#dona-btn'), '… e resta nascosto dopo la riapertura')
            check(page.evaluate("!!document.getElementById('ip-dona')"), 'la sezione resta nelle Informazioni')
        ctx.close()

    # --- 3) notifiche perse
    print('== notifiche perse')
    ctx = br.new_context(viewport={'width': 390, 'height': 844}); setup(ctx)
    watch = json.dumps([{'id': 'abcdefgh12', 'token': 'tokentokentoken12', 'mode': 'push', 'trip': 'aut:X', 'stop': 'aut:1', 'stopName': 'Prova', 'lead': 5, 'line': '2', 'headsign': 'Mestre', 'until': int(time.time() * 1000) + 3600e3}])
    ctx.add_init_script("try{Object.defineProperty(Notification,'permission',{get:()=>'granted'})}catch(e){}; localStorage.setItem('tpl.watches', %s)" % json.dumps(watch))
    page = ctx.new_page(); page.goto(BASE + '/'); page.wait_for_selector('.bus-marker', timeout=30000)
    check(wait_js(page, "!document.getElementById('sysbar').hidden && /non sono più attive/.test(document.getElementById('sysbar').innerText)", 9000), 'barra «Le notifiche non sono più attive» con avvisi attivi e iscrizione sparita')
    check(page.is_visible('#sysbar-act') and page.inner_text('#sysbar-act') == 'Riattiva', 'pulsante «Riattiva»')
    page.screenshot(path=str(OUT / 'sys-notifiche.png'))
    page.click('#sysbar-close'); page.wait_for_timeout(300)
    check(page.evaluate("document.getElementById('sysbar').hidden"), 'la X chiude la barra')
    ctx.close()

    # --- 4) errori imprevisti
    print('== errori imprevisti')
    ctx = br.new_context(viewport={'width': 390, 'height': 844}); setup(ctx)
    page = ctx.new_page(); sent = []
    page.on('request', lambda r: sent.append(r.post_data or '') if '/api/errore' in r.url else None)
    page.goto(BASE + '/'); page.wait_for_selector('.bus-marker', timeout=30000); page.wait_for_timeout(800)
    page.evaluate("for (let i=0;i<3;i++) setTimeout(()=>{ throw new Error('prova di errore '+i) }, 10*i)"); page.wait_for_timeout(1200)
    check(page.evaluate("!document.getElementById('sysbar').hidden && /Ricarica/.test(document.getElementById('sysbar').innerText)"), 'dopo 3 errori: barra con «Ricarica»')
    check(len(sent) >= 1 and 'prova di errore' in sent[0] and 'http' not in sent[0], f'al server solo la segnalazione tecnica ({sent[0][:90] if sent else "nessuna"})')
    ctx.close()

    print('== sciopero: quando la scheda si ripropone')
    NOW0 = int(time.time() * 1000); sc_id = ['sc-a']
    def strike_route(route):
        resp = route.fetch(); d = resp.json(); now = NOW0
        d['items'].insert(0, {'id': sc_id[0], 'source': 'actv', 'title': 'Sciopero generale nazionale 24h', 'text': 'Prova', 'url': 'https://actv.avmspa.it/it/content/sciopero-prova',
            'published': now - 864e5, 'from': now + 3600e3, 'to': now + 25 * 3600e3, 'open': False, 'dated': True, 'lines': [], 'stops': [], 'stopNames': [], 'effect': 'strike', 'effectLabel': 'Sciopero',
            'severity': 'warning', 'state': 'upcoming', 'sciopero': {'inizio': now + 3600e3, 'fine': now + 25 * 3600e3, 'da': now - 7 * 3600e3, 'fino': now + 30 * 3600e3, 'fasce': [], 'link': [{'url': 'https://actv.avmspa.it/it/content/sciopero-prova', 'label': 'Comunicato ACTV'}]}})
        route.fulfill(response=resp, json=d)
    ctx = br.new_context(viewport={'width': 390, 'height': 844}); setup(ctx)
    page = ctx.new_page(); page.route('**/api/avvisi', strike_route)
    page.goto(BASE + '/'); page.wait_for_selector('#sciopero:not([hidden])', timeout=30000)
    check('inizia' in page.inner_text('#sciopero') or 'domani' in page.inner_text('#sciopero-title').lower() or 'Sciopero' in page.inner_text('#sciopero-title'), 'sciopero in arrivo (8 ore prima): scheda all\'accesso')
    page.click('#sciopero-close'); page.wait_for_timeout(300)
    page.reload(); page.wait_for_selector('#sciopero-btn:not([hidden])', timeout=30000); page.wait_for_timeout(1500)
    check(page.evaluate("document.getElementById('sciopero').hidden"), 'chiusa con la X: non si ripropone alla riapertura')
    page.evaluate("const s=JSON.parse(localStorage.getItem('tpl.sciopero'));s.at-=7*3600e3;localStorage.setItem('tpl.sciopero',JSON.stringify(s))")
    page.reload(); page.wait_for_selector('#sciopero:not([hidden])', timeout=30000); check(True, 'dopo 6 ore si ripropone')
    page.click('#sciopero-ok'); page.wait_for_timeout(200); sc_id[0] = 'sc-b'
    page.reload(); page.wait_for_selector('#sciopero:not([hidden])', timeout=30000); check(True, 'comunicato nuovo: si ripropone subito')
    page.click('#sciopero-ok'); ctx.close()
    br.close()
print('\nFALLITI:' if fails else '\nTutto ok', *fails, sep='\n  ')
sys.exit(1 if fails else 0)
