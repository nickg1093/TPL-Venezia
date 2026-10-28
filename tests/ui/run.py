# PROVE DELL'INTERFACCIA (Playwright + Chromium). Richiede il server già avviato con il feed simulato:
#   NODE_PATH=<shim> PORT=3111 node -r ./tests/fakefeed.js server.js      poi:   python3 tests/ui/run.py http://localhost:3111 <cartella-screenshot>
#   (avviare il server con TRUST_PROXY=1)
# Leaflet è sostituito da tests/ui/leaflet-stub.js (solo per le prove). Esce con codice 1 se un controllo fallisce.
import sys, json, pathlib
from playwright.sync_api import sync_playwright
BASE = sys.argv[1] if len(sys.argv) > 1 else 'http://localhost:3111'
OUT = pathlib.Path(sys.argv[2] if len(sys.argv) > 2 else '/tmp/ui'); OUT.mkdir(parents=True, exist_ok=True)
STUB = (pathlib.Path(__file__).parent / 'leaflet-stub.js').read_text()
SIZES = [('phone', 390, 844), ('phone-small', 360, 640), ('landscape', 844, 390), ('tablet', 768, 1024), ('desktop', 1440, 900), ('huge', 2560, 1440)]
fails = []
def check(ok, msg):
    print(('  ok   ' if ok else '  FAIL ') + msg)
    if not ok: fails.append(msg)
def rect(page, sel):
    return page.evaluate("s=>{const e=document.querySelector(s);if(!e||e.hidden||e.offsetParent===null)return null;const r=e.getBoundingClientRect();return {l:r.left,t:r.top,r:r.right,b:r.bottom,w:r.width,h:r.height}}", sel)
def overlap(a, b): return a and b and a['l'] < b['r'] and a['r'] > b['l'] and a['t'] < b['b'] and a['b'] > b['t']

