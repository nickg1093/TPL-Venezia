# MISURE DI PRESTAZIONE (v34) con il server di prova già avviato (vedi run.py), in Chromium headless su schermo da telefono:
#   python3 tests/ui/prestazioni.py http://localhost:3111 /tmp/ui [secondi=90]
# Misura: avvio (DOMContentLoaded, load, primo disegno delle fermate), richieste e byte nei primi 30 s e nel resto della sessione,
# memoria JS della pagina all'inizio e alla fine (crescita), compiti lunghi (> 50 ms), memoria del processo del server (RSS, da /proc).
# Scrive OUT/prestazioni.json e stampa un riepilogo. Non fallisce: è una misura, da confrontare prima/dopo una modifica.
import sys, json, time, pathlib, subprocess
from playwright.sync_api import sync_playwright
BASE = sys.argv[1] if len(sys.argv) > 1 else 'http://localhost:3111'
OUT = pathlib.Path(sys.argv[2] if len(sys.argv) > 2 else '/tmp/ui'); OUT.mkdir(parents=True, exist_ok=True)
DUR = int(sys.argv[3]) if len(sys.argv) > 3 else 90
STUB = (pathlib.Path(__file__).parent / 'leaflet-stub.js').read_text()
GUIDE = "try{localStorage.setItem('tpl.guida', JSON.stringify({v:'v34', mappa:true, pannello:true}))}catch(e){}"
LONG = "window.__long=[];try{new PerformanceObserver(l=>{for(const e of l.getEntries())__long.push(e.duration)}).observe({type:'longtask',buffered:true})}catch(e){}"
def rss():
    try:
        pid = subprocess.run(['pgrep', '-f', 'node.*server.js'], capture_output=True, text=True).stdout.split()[0]
        for l in open(f'/proc/{pid}/status'):
            if l.startswith('VmRSS'): return round(int(l.split()[1]) / 1024)
    except Exception: return None
res = {'server_rss_inizio_mb': rss()}
with sync_playwright() as p:
    br = p.chromium.launch(args=['--enable-precise-memory-info'])
    ctx = br.new_context(viewport={'width': 390, 'height': 844}, has_touch=True, device_scale_factor=2)
    ctx.add_init_script(GUIDE); ctx.add_init_script(LONG)
    reqs = []
    ctx.on('requestfinished', lambda r: reqs.append((time.time(), r.url, (r.sizes() or {}).get('responseBodySize', 0) if r.url.startswith(BASE) and not r.url.endswith('/api/stream') else 0)))
    pg = ctx.new_page(); pg.route('**/*tile.openstreetmap.org/**', lambda r: r.abort())
    t0 = time.time(); pg.goto(BASE, wait_until='load')
    nav = pg.evaluate("(()=>{const n=performance.getEntriesByType('navigation')[0];return {dcl:Math.round(n.domContentLoadedEventEnd),load:Math.round(n.loadEventEnd)}})()")
    try:
        pg.wait_for_function("document.querySelectorAll('.stop-dot,.leaflet-marker-icon,.lf-m').length>0 || (window.L&&true)", timeout=20000)
    except Exception: pass
    pg.wait_for_function("document.getElementById('status') && !/Carico|caric/i.test(document.getElementById('status').textContent)", timeout=30000)
    res['avvio'] = {**nav, 'pronta_ms': round((time.time() - t0) * 1000)}
    heap0 = pg.evaluate("performance.memory?Math.round(performance.memory.usedJSHeapSize/1048576):null")
    pg.wait_for_timeout(30000 - min(30000, int((time.time() - t0) * 1000)))
    t30 = time.time(); r30 = [x for x in reqs if x[0] <= t30]
    pg.wait_for_timeout(max(0, DUR - 30) * 1000)
    pg.evaluate("window.gc&&gc()")
    heap1 = pg.evaluate("performance.memory?Math.round(performance.memory.usedJSHeapSize/1048576):null")
    dom = pg.evaluate("document.getElementsByTagName('*').length")
    long = pg.evaluate("__long")
    rest = [x for x in reqs if x[0] > t30]
    res['richieste'] = {'primi_30s': len(r30), 'kb_primi_30s': round(sum(x[2] for x in r30) / 1024), 'dopo': len(rest), 'kb_dopo': round(sum(x[2] for x in rest) / 1024),
                        'al_minuto_dopo': round(len(rest) / max(1, (time.time() - t30) / 60), 1)}
    res['memoria_pagina_mb'] = {'inizio': heap0, 'fine': heap1}; res['nodi_dom'] = dom
    res['compiti_lunghi'] = {'n': len(long), 'max_ms': round(max(long) if long else 0), 'totale_ms': round(sum(long))}
    br.close()
res['server_rss_fine_mb'] = rss(); res['durata_s'] = DUR
(OUT / 'prestazioni.json').write_text(json.dumps(res, indent=1))
print(json.dumps(res, indent=1))
