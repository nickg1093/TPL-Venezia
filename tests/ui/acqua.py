# PROVE DEI LIVELLI DELL'ACQUA ALTA (livelli.js) con il server di prova già avviato (vedi run.py):
#   python3 tests/ui/acqua.py http://localhost:3111 /tmp/ui        (TESTO=1.3 per il testo «Molto grande»)
# Marea finta alta (+108 cm adesso, colmo +118), MOSE a riposo, data in stagione: allagamento e passerelle si accendono da soli.
# Poi MOSE programmato con previsione +125: in città si conta il livello limitato dalle barriere.
import sys, json, pathlib, os, time, math
from playwright.sync_api import sync_playwright
BASE = sys.argv[1] if len(sys.argv) > 1 else 'http://localhost:3111'
OUT = pathlib.Path(sys.argv[2] if len(sys.argv) > 2 else '/tmp/ui'); OUT.mkdir(parents=True, exist_ok=True)
STUB = (pathlib.Path(__file__).parent / 'leaflet-stub.js').read_text()
TESTO = os.environ.get('TESTO', '')
TESTO_JS = f"try{{localStorage.setItem('tpl.testo','{TESTO}')}}catch(e){{}}" if TESTO in ('1.15', '1.3') else "0"
GUIDE_OFF = "try{localStorage.setItem('tpl.guida', JSON.stringify({v:'v33', mappa:true, pannello:true}))}catch(e){}"
# data finta in stagione (17 novembre 2026, 10:00 a Venezia) per avere sempre le passerelle, qualunque sia il giorno della prova
CLOCK = "(()=>{const T0=Date.UTC(2026,10,17,9,0,0), d=T0-Date.now(), N=Date.now; Date.now=()=>N()+d; const D=Date; class F extends D{constructor(...a){super(...(a.length?a:[Date.now()]))}} F.now=Date.now; F.UTC=D.UTC; F.parse=D.parse; window.Date=F;})()"
T0 = 1794906000000   # stesso istante in millisecondi
fails = []
def check(ok, msg):
    print(('  ok   ' if ok else '  FAIL ') + msg)
    if not ok: fails.append(msg)

def tide(now_cm, peak_cm, mose):
    n, H = T0, 3600000
    curve = lambda t: now_cm + (peak_cm - now_cm) * math.sin(min(max((t - n) / (3 * H), 0), 1) * math.pi / 2) if t >= n else now_cm - (n - t) / H * 6
    obs = [[n - k * 600000, round(curve(n - k * 600000))] for k in range(36, -1, -1)]
    fc = [[n + k * 600000, round(curve(n + k * 600000))] for k in range(1, 37)]
    return {'station': 'Punta Salute', 'cm': now_cm, 'ts': n, 'ageMin': 1, 'stale': False, 'category': {'key': 'sostenuta', 'label': 'Marea sostenuta'}, 'trend': {'dir': 'up', 'rate': 4, 'basis': 'misure'},
            'next': [{'type': 'max', 'cm': peak_cm, 'ts': n + 3 * H}], 'history': obs, 'source': {'name': 'CPSM', 'license': 'CC BY', 'url': 'https://dati.venezia.it/'},
            'chart': {'from': n - 6 * H, 'to': n + 6 * H, 'now': n, 'observed': obs, 'forecast': fc, 'extremes': [{'type': 'max', 'cm': peak_cm, 'ts': n + 3 * H}]}, 'mose': {'stato': mose}}