with sync_playwright() as p:
    br = p.chromium.launch()
    for name, w, h in SIZES:
        print(f'== {name} {w}x{h}')
        ctx = br.new_context(viewport={'width': w, 'height': h}, has_touch=name.startswith('phone'), device_scale_factor=1, extra_http_headers={'X-Forwarded-For': f'10.9.{w % 250}.{h % 250}'})   # IP diverso per schermo: i limiti di frequenza non falsano la prova (server con TRUST_PROXY=1)
        page = ctx.new_page(); errs = []
        page.on('pageerror', lambda e: errs.append(str(e)))
        page.on('console', lambda m: errs.append(m.text) if m.type == 'error' and 'tile' not in m.text else None)
        page.route('**/vendor/leaflet/leaflet.js', lambda r: r.fulfill(body=STUB, content_type='application/javascript'))
        page.route('**/vendor/leaflet/leaflet.css', lambda r: r.fulfill(body='', content_type='text/css'))
        page.route('https://tile.openstreetmap.org/**', lambda r: r.abort())
        page.goto(BASE); page.wait_for_selector('.bus-marker', timeout=20000); page.wait_for_timeout(1500)
        check(not errs, 'nessun errore in console/pagina ' + (str(errs[:2]) if errs else ''))
        check(page.evaluate("document.querySelectorAll('script:not([src])').length") == 0, 'nessuno script in linea')
        dock = rect(page, '#bottom-bar'); check(dock['h'] <= 130, f"dock compatto in tempo reale ({dock['h']:.0f}px)")
        di = rect(page, '.dock-in'); check(di['w'] <= 761, f"dock-in largo al massimo 760 ({di['w']:.0f}px)")
        page.screenshot(path=str(OUT / f'{name}-0-home.png'))

        # --- corsa: apertura da un mezzo
        page.evaluate("document.querySelector('.bus-marker .bus').click()")
        page.evaluate("document.querySelector('.leaflet-marker-icon.bus-marker').click()")
        page.wait_for_selector('#panel:not([hidden]) .tl', timeout=8000); page.wait_for_timeout(600)
        check(rect(page, '#pfollow') is not None, 'pulsante segui visibile nel pannello della corsa')
        check(page.query_selector('#follow') is None, 'vecchia pillola «insegui» assente')
        pf, pc = rect(page, '#pfollow'), rect(page, '#pclose')
        check(pf['w'] >= 44 and pf['h'] >= 44 and pc['w'] >= 44, 'pulsanti segui/X >= 44px')
        check(abs(pf['t'] - pc['t']) < 2 and pf['r'] <= pc['l'] + 1, 'segui affiancato alla X')
        n = page.evaluate("window.__map._polys.size"); check(n > 0, f'percorso della corsa disegnato ({n} linee)')
        page.screenshot(path=str(OUT / f'{name}-1-trip.png'))

        # --- inseguimento: il mezzo deve restare nella zona libera
        page.click('#pfollow'); page.wait_for_timeout(3500)
        check(page.get_attribute('#pfollow', 'aria-pressed') == 'true', 'segui attivo (aria-pressed)')
        pos = page.evaluate("""()=>{const m=window.__map;const sel=document.querySelector('.bus.sel');if(!sel)return null;const r=sel.getBoundingClientRect();return {x:(r.left+r.right)/2,y:(r.top+r.bottom)/2}}""")
        check(pos is not None, 'mezzo selezionato presente sulla mappa')
        if pos:
            cover = [s for s in ['#panel', '#controls .group', '#tide', '#topleft', '#bottom-bar'] if any(
                overlap({'l': pos['x']-14, 'r': pos['x']+14, 't': pos['y']-14, 'b': pos['y']+14}, rect(page, s) or {'l':0,'r':0,'t':0,'b':0}) for s in [s])]
            groups = page.evaluate("[...document.querySelectorAll('#controls .group')].map(e=>{const r=e.getBoundingClientRect();return {l:r.left,t:r.top,r:r.right,b:r.bottom}})")
            cov = [s for s in ['#panel', '#tide', '#bottom-bar'] if overlap({'l': pos['x']-14, 'r': pos['x']+14, 't': pos['y']-14, 'b': pos['y']+14}, rect(page, s))]
            cov += ['controls' for g in groups if overlap({'l': pos['x']-14, 'r': pos['x']+14, 't': pos['y']-14, 'b': pos['y']+14}, g)]
            check(not cov, f'mezzo seguito non coperto da UI {cov} a ({pos["x"]:.0f},{pos["y"]:.0f})')
        page.screenshot(path=str(OUT / f'{name}-2-follow.png'))

        # --- navigazione: riga fermata -> pannello fermata con «indietro»
        page.evaluate("document.querySelector('.st:not(.first)').click()"); page.wait_for_selector('#pback:not([hidden])', timeout=5000); page.wait_for_timeout(500)
        check(rect(page, '#pfollow') is None, 'segui nascosto nel pannello fermata')
        check(page.get_attribute('#pfollow', 'aria-pressed') == 'false', 'inseguimento spento passando alla fermata')
        check(page.inner_text('#pback').strip() != '', 'link indietro con testo: ' + page.inner_text('#pback').strip()[:40])
        pb = rect(page, '#pback'); check(pb['h'] >= 40, f"link indietro con area di tocco {pb['h']:.0f}px")
        page.wait_for_selector('#plist .dep', timeout=8000)
        page.screenshot(path=str(OUT / f'{name}-3-stop.png'))
        lab = page.evaluate("""()=>{const e=document.querySelector('#plist .dep .in-min'),s=document.querySelector('#plist .dep strong');return e&&s?{l:getComputedStyle(e).color,t:getComputedStyle(s).color,cls:e.className}:null}""")
        check(lab and lab['cls'] == 'in-min', 'etichetta sotto l\'orario senza classe di stato')
        gone = page.evaluate("document.querySelectorAll('#plist .dep.gone').length"); print('  info righe partite:', gone)

        # --- riga di passaggio -> corsa, poi indietro -> fermata, poi indietro -> corsa
        page.evaluate("document.querySelector('#plist .dep.go').click()"); page.wait_for_selector('#panel .tl', timeout=8000); page.wait_for_timeout(400)
        check(rect(page, '#pfollow') is not None and rect(page, '#pback') is not None, 'corsa aperta dalla fermata con «indietro»')
        page.click('#pback'); page.wait_for_selector('#plist .dep', state='attached', timeout=8000)
        check(rect(page, '#pback') is not None, 'tornati alla fermata: c\'è ancora «indietro» (corsa precedente)')
        page.click('#pback'); page.wait_for_selector('#panel .tl', timeout=8000)
        check(rect(page, '#pback') is None, 'tornati alla corsa iniziale: «indietro» sparisce')

        # --- X: il percorso scompare
        page.click('#pclose'); page.wait_for_timeout(400)
        check(rect(page, '#panel') is None, 'pannello chiuso')
        check(page.evaluate("window.__map._polys.size") == 0, 'X: nessuna shape di percorso rimasta')
        check(page.evaluate("document.querySelectorAll('.bus.sel').length") == 0, 'X: nessun mezzo selezionato')

        # --- modalità pianificato
        page.evaluate("document.querySelector('input[name=mode][value=sched]').click()"); page.wait_for_timeout(1200)
        dock = rect(page, '#bottom-bar'); lim = 230 if w < 560 else 160; check(dock['h'] <= lim, f"dock Pianificato compatto ({dock['h']:.0f}px, limite {lim})")
        di = rect(page, '.dock-in'); check(di['w'] <= 761, f"dock-in Pianificato <= 760 ({di['w']:.0f}px)")
        tc = rect(page, '#timeline-controls'); check(tc['r'] <= w + 1 and tc['l'] >= -1, 'controlli orario entro lo schermo')
        small = page.evaluate("[...document.querySelectorAll('#bottom-bar button,#bottom-bar input,#bottom-bar select,#bottom-bar label')].map(e=>{const r=e.getBoundingClientRect();return [e.id||e.tagName,r.width,r.height]}).filter(x=>x[2]>0&&(x[2]<43.5))")
        check(not [s for s in small if s[0] not in ('INPUT',)], f'bersagli del dock >= 44px {small}')
        page.screenshot(path=str(OUT / f'{name}-4-sched.png'))
        # nessuna barra di scorrimento orizzontale
        check(page.evaluate("document.documentElement.scrollWidth <= innerWidth"), 'nessuno scorrimento orizzontale')
        ctx.close()
    br.close()
print('\nFALLITI:', len(fails)); [print(' -', f) for f in fails]
sys.exit(1 if fails else 0)
