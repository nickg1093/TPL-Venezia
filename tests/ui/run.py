# PROVE DELL'INTERFACCIA (Playwright + Chromium). Richiede il server già avviato con il feed simulato:
#   NODE_PATH=<shim> AVVISI_ARCHIVIO=0 DATI_CDN=0 MAREA_ARCHIVIO=0 TRUST_PROXY=1 PORT=3111 node -r ./tests/fakefeed.js server.js      poi:   python3 tests/ui/run.py http://localhost:3111 <cartella-screenshot>
#   (avviare il server con TRUST_PROXY=1)
# Leaflet è sostituito da tests/ui/leaflet-stub.js (solo per le prove). Esce con codice 1 se un controllo fallisce.
import sys, json, pathlib
from playwright.sync_api import sync_playwright
BASE = sys.argv[1] if len(sys.argv) > 1 else 'http://localhost:3111'
OUT = pathlib.Path(sys.argv[2] if len(sys.argv) > 2 else '/tmp/ui'); OUT.mkdir(parents=True, exist_ok=True)
STUB = (pathlib.Path(__file__).parent / 'leaflet-stub.js').read_text()
SIZES = [('phone', 390, 844), ('phone-small', 360, 640), ('landscape', 844, 390), ('tablet', 768, 1024), ('desktop', 1440, 900), ('huge', 2560, 1440)]
fails = []
ES_LOG = "try{const E=window.EventSource;if(E)window.EventSource=class extends E{constructor(u,o){super(u,o);(window.__es||(window.__es=[])).push(String(u));}}}catch(e){}"   # indirizzi dei flussi aperti (un flusso aperto non compare tra le richieste concluse)
FAV_ONE = "try{if(!localStorage.getItem('tpl.favorites'))localStorage.setItem('tpl.favorites', JSON.stringify({v:1,items:[{k:'nav:5032',name:'Fermata preferita di prova',src:'nav',at:1}]}))}catch(e){}"   # un preferito: la ricerca non deve mostrarlo
GUIDE_OFF = "try{localStorage.setItem('tpl.guida', JSON.stringify({v:'v27', mappa:true, pannello:true}))}catch(e){}"   # guida già vista: le prove non la incontrano (ha una prova sua)
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
        ctx = br.new_context(viewport={'width': w, 'height': h}, has_touch=name.startswith('phone'), device_scale_factor=1, permissions=['geolocation'], geolocation={'latitude': 45.4375, 'longitude': 12.3358}, extra_http_headers={'X-Forwarded-For': f'10.9.{w % 250}.{h % 250}'})   # IP diverso per schermo: i limiti di frequenza non falsano la prova (server con TRUST_PROXY=1)
        ctx.add_init_script(GUIDE_OFF); ctx.add_init_script(FAV_ONE); ctx.add_init_script(ES_LOG); page = ctx.new_page(); errs = []
        page.on('pageerror', lambda e: errs.append(str(e)))
        page.on('console', lambda m: errs.append(m.text) if m.type == 'error' and 'tile' not in m.text else None)
        page.route('**/vendor/leaflet/leaflet.js', lambda r: r.fulfill(body=STUB, content_type='application/javascript'))
        page.route('**/vendor/leaflet/leaflet.css', lambda r: r.fulfill(body='', content_type='text/css'))
        def tide_fake(route):
            import time
            n = int(time.time() * 1000); H = 3600000
            obs = [[n - k * 600000, round(30 + 25 * __import__('math').sin((n - k * 600000) / H / 2)) ] for k in range(36, -1, -1)]
            fc = [[n + k * 600000, round(30 + 25 * __import__('math').sin((n + k * 600000) / H / 2))] for k in range(0, 37)]
            d = {'station': 'Punta Salute Canal Grande', 'cm': obs[-1][1], 'ts': n, 'ageMin': 1, 'stale': False, 'category': {'key': 'normale', 'label': 'Marea normale'}, 'trend': {'dir': 'up', 'rate': 4, 'basis': 'osservato'},
                 'next': [{'type': 'max', 'cm': 58, 'ts': n + 3 * H}], 'history': obs, 'source': {'name': 'CPSM', 'license': 'CC BY', 'url': 'https://dati.venezia.it/'},
                 'chart': {'from': n - 6 * H, 'to': n + 18 * H, 'now': n, 'observed': obs, 'forecast': fc, 'extremes': [{'type': 'max', 'cm': 58, 'ts': n + 3 * H}, {'type': 'min', 'cm': -8, 'ts': n - 3 * H}]}}
            route.fulfill(body=json.dumps(d), content_type='application/json')
        page.route('**/api/tide', tide_fake)
        page.route('**/api/mose', lambda r: r.fulfill(content_type='application/json', body=json.dumps({'stato': 'sollevata', 'sem': 'rosso', 'titolo': 'MOSE attivo: barriere sollevate', 'evento': {'data': '', 'orario': ''}, 'aggiornato': int(__import__('time').time() * 1000) - 600000, 'letto': int(__import__('time').time() * 1000), 'stale': False,
            'barriere': [{'bocca': 'Bocca di Lido', 'barriera': 'Barriera di Treporti', 'stato': 'sollevata', 'sem': 'rosso', 'testo': 'Barriera sollevata'}, {'bocca': 'Bocca di Lido', 'barriera': 'Barriera di San Nicolò', 'stato': 'sollevata', 'sem': 'rosso', 'testo': 'Barriera sollevata'},
                         {'bocca': 'Bocca di Malamocco', 'barriera': 'Barriera di Malamocco', 'stato': 'sollevamento', 'sem': 'lampeggia', 'testo': 'Barriera in fase di sollevamento'}, {'bocca': 'Bocca di Chioggia', 'barriera': 'Barriera di Chioggia', 'stato': 'recesso', 'sem': 'verde', 'testo': 'Paratoie in recesso'}],
            'fonte': {'nome': 'Autorità per la Laguna di Venezia', 'url': 'https://www.autoritalaguna.it/operativita-m-o-s-e/'}})))
        page.route('https://tile.openstreetmap.org/**', lambda r: r.abort())
        page.goto(BASE); page.wait_for_selector('.bus-marker', timeout=20000); page.wait_for_timeout(1500)
        check(not errs, 'nessun errore in console/pagina ' + (str(errs[:2]) if errs else ''))
        check(page.evaluate("document.querySelectorAll('script:not([src])').length") == 0, 'nessuno script in linea')
        # --- v27: niente +/− dello zoom, preferiti e informazioni nella colonna (che scorre), niente «ora / Ns fa», schema dei controlli = tema
        check(page.query_selector('.leaflet-control-zoom') is None, 'nessun pulsante di zoom (+/−)')
        check(page.evaluate("!!document.querySelector('#controls #info-fab')"), 'preferiti e informazioni nella stessa colonna dei pulsanti')
        check(page.query_selector('#updated-ago') is None, "niente «ora / Ns fa» accanto all'orologio")
        cs = page.evaluate("[document.documentElement.dataset.theme, getComputedStyle(document.documentElement).colorScheme]")
        check(cs[0] == cs[1], f'controlli nativi (data, ora, menu) con il tema del sito: {cs}')
        vp = page.get_attribute('meta[name=viewport]', 'content'); check('user-scalable=no' in vp and 'maximum-scale=1' in vp, "interfaccia non ingrandibile (solo la mappa)")
        page.set_viewport_size({'width': w, 'height': 300}); page.wait_for_timeout(500)
        col = page.evaluate("(()=>{const c=document.getElementById('controls');const b=[...c.querySelectorAll('.ibtn')].filter(x=>x.offsetParent).map(x=>Math.round(x.getBoundingClientRect().height));c.scrollTop=9999;const last=[...c.querySelectorAll('.group')].pop().getBoundingClientRect();return [c.scrollHeight>c.clientHeight, c.classList.contains('scrolls'), Math.min(...b), Math.round(last.bottom)<=c.getBoundingClientRect().bottom+1]})()")
        check(col[0] and col[1] and col[2] >= 44 and col[3], f'schermo basso: la colonna dei pulsanti scorre, pulsanti interi e ultimo gruppo raggiungibile {col}')
        page.evaluate("document.getElementById('controls').scrollTop=0"); page.set_viewport_size({'width': w, 'height': h}); page.wait_for_timeout(500)
        dock = rect(page, '#bottom-bar'); check(dock['h'] <= 130, f"dock compatto in tempo reale ({dock['h']:.0f}px)")
        di = rect(page, '.dock-in'); check(di['w'] <= 761, f"dock-in largo al massimo 760 ({di['w']:.0f}px)")
        page.screenshot(path=str(OUT / f'{name}-0-home.png'))
        # --- v25: fermate, linee e tracciati salvati sul dispositivo (qui dal server: prova con DATI_CDN=0), seconda apertura senza riscaricarli
        nf = page.evaluate("caches.open('tpl-fissi-1').then(c=>c.keys()).then(k=>k.filter(r=>r.url.includes('/__fissi/')).length)")
        check(nf >= 4, f'dati fissi salvati sul dispositivo ({nf} file)')

        # --- corsa: apertura da un mezzo
        # un mezzo associato a una corsa (non grigio «idle» né «?»): quelli staccati non hanno la linea del tempo
        page.evaluate("[...document.querySelectorAll('.leaflet-marker-icon.bus-marker')].find(m => !m.querySelector('.bus.idle, .bus.unk'))?.click()")
        page.wait_for_selector('#panel:not([hidden]) .tl', timeout=8000); page.wait_for_timeout(600)
        check(rect(page, '#pfollow') is not None, 'pulsante segui visibile nel pannello della corsa')
        check(page.query_selector('#follow') is None, 'vecchia pillola «insegui» assente')
        pf, pc = rect(page, '#pfollow'), rect(page, '#pclose')
        check(pf['w'] >= 44 and pf['h'] >= 44 and pc['w'] >= 44, 'pulsanti segui/X >= 44px')
        # --- v26: pannello e linguetta come un pezzo solo: bordo superiore (largo) o destro (telefono) allineato, angolo del pannello squadrato
        tb, pn = rect(page, '#ptab'), rect(page, '#panel')
        narrow = w <= 640
        al = abs(tb['r'] - pn['r']) <= 1.5 and pn['t'] - 1 <= tb['b'] <= pn['t'] + 3 if narrow else abs(tb['t'] - pn['t']) <= 1.5 and tb['l'] <= pn['r'] + 1.5
        check(al, f"linguetta a filo del pannello ({'destra' if narrow else 'in alto'}): linguetta {tb} pannello {pn}")
        rr = page.evaluate("getComputedStyle(document.getElementById('panel')).borderTopRightRadius")
        check(rr in ('0px', '0'), f'angolo del pannello verso la linguetta squadrato ({rr})')
        cp = page.evaluate("getComputedStyle(document.getElementById('ptab')).clipPath"); check(cp.startswith('inset'), "ombra della linguetta solo verso la mappa (clip-path)")
        cv = page.evaluate("getComputedStyle(document.getElementById('ptab'),'::after').backgroundImage"); check('radial-gradient' in cv, 'curva concava tra linguetta e pannello')
        check((abs(pf['t'] - pc['t']) < 2 and pf['r'] <= pc['l'] + 1) or (abs(pf['l'] - pc['l']) < 2 and pf['b'] <= pc['t'] + 1), 'segui accanto alla X (stessa linguetta)')
        tab, pn = rect(page, '#ptab'), rect(page, '#panel')
        check(tab and pn and (tab['l'] >= pn['r'] - 4 or tab['b'] <= pn['t'] + 4), 'linguetta dei comandi fuori dal pannello')
        nm = page.evaluate("(()=>{const e=document.getElementById('pname');return e.scrollHeight<=e.clientHeight+2 && getComputedStyle(e).whiteSpace==='nowrap'})()")
        check(nm, 'titolo del pannello su una riga')
        check(page.evaluate("[...window.__map._polys].filter(p => p.isPolygon).length") == 2 and page.evaluate("!!window.__map._maxB && window.__map._minZ >= 8"), 'area servita: contorno, oscuramento e limiti della mappa')
        n = page.evaluate("[...window.__map._polys].filter(p => !p.isPolygon).length"); check(n > 0, f'percorso della corsa disegnato ({n} linee)')
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
        if page.query_selector('#plist .pastsw'):   # «Partiti da poco»: chiusa all'inizio, si apre e si chiude con la freccia
            n0 = page.evaluate("document.querySelectorAll('#plist .dep.d1').length")
            check(n0 == 0 and page.get_attribute('#plist .pastsw', 'aria-expanded') == 'false', 'partiti da poco: chiusa all\'inizio')
            page.click('#plist .pastsw'); page.wait_for_selector('#plist #pastlist .dep.d1', timeout=3000)
            n1 = page.evaluate("document.querySelectorAll('#plist .dep.d1').length"); print('  info partiti da poco:', n1)
            check(page.get_attribute('#plist .pastsw', 'aria-expanded') == 'true' and str(n1) in page.inner_text('#plist .pastsw .gchev b'), 'partiti da poco: aperta, numero giusto')
            pb = rect(page, '#plist .pastsw'); check(pb and pb['h'] >= 44, 'titolo «Partiti da poco» >= 44px')
            page.click('#plist .pastsw'); page.wait_for_timeout(200); check(page.query_selector('#plist .dep.d1') is None, 'partiti da poco: richiusa')
        else: print('  info partiti da poco: nessuna')
        # --- v23: tre righe per passaggio, orario cambiato con il programmato SOPRA, vista per linea con gruppi apribili
        page.wait_for_selector('#plist .dep.d3', timeout=8000)
        three = page.evaluate("(()=>{const r=document.querySelector('#plist .dep.d3');return !!(r&&r.querySelector('.dh')&&r.querySelector('.d-l2')&&r.querySelector('.d-l3'))})()")
        check(three, 'riga del passaggio su tre righe (destinazione, fermate successive, stato)')
        above = page.evaluate("(()=>{const c=document.querySelector('#plist .dt3 .sched-crossed:not(.sp)');if(!c)return null;const s=c.parentElement.querySelector('strong');return c.getBoundingClientRect().bottom<=s.getBoundingClientRect().top+2})()")
        check(above is not False, 'orario programmato barrato sopra quello previsto' + (' (nessun ritardo in elenco)' if above is None else ''))
        check(page.evaluate("document.documentElement.scrollWidth <= innerWidth"), 'pannello fermata: nessuno scorrimento orizzontale')
        page.click('#plist [data-view=linea]'); page.wait_for_selector('#plist .grp', timeout=3000)
        ng = page.evaluate("document.querySelectorAll('#plist .grp').length"); check(ng >= 1, f'vista per linea: {ng} gruppi')
        page.click('#plist .grp'); page.wait_for_selector('#plist .gl .d3s', timeout=3000)
        check(page.get_attribute('#plist .grp.open', 'aria-expanded') == 'true', 'gruppo aperto: tutti i suoi passaggi')
        page.click('#plist .grp.open'); page.wait_for_timeout(200); check(page.query_selector('#plist .gl') is None, 'secondo tocco: gruppo chiuso')
        gb = rect(page, '#plist .grp .gchev'); check(gb and gb['w'] >= 44 and gb['h'] >= 44, 'freccia del gruppo >= 44px')
        page.click('#plist [data-view=orario]'); page.wait_for_selector('#plist .dep.d3.go', timeout=3000)
        check(rect(page, '#pshare') is not None, 'pulsante Condividi nel pannello fermata')

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
        check(page.evaluate("[...window.__map._polys].filter(p => !p.isPolygon).length") == 0, 'X: nessuna shape di percorso rimasta')
        check(page.evaluate("document.querySelectorAll('.bus.sel').length") == 0, 'X: nessun mezzo selezionato')

        # --- pianifica percorso: pulsante, scelta dei punti, soluzioni, dettaglio, corsa e ritorno
        pb = rect(page, '#plan-btn'); check(pb and pb['h'] >= 44 and pb['l'] >= 0 and pb['b'] <= h, 'pulsante Percorso visibile, >= 44px')
        check(not any(overlap(pb, rect(page, s)) for s in ['#bottom-bar', '#controls .group', '#tide']), 'pulsante Percorso non copre altri controlli')
        page.click('#plan-btn'); page.wait_for_selector('.pp-q', timeout=5000)
        page.fill('.pp-q', 'Murano Faro'); page.wait_for_timeout(300); page.click('.pp-sug[data-s=zone], .pp-sug[data-s=stop]')
        page.wait_for_selector('.pp-q', timeout=5000); page.fill('.pp-q', 'San Zaccaria'); page.wait_for_timeout(300)
        page.click('.pp-sug[data-s=zone], .pp-sug[data-s=stop]')
        page.wait_for_selector('.pp-opt', timeout=15000); page.wait_for_timeout(400)
        n = page.evaluate("document.querySelectorAll('.pp-opt').length"); check(1 <= n <= 4, f'soluzioni trovate ({n})')
        # partenza e arrivo scelti: il modulo si riduce a una riga di riepilogo; il percorso intero sta nella parte libera della mappa
        check(page.is_visible('.pp-mini .pp-sum') and not page.query_selector('.pp-f'), 'modulo ridotto a riepilogo dopo partenza e arrivo')
        check('plv-list' in page.get_attribute('#panel', 'class'), 'pannello a livello lista')
        if w <= 640: ph = rect(page, '#panel')['h']; check(ph <= h * 0.62, f'lista: il pannello lascia libera la mappa ({ph:.0f}/{h}px)')
        page.click('.pp-sum'); page.wait_for_selector('.pp-f', timeout=3000); check(page.is_visible('.pp-collapse'), '«Modifica» riapre il modulo, con «Riduci»')
        page.click('.pp-collapse'); page.wait_for_selector('.pp-mini', timeout=3000); check(not page.query_selector('.pp-f'), '«Riduci» richiude il modulo')
        page.click('.pp-sum'); page.wait_for_selector('.pp-f', timeout=3000)
        # percorso preferito: stella nell'intestazione, poi nei suggerimenti del pianificatore; si toglie con un altro tocco
        check(page.is_visible('#pfav'), 'stella del percorso visibile con partenza e arrivo scelti')
        page.click('#pfav'); page.wait_for_timeout(200); check(page.get_attribute('#pfav', 'aria-pressed') == 'true', 'percorso salvato nei preferiti')
        page.click('.pp-f[data-f=to]'); page.wait_for_selector('.pp-sug[data-s=route]', timeout=3000); check(True, 'percorso salvato tra i suggerimenti')
        page.fill('.pp-q', 'abc'); page.wait_for_timeout(150); check(rect(page, '.pp-qwrap .xbtn') is not None, 'campo con testo: compare la × per cancellarlo')
        page.click('.pp-qwrap .xbtn'); page.wait_for_timeout(150); check(page.input_value('.pp-q') == '' and rect(page, '.pp-qwrap .xbtn') is None, '× cancella il testo e sparisce')
        page.click('.pp-qback'); page.click('#pfav'); page.wait_for_timeout(200); check(page.get_attribute('#pfav', 'aria-pressed') == 'false', 'percorso tolto dai preferiti')
        page.wait_for_selector('.pp-opt', timeout=15000)
        page.screenshot(path=str(OUT / f'{name}-p-soluzioni.png'))
        check(page.evaluate("document.querySelectorAll('.pp-fw [data-clr]').length") == 2, 'pianificatore: × per togliere partenza e arrivo')
        # opzioni: pagina a spunta, salvate; «Mostra le soluzioni» rifà la ricerca; Ripristina torna ai valori normali
        page.click('.pp-opzbtn'); page.wait_for_selector('.pp-opz', timeout=3000)
        check(page.evaluate("document.querySelectorAll('.pp-opz .pp-og').length") >= 5 and page.evaluate("document.querySelectorAll('.pp-opz [data-o=pref]').length") == 3 and not page.query_selector('.pp-opz [data-o=cambi]'), 'opzioni: mezzi, preferenza (Migliore, Meno cambi, Meno a piedi), a piedi, passo, margine')
        small = page.evaluate("Math.min(...[...document.querySelectorAll('.pp-opz button.chip')].map(b=>b.getBoundingClientRect().height))")
        check(small >= 40, f'scelte delle opzioni alte almeno 40px ({small:.0f})')
        page.click('[data-o=passo][data-v=veloce]'); page.click('.pp-ook'); page.wait_for_selector('.pp-opt, .pp-walkonly', timeout=15000)
        check('1' in page.inner_text('.pp-opzbtn'), 'pulsante Opzioni con il numero di opzioni attive')
        page.click('.pp-opzbtn'); page.wait_for_selector('.pp-opz'); page.click('.pp-oreset'); page.click('.pp-ook'); page.wait_for_selector('.pp-opt', timeout=15000)
        page.click('.pp-opt'); page.wait_for_selector('.pp-steps', timeout=5000)
        page.wait_for_selector('.pp-alts .pp-ah', timeout=15000); [page.wait_for_timeout(250) for _ in range(60) if page.evaluate("document.querySelector('.pp-alts').textContent.includes('Cerco')")]   # attesa senza eval (la CSP della pagina lo vieta)
        check(page.evaluate("!!document.querySelector('.pp-alts .pp-tchip.on, .pp-alts .pp-opt, .pp-alts p')"), 'dettaglio: alternative (altri orari / simili / altre linee)')
        check(page.evaluate("[...window.__map._polys].filter(p => !p.isPolygon).length") > 0, 'tratte del percorso disegnate')
        check('plv-det' in page.get_attribute('#panel', 'class') and not page.query_selector('.pp-f'), 'dettaglio: pannello ridotto al minimo')
        if w <= 640:
            h0 = rect(page, '#panel')['h']; check(h0 <= h * 0.5, f'dettaglio: foglio basso, mappa libera sopra ({h0:.0f}/{h}px)'); page.click('.pp-tall'); page.wait_for_timeout(400); h1 = rect(page, '#panel')['h']
            check(h1 > h0, f'dettaglio: il foglio si alza ({h0:.0f} → {h1:.0f})'); page.click('.pp-tall'); page.wait_for_timeout(400)
        pr = rect(page, '#panel'); check(pr['r'] <= w + 1 and pr['b'] <= h + 1, 'pannello percorso entro lo schermo')
        nf = page.evaluate("parseInt(document.querySelector('.pp-mid').textContent)")
        page.click('.pp-ride'); page.wait_for_selector('#panel .tl', timeout=10000); page.wait_for_timeout(300)
        vis = page.evaluate("document.querySelectorAll('#panel .tl .st:not(.out)').length")
        check(vis == nf + 1, f'corsa dal percorso: solo il tratto ({vis} fermate visibili, attese {nf + 1})')
        check(page.evaluate("!!document.querySelector('#panel .tl .st:not(.out).seg-on.first') && !!document.querySelector('#panel .tl .st.seg-off.last')"), 'tratto: «sali» in cima, «scendi» in fondo')
        page.click('.seg-toggle'); page.wait_for_timeout(200)
        check(page.evaluate("document.querySelectorAll('#panel .tl .st.out').length") == 0, '«Tutta la corsa» mostra tutte le fermate')
        page.click('.seg-toggle'); page.wait_for_timeout(200)
        page.click('#pback'); page.wait_for_selector('.pp-steps', timeout=5000); check(True, 'corsa aperta dal percorso, «indietro» torna al dettaglio')
        check(page.evaluate("document.documentElement.scrollWidth <= innerWidth"), 'percorso: nessuno scorrimento orizzontale')
        # arrivo entro le: soluzioni che arrivano entro l'orario scelto
        page.click('.pp-back'); page.wait_for_selector('.pp-mini', timeout=3000); check('plv-list' in page.get_attribute('#panel', 'class'), '«Tutte le soluzioni» torna alla lista')
        page.click('.pp-sum'); page.wait_for_selector('.pp-when', timeout=3000)
        page.click('.pp-when [data-w=by]'); page.wait_for_selector('.pp-time', timeout=3000)
        page.fill('.pp-time', '23:30'); page.dispatch_event('.pp-time', 'change'); page.wait_for_timeout(300)
        page.wait_for_selector('.pp-opt, #plist .pp-note, #plist p.muted', timeout=15000); page.wait_for_timeout(500)
        arr = page.evaluate("[...document.querySelectorAll('.pp-opt .pp-times b:last-of-type')].map(b=>b.textContent)")
        check(all(x <= '23:30' or x < '06:00' for x in arr), f'arrivo entro le 23:30: {arr}')
        wb = rect(page, '.pp-when'); check(wb and wb['r'] <= w + 1, 'scelta orario entro lo schermo')
        page.screenshot(path=str(OUT / f'{name}-p-entro.png'))
        page.click('#pclose'); page.wait_for_timeout(400)
        check(rect(page, '#panel') is None and page.evaluate("[...window.__map._polys].filter(p => !p.isPolygon).length") == 0, 'X: percorso chiuso e tolto dalla mappa')


        # --- marea: grafico a 12 ore con cursore (dati sintetici: il server di prova non ha lo storico)
        page.evaluate("document.querySelector('#search-container').classList.remove('expanded')")
        page.click('#tide-btn'); page.wait_for_selector('#tide .tide-chart', timeout=8000)
        tw = rect(page, '#tide'); check(tw['r'] <= w + 1 and tw['l'] >= -1, 'scheda marea entro lo schermo')
        check(rect(page, '#tide .tide-chart svg') is not None and rect(page, '#tide .tide-range') is None, 'grafico presente, senza il cursore sotto (si trascina sul grafico)')
        sz = page.evaluate("[...document.querySelectorAll('#tide svg text')].map(t=>parseFloat(getComputedStyle(t).fontSize)*t.ownerSVGElement.getBoundingClientRect().width/t.ownerSVGElement.viewBox.baseVal.width)")
        check(min(sz) >= 12.5, f'testo del grafico leggibile (min {min(sz):.1f}px)')
        page.focus('#tide .tide-chart svg'); page.keyboard.press('Home')
        a = page.inner_text('#tide .tide-read'); check('osservato' in a or 'nessun dato' in a, 'cursore a -6 h (tasto Inizio): ' + a.replace('\n', ' '))
        for _ in range(12): page.keyboard.press('PageUp')
        b = page.inner_text('#tide .tide-read'); check('previsto' in b, 'cursore a +6 h (Pagina su): ' + b.replace('\n', ' '))
        sb = page.query_selector('#tide .tide-chart svg').bounding_box(); page.mouse.click(sb['x'] + sb['width'] * .2, sb['y'] + sb['height'] / 2)
        c2 = page.inner_text('#tide .tide-read'); check('osservato' in c2 or 'nessun dato' in c2, 'clic sul grafico sposta il cursore: ' + c2.replace('\n', ' '))
        # --- v27: MOSE (stato simulato: due barriere sollevate, una in sollevamento, una in recesso; sollevamento programmato)
        page.wait_for_selector('#tide .mose .mose-b', state='attached', timeout=8000)
        ms = page.evaluate("[...document.querySelectorAll('#tide .mose-b ul li')].map(l=>l.dataset.sem)")
        check(ms == ['rosso', 'rosso', 'lampeggia', 'verde'], f'MOSE: un semaforo per barriera {ms}')
        check('MOSE attivo' in page.inner_text('#tide .mose-h'), 'MOSE: titolo «attivo» con barriere sollevate')
        check(page.is_visible('#tide .mose-h .sema') and not page.is_visible('#tide .mose-b'), 'MOSE: semaforo generale visibile, barriere chiuse di base')
        page.click('#tide .mose-d > summary'); page.wait_for_timeout(200)
        check(page.evaluate("document.querySelectorAll('#tide .mose-b ul li .sema').length") == 4 and page.is_visible('#tide .mose-b'), 'MOSE: «Barriere» apre i 4 semafori specifici')
        page.click('#tide .mose-d > summary'); page.wait_for_timeout(200); check(not page.is_visible('#tide .mose-b'), 'MOSE: un altro tocco li richiude')
        check('autoritalaguna.it' in (page.get_attribute('#tide .mose .tide-foot a', 'href') or ''), 'MOSE: fonte citata con collegamento')
        check(page.get_attribute('#tide-btn', 'data-mose') == 'rosso', 'MOSE attivo: segnale sul pulsante della marea')
        page.screenshot(path=str(OUT / f'{name}-5-tide.png'))
        page.click('#tide-close')

        # --- avvisi: contatore, finestra, fermata con (!) e rimando all'avviso
        page.wait_for_selector('#avvisi-count:not([hidden])', timeout=15000)
        check(page.inner_text('#avvisi-count') == '2', 'contatore avvisi in corso = 2')
        page.click('#avvisi-btn'); page.wait_for_selector('#avvisi .av', timeout=5000)
        check(page.evaluate("document.querySelectorAll('#avvisi .av').length") == 2, 'finestra: 2 avvisi')
        aw = rect(page, '#avvisi'); check(aw['r'] <= w + 1 and aw['l'] >= -1 and aw['b'] <= h + 1, 'finestra avvisi entro lo schermo')
        check(page.evaluate("[...document.querySelectorAll('#avvisi a')].every(a=>/^https:\\/\\/(actv|t)/.test(a.href) && a.rel.includes('noopener'))"), 'link degli avvisi sicuri')
        page.screenshot(path=str(OUT / f'{name}-6-avvisi.png'))
        page.click('#avvisi-close')
        info = page.evaluate("""async()=>{const a=(await (await fetch('/api/avvisi')).json()).items.find(x=>x.stops&&x.stops.length);if(!a)return null;const id=a.stops[0];const s=(await (await fetch('/api/stops')).json()).find(x=>x[0]===id);return {id:a.id,name:s&&s[1]}}""")
        check(info is not None and info['name'], 'un avviso è collegato a una fermata: ' + str(info))
        if info and info['name']:
            page.click('#search-toggle-btn'); page.fill('#filter', info['name'][:20]); page.wait_for_selector('#search-results .search-item[data-type]', timeout=5000)
            page.evaluate("document.querySelector('#search-results .search-item[data-type]').click()")
            page.wait_for_selector('#panel:not([hidden]) #pname', timeout=8000); page.wait_for_selector('#plist .alert-row', timeout=8000)
            check(rect(page, '#pname .warn-i') is not None, 'simbolo (!) nel titolo della fermata')
            page.screenshot(path=str(OUT / f'{name}-7-stopalert.png'))
            page.click('#plist .alert-row'); page.wait_for_selector('#avvisi .av.hl', timeout=5000)
            check(True, 'clic sull\'avviso della fermata apre l\'avviso evidenziato')
            page.click('#avvisi-close')
            if rect(page, '#panel'): page.click('#pclose')   # su schermi stretti l'avviso sostituisce il pannello

        # --- v26: ricerca vuota senza preferiti (solo il campo); i preferiti restano nel loro pannello
        page.click('#search-toggle-btn'); page.wait_for_timeout(300)
        check(page.evaluate("!document.getElementById('search-results').classList.contains('active') && !document.querySelector('#search-results [data-type=fav], #search-results [data-type=saved]')"), 'ricerca aperta: nessun preferito, solo il campo')
        page.fill('#filter', 'xyz'); page.fill('#filter', ''); page.wait_for_timeout(200)
        check(page.evaluate("!document.querySelector('#search-results [data-type=fav]')"), 'ricerca svuotata: ancora nessun preferito')
        # --- v26: tastiera aperta (area visibile ridotta mentre si scrive): Percorso e crediti non salgono, risultati entro l'area visibile
        if w <= 900:
            fab0 = rect(page, '.plan-fab'); kh = int(h * 0.42)
            page.fill('#filter', 'S'); page.set_viewport_size({'width': w, 'height': h - kh}); page.wait_for_timeout(900)
            kb = page.evaluate("document.documentElement.classList.contains('kbd')")
            sr = rect(page, '#search-results'); fab = rect(page, '.plan-fab'); dk = rect(page, '#bottom-bar')
            check(kb and fab is None and dk is None, f'tastiera aperta: pulsante Percorso e barra in basso tolti (kbd={kb})')
            check(sr is None or sr['b'] <= h - kh + 1, f"risultati entro l'area sopra la tastiera ({sr and sr['b']:.0f} <= {h - kh})")
            page.set_viewport_size({'width': w, 'height': h}); page.evaluate("document.activeElement.blur()"); page.wait_for_timeout(900)
            fab1 = rect(page, '.plan-fab')
            check(fab0 is None or (fab1 and abs(fab1['t'] - fab0['t']) <= 1), 'tastiera chiusa: Percorso torna al suo posto')
        page.evaluate("document.getElementById('search-clear').click()"); page.evaluate("document.body.click()"); page.wait_for_timeout(200)
        if page.evaluate("document.getElementById('search-container').classList.contains('expanded')"): page.click('#search-toggle-btn')
        # --- v26: flusso dei mezzi senza tratto di linea a zoom basso (p=0), chiuso con la pagina nascosta e riaperto al ritorno
        su = page.evaluate("(window.__es||[]).slice(-1)[0] || ''")
        check('p=0' in su, f'flusso a zoom iniziale senza tratto di linea: {su[-40:]}')
        ne0 = page.evaluate("(window.__es||[]).length")
        page.evaluate("Object.defineProperty(document,'hidden',{configurable:true,get:()=>true}); Object.defineProperty(document,'visibilityState',{configurable:true,get:()=>'hidden'}); document.dispatchEvent(new Event('visibilitychange'))")
        n0 = page.evaluate("performance.getEntriesByType('resource').length"); page.wait_for_timeout(6000)
        nr = page.evaluate(f"performance.getEntriesByType('resource').slice({n0}).map(e=>e.name).filter(u=>u.includes('/api/'))")
        check(not nr, f'pagina nascosta: nessuna richiesta in 6 s ({nr[:3]})')
        page.evaluate("delete document.hidden; delete document.visibilityState; document.dispatchEvent(new Event('visibilitychange'))"); page.wait_for_timeout(1500)
        ne = page.evaluate("(window.__es||[]).length")
        check(ne > ne0, f'pagina di nuovo visibile: flusso riaperto subito ({ne} aperture)')
        # --- ricerca per linea: divisa per servizio, filtro mezzi
        page.click('#search-toggle-btn'); page.fill('#filter', '1'); page.wait_for_selector('#search-results .search-item[data-type=route]', timeout=5000)
        cats = page.evaluate("[...document.querySelectorAll('#search-results .search-category')].map(e=>e.textContent)")
        check(any('Linee' in c for c in cats), 'ricerca linee divisa per servizio: ' + str(cats))
        check(page.evaluate("document.querySelectorAll('#search-results .search-item[data-type=route] .bus').length") > 0, 'risultati linee con mattonelle')
        page.evaluate("document.querySelector('#search-results .search-item[data-type=route]').click()"); page.wait_for_timeout(600)
        check(rect(page, '#linefilter') is not None, 'chip filtro linea visibile')
        nl = page.evaluate("new Set([...document.querySelectorAll('.bus-marker .bus')].map(e=>e.textContent)).size"); check(nl <= 1, f'solo i mezzi della linea scelta ({nl} linee in mappa)')
        page.click('#linefilter'); page.wait_for_timeout(500)
        check(rect(page, '#linefilter') is None and page.evaluate("document.querySelectorAll('.bus-marker').length") > 1, 'filtro rimosso: tornano tutti i mezzi')
        check(page.evaluate("document.documentElement.style.getPropertyValue('--app-h') === Math.round(innerHeight)+'px'"), 'altezza app = altezza reale della finestra')
        # --- fermate vicine (250 m)
        st = page.evaluate("fetch('/api/stops').then(r=>r.json()).then(s=>s[0])")
        ctx.set_geolocation({'latitude': st[2], 'longitude': st[3]})
        check(page.get_attribute('#locate', 'data-state') == 'off', 'posizione spenta all\'apertura (nessuna richiesta automatica)')
        page.click('#locate'); page.wait_for_selector('#locate[data-state=on]', timeout=8000); page.wait_for_timeout(500)
        check(rect(page, '#nearchip') is not None, 'pillola fermate vicine con posizione attiva: ' + (page.inner_text('#nearchip').strip() if rect(page, '#nearchip') else ''))
        nc = rect(page, '#nearchip'); check(nc and nc['h'] >= 44 and nc['r'] <= w, 'pillola vicine >= 44px e dentro lo schermo')
        page.click('#nearchip'); page.wait_for_timeout(500)
        check(rect(page, '#panel') is not None or rect(page, '#search-results .search-item[data-type=near]') is not None, 'tocco sulla pillola apre fermata o elenco')
        if rect(page, '#search-results .search-item[data-type=near]'): page.click('#search-results .search-item[data-type=near]'); page.wait_for_timeout(400)
        if rect(page, '#panel'): page.click('#pclose')
        page.click('#locate'); page.wait_for_selector('#locate[data-state=follow]', timeout=3000)
        page.click('#locate'); page.wait_for_selector('#locate[data-state=off]', timeout=3000)
        check(rect(page, '#nearchip') is None, 'terzo tocco: posizione spenta e pillola rimossa')
        check(page.evaluate("!!document.getElementById('busybar') && !!document.getElementById('toast')"), 'barra di attesa e avviso presenti')
        # --- ordine dei blocchi di controllo
        gr = page.evaluate("[...document.querySelectorAll('#controls .group')].map(g=>[...g.querySelectorAll('button,input')].map(b=>b.id||b.name))")
        check(gr[1] == ['search-toggle-btn', 'locate', 'theme-btn'] and gr[2][:2] == ['avvisi-btn', 'tide-btn'], 'blocchi: servizi | cerca+posizione+tema | avvisi+marea ' + str(gr))

        # --- modalità pianificato
        page.evaluate("document.querySelector('input[name=mode][value=sched]').click()"); page.wait_for_timeout(1200)
        check(page.evaluate("!!document.getElementById('tl-date').min && !!document.getElementById('tl-date').max"), 'selettore data limitato ai GTFS in archivio (min/max)')
        dock = rect(page, '#bottom-bar'); lim = 230 if w < 560 else 160; check(dock['h'] <= lim, f"dock Pianificato compatto ({dock['h']:.0f}px, limite {lim})")
        di = rect(page, '.dock-in'); check(di['w'] <= 761, f"dock-in Pianificato <= 760 ({di['w']:.0f}px)")
        tc = rect(page, '#timeline-controls'); check(tc['r'] <= w + 1 and tc['l'] >= -1, 'controlli orario entro lo schermo')
        small = page.evaluate("[...document.querySelectorAll('#bottom-bar button,#bottom-bar input,#bottom-bar select,#bottom-bar label')].map(e=>{const r=e.getBoundingClientRect();return [e.id||e.tagName,r.width,r.height]}).filter(x=>x[2]>0&&(x[2]<43.5))")
        check(not [s for s in small if s[0] not in ('INPUT',)], f'bersagli del dock >= 44px {small}')
        page.screenshot(path=str(OUT / f'{name}-4-sched.png'))
        # nessuna barra di scorrimento orizzontale
        check(page.evaluate("document.documentElement.scrollWidth <= innerWidth"), 'nessuno scorrimento orizzontale')
        ctx.close()
    # --- v23: link condivisibili e scorciatoie (una volta, telefono)
    # senza service worker: Leaflet finto a ogni apertura
    ctx = br.new_context(viewport={'width': 390, 'height': 844}, extra_http_headers={'X-Forwarded-For': '10.9.200.200'}, service_workers='block'); ctx.add_init_script(GUIDE_OFF); page = ctx.new_page(); errs = []
    page.on('pageerror', lambda e: errs.append(str(e)))
    page.route('**/vendor/leaflet/leaflet.js', lambda r: r.fulfill(body=STUB, content_type='application/javascript'))
    page.route('**/vendor/leaflet/leaflet.css', lambda r: r.fulfill(body='', content_type='text/css'))
    page.route('https://tile.openstreetmap.org/**', lambda r: r.abort())
    st = json.loads(page.request.get(BASE + '/api/stops?src=nav').text()); sid = st[0][0]
    page.goto(BASE + '/?fermata=' + sid); page.wait_for_selector('#plist .dep, #plist p', timeout=20000)
    check(rect(page, '#panel') is not None and '?' not in page.url, 'link ?fermata= apre la fermata e pulisce l\'indirizzo')
    page.goto(BASE + '/?fermata=%3Cimg%20src%3Dx%3E'); page.wait_for_timeout(2500)
    check(rect(page, '#panel') is None and not page.query_selector('img[src=x]'), 'link non valido: nessun pannello, nessun HTML inserito')
    page.goto(BASE + f'/?da=f:{st[0][0]}&a=f:{st[5][0]}'); page.wait_for_selector('.pp-opt, .pp-walkonly, #plist p', timeout=20000)
    check(page.evaluate("document.querySelectorAll('.pp-mini .pp-sum-p').length") == 2, 'link ?da=&a= apre il pianificatore con i due punti (riepilogo)')
    page.goto(BASE + '/?apri=preferiti'); page.wait_for_timeout(2500)
    check(page.evaluate("!document.getElementById('favs').hidden"), 'scorciatoia «Preferiti»: pannello dei preferiti aperto')
    page.goto(BASE + '/?apri=percorso'); page.wait_for_selector('.pp-q, .pp-fields', timeout=8000); check(True, 'scorciatoia «Pianifica percorso»')
    man = json.loads(page.request.get(BASE + '/manifest.webmanifest').text())
    check(len(man.get('shortcuts', [])) == 3 and all(page.request.get(BASE + x['icons'][0]['src']).ok for x in man['shortcuts']), 'manifest: 3 scorciatoie con icone')
    check(not errs, 'link e scorciatoie: nessun errore ' + str(errs[:2]))
    # --- guida interattiva: prima apertura, pannello, «Rivedi la guida»
    print('== guida')
    ctx = br.new_context(viewport={'width': 390, 'height': 844}, has_touch=True, extra_http_headers={'X-Forwarded-For': '10.9.201.201'}, service_workers='block'); page = ctx.new_page(); errs = []
    page.on('pageerror', lambda e: errs.append(str(e)))
    page.route('**/vendor/leaflet/leaflet.js', lambda r: r.fulfill(body=STUB, content_type='application/javascript'))
    page.route('**/vendor/leaflet/leaflet.css', lambda r: r.fulfill(body='', content_type='text/css'))
    page.route('https://tile.openstreetmap.org/**', lambda r: r.abort())
    page.goto(BASE); page.wait_for_selector('.tg .tg-card', timeout=20000); page.wait_for_timeout(400)
    check(page.get_attribute('.tg', 'role') == 'dialog' and page.get_attribute('.tg', 'aria-modal') == 'true', 'guida: finestra di dialogo modale')
    n = page.evaluate("document.querySelectorAll('.tg-dots i').length"); check(n >= 7, f'guida della mappa: {n} passi')
    page.mouse.click(195, 700); page.wait_for_timeout(450)                  # tocco sullo schermo oscurato: avanti, nient'altro
    check('on' in (page.get_attribute('.tg-dots i:nth-child(2)', 'class') or '') and rect(page, '#panel') is None, 'tocco fuori dalla scheda: passo successivo, l\'app sotto non reagisce')
    page.click('[data-tg=prev]'); page.wait_for_timeout(350); check('on' in (page.get_attribute('.tg-dots i:nth-child(1)', 'class') or ''), 'Indietro')
    out = []
    for i in range(n):
        c = page.evaluate("(()=>{const r=document.querySelector('.tg-card').getBoundingClientRect();return {l:r.left,t:r.top,r:r.right,b:r.bottom}})()"); h = page.evaluate("(()=>{const h=document.querySelector('.tg-hole');return h.classList.contains('none')?null:h.getBoundingClientRect().toJSON()})()")
        if not (c and c['l'] >= 0 and c['r'] <= 391 and c['t'] >= 0 and c['b'] <= 845): out.append(f'scheda {i+1} fuori schermo')
        if h and c and overlap(c, {'l': h['left'], 'r': h['right'], 't': h['top'], 'b': h['bottom']}): out.append(f'scheda {i+1} copre il punto')
        page.keyboard.press('ArrowRight') if i % 2 else page.click('[data-tg=next]'); page.wait_for_timeout(420)
    check(not out, 'schede entro lo schermo e accanto al punto ' + str(out))
    check(page.query_selector('.tg') is None, 'guida finita dopo l\'ultimo passo')
    saved = page.evaluate("localStorage.getItem('tpl.guida')"); check(saved and '"mappa":true' in saved, 'guida ricordata sul telefono')
    page.reload(); page.wait_for_selector('.bus-marker', timeout=20000); page.wait_for_timeout(3500); check(page.query_selector('.tg') is None, 'riaperta l\'app: la guida non ricompare')
    page.click('#search-toggle-btn'); page.fill('#filter', 'San Zaccaria'); page.wait_for_timeout(500)
    page.click('#search-results .search-item[data-type=zone], #search-results .search-item[data-type=stop]')
    page.wait_for_selector('.tg .tg-card', timeout=10000); page.wait_for_timeout(400)
    check(page.query_selector('.tg-hole:not(.none)') is not None, 'prima fermata aperta: guida del pannello con il punto in luce')
    page.keyboard.press('Escape'); page.wait_for_timeout(350)
    check(page.query_selector('.tg') is None and rect(page, '#panel') is not None, 'Esc chiude la guida e non il pannello')
    page.click('#pclose'); page.wait_for_timeout(300); page.click('#info-btn'); page.wait_for_selector('#info-guide', timeout=5000); page.click('#info-guide')
    page.wait_for_selector('.tg .tg-card', timeout=5000); check(rect(page, '#info') is None, '«Rivedi la guida» dalle Informazioni')
    page.click('.tg-x'); page.wait_for_timeout(350); check(page.query_selector('.tg') is None, 'X chiude la guida')
    check(not errs, 'guida: nessun errore ' + str(errs[:2]))
    br.close()
print('\nFALLITI:', len(fails)); [print(' -', f) for f in fails]
sys.exit(1 if fails else 0)
