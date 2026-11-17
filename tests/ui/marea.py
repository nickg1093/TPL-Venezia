# PROVE DEL GRAFICO DELLA MAREA (tide.js) con il server di prova già avviato (vedi run.py):
#   python3 tests/ui/marea.py http://localhost:3111 /tmp/ui
# Etichette del grafico (valori dei massimi e minimi, «MOSE 110» sulla linea tratteggiata della soglia, «MOSE hh:mm» sulla linea verticale
# del sollevamento programmato): nessuna si sovrappone a un'altra, tutte dentro il grafico, in diversi casi difficili e su più schermi.
import sys, json, math, pathlib, datetime
from playwright.sync_api import sync_playwright
BASE = sys.argv[1] if len(sys.argv) > 1 else 'http://localhost:3111'
OUT = pathlib.Path(sys.argv[2] if len(sys.argv) > 2 else '/tmp/ui'); OUT.mkdir(parents=True, exist_ok=True)
STUB = (pathlib.Path(__file__).parent / 'leaflet-stub.js').read_text()
GUIDE_OFF = "try{localStorage.setItem('tpl.guida', JSON.stringify({v:'v99', mappa:true, pannello:true}))}catch(e){}"
H = 3600000
fails = []
def check(ok, msg):
    print(('  ok   ' if ok else '  FAIL ') + msg)
    if not ok: fails.append(msg)

def tide(n, ex):                                     # curva tra gli estremi (ore da adesso, cm)
    ex = sorted(ex)
    def f(t):
        h = (t - n) / H
        for (h0, c0), (h1, c1) in zip(ex, ex[1:]):
            if h0 <= h <= h1: return c0 + (c1 - c0) * (1 - math.cos(math.pi * (h - h0) / (h1 - h0))) / 2
        return ex[0][1] if h < ex[0][0] else ex[-1][1]
    obs = [[n - k * 600000, round(f(n - k * 600000))] for k in range(36, -1, -1)]
    fc = [[n + k * 600000, round(f(n + k * 600000))] for k in range(1, 109)]
    exts = [{'type': 'max' if c > ex[i - 1][1] else 'min', 'cm': c, 'ts': n + int(h * H)} for i, (h, c) in enumerate(ex) if 0 < h and 0 < i < len(ex) - 1]
    return {'station': 'Punta Salute', 'cm': round(f(n)), 'ts': n, 'ageMin': 1, 'stale': False, 'category': {'key': 'sostenuta', 'label': 'Marea sostenuta'},
            'trend': {'dir': 'up', 'rate': 4, 'basis': 'misure'}, 'next': exts[:4], 'history': obs, 'source': {'name': 'CPSM', 'license': 'CC BY', 'url': 'https://dati.venezia.it/'},
            'chart': {'from': n - 6 * H, 'to': n + 18 * H, 'now': n, 'observed': obs, 'forecast': fc, 'extremes': exts}, 'mose': {'stato': 'programmato'}}

# casi: colmo subito dopo il sollevamento, colmo e sollevamento al bordo destro, sollevamento quasi adesso con massimo vicino, soglia vicino a un massimo
CASI = [('colmo-dopo', [[-6, 40], [-1, 60], [3, 125], [9, 40], [15, 118], [18.5, 60]], 1),
        ('bordo-destro', [[-6, 40], [-1, 60], [5, 70], [11, 40], [17, 122], [19, 60]], 16.5),
        ('quasi-adesso', [[-6, 90], [-1, 105], [1.5, 128], [7, 60], [13, 115], [19, 60]], 0.6),
        ('soglia-al-massimo', [[-6, 50], [-2, 70], [4, 111], [10, 45], [16, 109], [19, 70]], 3.2)]
with sync_playwright() as p:
    br = p.chromium.launch()
    for name, w, h in [('phone', 360, 780), ('tablet', 820, 1180), ('desktop', 1440, 900)]:
        print(f'== {name} {w}x{h}')
        for caso, ex, evh in CASI:
            ctx = br.new_context(viewport={'width': w, 'height': h}, service_workers='block'); ctx.add_init_script(GUIDE_OFF)
            page = ctx.new_page(); errs = []; page.on('pageerror', lambda e: errs.append(str(e)))
            page.route('**/vendor/leaflet/leaflet.js', lambda r: r.fulfill(body=STUB, content_type='application/javascript'))
            page.route('**/vendor/leaflet/leaflet.css', lambda r: r.fulfill(body='', content_type='text/css'))
            n = int(datetime.datetime.now().timestamp() * 1000) // 60000 * 60000
            ev = datetime.datetime.fromtimestamp((n + evh * H) / 1000)
            m = {'stato': 'programmato', 'sem': 'giallo', 'titolo': 'Sollevamento programmato', 'barriere': [], 'evento': {'data': ev.strftime('%d/%m/%Y'), 'orario': ev.strftime('%H:%M')}, 'aggiornato': n, 'fonte': {'nome': 'Autorità per la Laguna di Venezia', 'url': 'https://www.autoritalaguna.it/'}}
            page.route('**/api/tide', (lambda b: lambda r: r.fulfill(body=b, content_type='application/json'))(json.dumps(tide(n, ex))))
            page.route('**/api/mose', (lambda b: lambda r: r.fulfill(body=b, content_type='application/json'))(json.dumps(m)))
            page.goto(BASE + '/'); page.wait_for_timeout(2500)
            page.click('#tide-btn'); page.wait_for_selector('.tide-chart svg'); page.wait_for_timeout(1500)
            r = page.evaluate("""(()=>{const svg=document.querySelector('.tide-chart svg'), vb=svg.viewBox.baseVal;
              const t=[...svg.querySelectorAll('text.exl, text.mst')].map(e=>{const b=e.getBBox();return {s:e.textContent,x0:b.x,x1:b.x+b.width,y0:b.y,y1:b.y+b.height}});
              const ov=[]; for(let i=0;i<t.length;i++) for(let j=i+1;j<t.length;j++){const a=t[i],b=t[j]; if(a.x0<b.x1&&b.x0<a.x1&&a.y0<b.y1&&b.y0<a.y1) ov.push(a.s+' / '+b.s);}
              const out=t.filter(a=>a.x0<0||a.x1>vb.width||a.y0<0||a.y1>vb.height).map(a=>a.s);
              return {n:t.length, mose:t.filter(a=>/MOSE/.test(a.s)).map(a=>a.s), ov, out, vline:!!svg.querySelector('line.msv')};})()""")
            check(r['vline'] and len(r['mose']) == 2, f'{caso}: soglia e orario del MOSE nel grafico {r["mose"]}')
            check(not r['ov'], f'{caso}: etichette senza sovrapposizioni {r["ov"]}')
            check(not r['out'], f'{caso}: etichette dentro il grafico {r["out"]}')
            check(not errs, f'{caso}: nessun errore {errs[:2]}')
            page.query_selector('.tide-chart svg').screenshot(path=str(OUT / f'marea-{name}-{caso}.png'))
            ctx.close()
    br.close()
print(f'\nFALLITI: {len(fails)}')
sys.exit(1 if fails else 0)