with sync_playwright() as p:
    br = p.chromium.launch()
    for name, w, h in [('phone', 390, 844), ('desktop', 1440, 900)]:
        print(f'== {name} {w}x{h}')
        for scen, (now_cm, peak_cm, mose) in [('alta', (108, 118, 'recesso')), ('mose', (78, 125, 'programmato')), ('prova', (45, 50, 'recesso'))]:
            ctx = br.new_context(viewport={'width': w, 'height': h}, has_touch=name == 'phone', service_workers='block')   # senza service worker: Leaflet finto anche dopo il ricaricamento
            for s in (CLOCK, GUIDE_OFF, TESTO_JS): ctx.add_init_script(s)
            page = ctx.new_page(); errs = []; acq = []
            page.on('pageerror', lambda e: errs.append(str(e)))
            page.on('request', lambda r: acq.append(r.url) if '/acqua/' in r.url else None)
            page.route('**/vendor/leaflet/leaflet.js', lambda r: r.fulfill(body=STUB, content_type='application/javascript'))
            page.route('**/vendor/leaflet/leaflet.css', lambda r: r.fulfill(body='', content_type='text/css'))
            d = tide(now_cm, peak_cm, mose)
            page.route('**/api/tide', (lambda body: lambda r: r.fulfill(body=body, content_type='application/json'))(json.dumps(d)))
            page.route('**/api/mose', (lambda body: lambda r: r.fulfill(body=body, content_type='application/json'))(json.dumps({'stato': mose, 'sem': 'giallo' if mose == 'programmato' else 'verde', 'titolo': 'MOSE', 'barriere': []})))
            page.goto(BASE + ('/?marea=110' if scen == 'prova' else '/')); page.wait_for_timeout(4000)
            if scen == 'alta': check(page.evaluate("!window.__acquaImg"), 'mappa lontana (zoom 12): niente acqua disegnata')
            page.evaluate("__map.setView([45.4345, 12.3375], 15)"); page.wait_for_timeout(1500)   # da vicino: calli allagate (senza rete: griglia)
            npass = page.evaluate("[...__map._polys].filter(p=>/pass-l/.test(p.o?.className||'')).length")
            if scen == 'alta':
                check(page.evaluate("!!window.__acquaImg"), 'marea +108 cm: allagamento acceso da solo')
                check(npass >= 20, f'passerelle posate fino a +108 cm sulla mappa ({npass})')
                check(any('/acqua/quote.json' in u for u in acq) and any('/acqua/passerelle.json' in u for u in acq), 'dati scaricati solo adesso che servono')
                check(page.evaluate("document.querySelector('#livelli-btn .fbadge').dataset.k==='acqua' && !document.querySelector('#livelli-btn .fbadge').hidden"), 'punto blu sul pulsante Livelli')
                check(page.evaluate("!document.getElementById('toast').hidden && /Acqua alta/.test(document.getElementById('toast').textContent)"), 'avviso breve: livelli accesi da soli')
                page.click('#livelli-btn'); page.wait_for_selector('#livelli:not([hidden])')
                sub = page.inner_text('#lv-all-sub'); check('+108' in sub and 'automatico' in sub, f'livello e modo nel menu: «{sub}»')
                ril = page.evaluate("fetch('/acqua/rilievo/indice.json').then(r=>r.ok)")
                foot = page.inner_text('#lv-foot-q'); leg = page.evaluate("!!document.querySelector('#lv-nota .lv-ql.s')")
                card = page.evaluate("!document.getElementById('ip-ramses').hidden")
                check('potenzialmente' in foot, f'zone potenzialmente allagabili, non allagamento certo: «{foot[:60]}»')
                if ril: check('misurate' in foot and 'stimate' in foot and 'Fonte informativa: Insula spa' in foot and leg and card, f'rilievo: quote misurate e stimate distinte, fonte Insula, scheda Informazioni ({leg}, {card})')
                else: check('stima' in foot and not leg and not card, f'senza rilievo (versione pubblicabile): solo stima, niente Insula ({leg}, {card})')
                check(page.evaluate("document.getElementById('lv-all').checked && document.getElementById('lv-pass').checked"), 'interruttori accesi')
                page.click('.lv-seg button[data-q=colmo]'); page.wait_for_timeout(500)
                sub = page.inner_text('#lv-all-sub'); npc = page.evaluate("[...__map._polys].filter(p=>/pass-l/.test(p.o?.className||'')).length")
                check('colmo' in sub and '+118' in sub and npc > npass, f'colmo previsto: «{sub}», passerelle {npass} → {npc}')
                page.click('#livelli .sw-row:nth-child(1)'); page.wait_for_timeout(400)
                check(page.evaluate("!window.__acquaImg"), 'allagamento spento a mano')
                check(page.evaluate("!!document.querySelector('#lv-nota [data-auto]')"), '«Torna ad automatico» disponibile')
                page.click('#lv-nota [data-auto]'); page.wait_for_timeout(400); check(page.evaluate("!!window.__acquaImg"), 'di nuovo automatico: allagamento acceso')
                lv = page.evaluate("(()=>{const r=document.getElementById('livelli').getBoundingClientRect();return [r.left,r.top,r.right,r.bottom]})()")
                check(lv[0] >= -1 and lv[2] <= w + 1 and lv[1] >= -1 and lv[3] <= h + 1, 'menu dentro lo schermo')
                over = page.evaluate("[...document.querySelectorAll('#livelli .sw-t, #livelli .lv-seg button, #lv-nota p')].filter(e=>e.scrollWidth>e.clientWidth+1).length")
                check(over == 0, f'nessun testo tagliato nel menu ({over})')
                tg = page.evaluate("Math.min(...[...document.querySelectorAll('#livelli .sw-row, #livelli .lv-seg button, #livelli-close, #lv-nota button')].map(e=>e.getBoundingClientRect().height))")
                check(tg >= 44, f'bersagli di tocco ≥ 44 px ({tg})')
                page.screenshot(path=str(OUT / f'acqua-{name}{TESTO}.png'))
                # ripresa dal telefono: seconda apertura senza scaricare di nuovo i file (cache «tpl-fissi-1»)
                acq.clear(); page.reload(); page.wait_for_timeout(6000); page.evaluate("__map.setView([45.4345, 12.3375], 15)"); page.wait_for_timeout(1500)
                check(not any('/acqua/quote.json' in u or '/acqua/passerelle.json' in u for u in acq) and page.evaluate("!!window.__acquaImg"), f'seconda apertura: dati dal telefono {acq}')
                # SENZA RETE per i dati dell'acqua (indice compreso): l'app usa l'ultimo indice e i file verificati salvati nel telefono
                p2 = ctx.new_page(); e2 = []; p2.on('pageerror', lambda e: e2.append(str(e)))
                p2.route('**/vendor/leaflet/leaflet.js', lambda r: r.fulfill(body=STUB, content_type='application/javascript'))
                p2.route('**/vendor/leaflet/leaflet.css', lambda r: r.fulfill(body='', content_type='text/css'))
                p2.route('**/api/tide', (lambda body: lambda r: r.fulfill(body=body, content_type='application/json'))(json.dumps(d)))
                p2.route('**/acqua/**', lambda r: r.abort('internetdisconnected'))
                p2.goto(BASE + '/'); p2.wait_for_timeout(5000); p2.evaluate("__map.setView([45.4345, 12.3375], 15)"); p2.wait_for_timeout(1500)
                check(p2.evaluate("!!window.__acquaImg") and not e2, f'senza rete: allagamento dai dati salvati nel telefono ({e2[:1]})')
                p2.close()
            elif scen == 'prova':
                check(page.evaluate("!!window.__acquaImg") and npass > 20, f'prova in locale «?marea=110» con la marea vera a +45: livelli accesi ({npass})')
                page.click('#livelli-btn'); page.wait_for_selector('#livelli:not([hidden])')
                check('simulato' in page.inner_text('#lv-nota'), 'nota «livello simulato»')
            else:
                check(page.evaluate("!window.__acquaImg") and npass == 0, 'adesso +78 cm: nessun livello acceso')
                page.click('#livelli-btn'); page.wait_for_selector('#livelli:not([hidden])')
                page.click('.lv-seg button[data-q=colmo]'); page.wait_for_timeout(800)
                nota = page.inner_text('#lv-nota'); sub = page.inner_text('#lv-all-sub')
                check('MOSE' in nota and '+125' in nota, f'MOSE previsto: nota sul livello in mare e in città «{nota[:120]}»')
                check('+88' in sub, f'in città si conta il livello limitato dalle barriere: «{sub}»')
                page.click('.lv-seg button[data-q=ora]')
            check(not errs, f'nessun errore ({errs[:2]})')
            ctx.close()
    br.close()
print(f'\nFALLITI: {len(fails)}')
sys.exit(1 if fails else 0)
