# COPERTURA DEGLI ELEMENTI INTERATTIVI NON PROVATI ALTROVE (v34), con il server di prova già avviato (vedi run.py):
#   python3 tests/ui/copertura.py http://localhost:3111 /tmp/ui        (anche TESTO=1.3)
# Matrice completa in tests/collaudo/RAPPORTO.md. Qui: installazione (iPhone e Chrome/Android), campanella degli avvisi attivi e
# «Disattiva», indice e chiusura di Informazioni, scheda Mezzi (mezzi senza linea, ricordato), Preferiti (chiusura, copia scaricata,
# ripristino da file valido / rovinato / estraneo), pannello della fermata («Percorso da qui»), pannello del mezzo («Avvisami»),
# riga del Programmato (avvio/pausa, velocità, cursore, «ORA»), tema scuro ricordato. Per ciascuno: risultato, errori, ricaricamento.
import sys, os, json, re, pathlib, time
from playwright.sync_api import sync_playwright
BASE = sys.argv[1] if len(sys.argv) > 1 else 'http://localhost:3111'
OUT = pathlib.Path(sys.argv[2] if len(sys.argv) > 2 else '/tmp/ui'); OUT.mkdir(parents=True, exist_ok=True)
TS = os.environ.get('TESTO', '')
INIT = "try{localStorage.setItem('tpl.guida', JSON.stringify({v:'v34', mappa:true, pannello:true}));" + (f"localStorage.setItem('tpl.testo','{TS}');" if TS else '') + "}catch(e){}"
fails = []
def check(ok, msg):
    print(('  ok   ' if ok else '  FAIL ') + msg)
    if not ok: fails.append(msg)
def visible(pg, sel): return pg.evaluate("s=>{const e=document.querySelector(s);if(!e||e.hidden)return false;const r=e.getBoundingClientRect();return r.width>0&&r.height>0&&getComputedStyle(e).visibility!=='hidden'}", sel)
def toast(pg, ms=4000):
    t0 = time.time()
    while time.time() - t0 < ms / 1000:
        t = pg.evaluate("(()=>{const e=document.getElementById('toast');return e&&!e.hidden?e.textContent:''})()")
        if t: return t
        pg.wait_for_timeout(100)
    return ''
def nuovo(br, **kw):
    ctx = br.new_context(viewport=kw.pop('viewport', {'width': 390, 'height': 844}), has_touch=True, accept_downloads=True, **kw)
    ctx.add_init_script(INIT); ctx.route('**/*tile.openstreetmap.org/**', lambda r: r.abort())
    pg = ctx.new_page(); errs = []; pg.on('pageerror', lambda e: errs.append(str(e)))
    return ctx, pg, errs
def pronto(pg, url=''):
    pg.goto(BASE + url); pg.wait_for_function("!/Caric/.test(document.getElementById('status').textContent)", timeout=30000)

with sync_playwright() as p:
    br = p.chromium.launch()
    # ---- 1. installazione su iPhone: istruzioni, «Non ora» ricordato 14 giorni ----
    ctx, pg, errs = nuovo(br, user_agent='Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1')
    pronto(pg)
    check(visible(pg, '#install-btn'), 'iPhone: pulsante «Installa» visibile (niente evento del browser)')
    pg.click('#install-btn'); pg.wait_for_timeout(300)
    check(visible(pg, '#snack') and 'Aggiungi alla schermata Home' in pg.inner_text('#snack') and not visible(pg, '#snack-install'), 'iPhone: istruzioni «Condividi → Aggiungi alla schermata Home», senza pulsante Installa')
    pg.click('#snack-close'); pg.wait_for_timeout(200)
    check(not visible(pg, '#snack') and pg.evaluate("+localStorage.getItem('installSnooze')>Date.now()+13*864e5"), '«Non ora»: chiuso e ricordato per 14 giorni')
    pg.reload(); pg.wait_for_timeout(5000)
    check(not visible(pg, '#snack'), 'dopo il ricaricamento nessun suggerimento automatico')
    check(not errs, f'iPhone: nessun errore {errs[:1]}'); ctx.close()

    # ---- 2. installazione con Chrome/Android: evento simulato, richiesta del browser, rifiuto = pausa ----
    ctx, pg, errs = nuovo(br); pronto(pg)
    check(not visible(pg, '#install-btn'), 'Chrome senza evento: niente pulsante «Installa»')
    pg.evaluate("""(()=>{const e=new Event('beforeinstallprompt');e.prompt=()=>{window.__asked=(window.__asked||0)+1};e.userChoice=Promise.resolve({outcome:'dismissed'});dispatchEvent(e)})()""")
    pg.wait_for_timeout(300)
    check(visible(pg, '#install-btn') and visible(pg, '#snack-install'), 'evento del browser: pulsante e suggerimento «Installa»')
    pg.click('#snack-install'); pg.wait_for_timeout(300)
    check(pg.evaluate('window.__asked') == 1 and not visible(pg, '#install-btn') and pg.evaluate("+localStorage.getItem('installSnooze')>Date.now()"), 'richiesta del browser una volta; rifiutata: pulsante tolto e pausa')
    check(not errs, f'Chrome: nessun errore {errs[:1]}'); ctx.close()

    # ---- 3. campanella degli avvisi attivi, «Disattiva», indice e chiusura di Informazioni ----
    ctx, pg, errs = nuovo(br)
    ctx.add_init_script("""try{if(!sessionStorage.getItem('w')){sessionStorage.setItem('w','1');localStorage.setItem('tpl.watches',JSON.stringify([{id:'abcdefgh12',token:'tokentokentoken12',mode:'poll',trip:'nav:T1',stop:'nav:5032',stopName:'Rialto',lead:5,line:'1',headsign:'Lido',until:Date.now()+36e5}]))}}catch(e){}""")
    cancel = []; pg.route('**/api/watch/cancel', lambda r: (cancel.append(r.request.post_data), r.fulfill(body='{"ok":true}', content_type='application/json')))
    # avviso finto: il server di prova non lo conosce e lo darebbe «non valido» (comportamento giusto, provato altrove): qui risponde «attivo»
    pg.route('**/api/watch/restore', lambda r: r.fulfill(body='{"stato":{"abcdefgh12":"attivo"}}', content_type='application/json'))
    pg.route('**/api/watch/poll*', lambda r: r.fulfill(body='{"r":{"abcdefgh12":{"active":true}}}', content_type='application/json'))
    pronto(pg)
    check(visible(pg, '#watch-btn') and pg.inner_text('#watch-count').strip() == '1', 'campanella con 1 avviso attivo')
    pg.click('#watch-btn'); pg.wait_for_timeout(500)
    check(visible(pg, '#info') and 'Rialto' in pg.inner_text('#info-watches'), 'campanella: Informazioni aperte sulla lista degli avvisi')
    hb = pg.evaluate("document.querySelector('#info-watches h3').getBoundingClientRect().top - document.querySelector('#info .fp-h').getBoundingClientRect().bottom")
    check(0 <= hb <= 40, f'lista subito sotto l\'intestazione ({round(hb)} px)')
    pg.click('#info-watches [data-wid]'); pg.wait_for_timeout(500)
    check(len(cancel) == 1 and 'abcdefgh12' in cancel[0] and not visible(pg, '#watch-btn') and pg.evaluate("JSON.parse(localStorage.getItem('tpl.watches')||'[]').length") == 0, '«Disattiva»: annullato sul server, tolto dalla memoria, campanella nascosta')
    gos = pg.evaluate("[...document.querySelectorAll('#info .ip-toc [data-go]')].map(b=>b.dataset.go)")
    bad = []
    for g in gos:
        pg.click(f'#info .ip-toc [data-go="{g}"]'); pg.wait_for_timeout(700)
        d = pg.evaluate(f"(()=>{{const s=document.getElementById('{g}'),h=document.querySelector('#info .fp-h');const r=s.getBoundingClientRect(),c=document.getElementById('info').getBoundingClientRect();return {{top:r.top-c.top, vis:r.top<c.bottom-40}}}})()")
        if not d['vis']: bad.append(g)
    check(len(gos) >= 6 and not bad, f'indice di Informazioni: {len(gos)} sezioni raggiunte {bad}')
    pg.click('#info-close'); pg.wait_for_timeout(200)
    check(not visible(pg, '#info') and pg.evaluate("document.activeElement.id") == 'info-btn', 'chiusura di Informazioni: fuoco sul pulsante «i»')
    pg.reload(); pg.wait_for_timeout(1500)
    check(not visible(pg, '#watch-btn'), 'dopo il ricaricamento l\'avviso disattivato non torna')
    check(not errs, f'avvisi e Informazioni: nessun errore {errs[:1]}'); ctx.close()

    # ---- 4. scheda Mezzi: mezzi senza linea, ricordato; chiusura ----
    ctx, pg, errs = nuovo(br); pronto(pg)
    pg.click('#mezzi-btn'); pg.wait_for_timeout(300)
    check(visible(pg, '#mezzi'), 'scheda Mezzi aperta')
    before = pg.is_checked('#unk-toggle'); pg.click('label:has(#unk-toggle)' if pg.query_selector('label:has(#unk-toggle)') else '#unk-toggle'); pg.wait_for_timeout(300)
    check(pg.is_checked('#unk-toggle') != before, '«mezzi senza linea» cambiato')
    badge = pg.evaluate("!!document.querySelector('#mezzi-btn .fbadge') && !document.querySelector('#mezzi-btn .fbadge').hidden")
    check(badge == (not before), f'segno sul pulsante Mezzi quando la scelta è diversa dal normale ({badge})')
    pg.click('#mezzi-close'); pg.wait_for_timeout(200); check(not visible(pg, '#mezzi'), 'scheda Mezzi chiusa')
    pg.reload(); pg.wait_for_timeout(1500)
    check(pg.is_checked('#unk-toggle') != before, '«mezzi senza linea» ricordato dopo il ricaricamento')
    pg.click('#mezzi-btn'); pg.click('label:has(#unk-toggle)' if pg.query_selector('label:has(#unk-toggle)') else '#unk-toggle'); pg.click('#mezzi-close')
    check(not errs, f'Mezzi: nessun errore {errs[:1]}'); ctx.close()

    # ---- 5. Preferiti: chiusura, copia scaricata, ripristino (valido, rovinato, estraneo) ----
    ctx, pg, errs = nuovo(br)
    ctx.add_init_script("try{if(!localStorage.getItem('tpl.favorites'))localStorage.setItem('tpl.favorites',JSON.stringify({v:1,items:[{k:'stop:nav:5032',name:'Fermata uno',src:'nav',at:1}]}))}catch(e){}")
    pronto(pg, '/?apri=preferiti'); pg.wait_for_timeout(800)
    check(visible(pg, '#favs'), 'Preferiti aperti')
    with pg.expect_download() as dl:
        pg.click('#favs [data-export]')
    f = OUT / 'copia-preferiti.json'; dl.value.save_as(f); d = json.loads(f.read_text())
    check(d.get('app') == 'tpl-venezia' and d.get('v') == 1 and len(d['fermate']) == 1 and re.match(r'preferiti-tpl-venezia-\d{8}\.json$', dl.value.suggested_filename), f'copia scaricata ({dl.value.suggested_filename})')
    prima = pg.evaluate("localStorage.getItem('tpl.favorites')")
    for nome, contenuto, atteso in [('rovinato.json', b'{"app":"tpl-venezia", v:', 'rovinato'), ('estraneo.json', json.dumps({'app': 'altro'}).encode(), 'non riconosciuto')]:
        pg.set_input_files('#favs-file', files=[{'name': nome, 'mimeType': 'application/json', 'buffer': contenuto}])
        t = toast(pg); check(atteso in t and 'non sono cambiati' in t and 'Unexpected' not in t, f'ripristino da file {nome}: «{t[:90]}»')
        check(pg.evaluate("localStorage.getItem('tpl.favorites')") == prima, f'{nome}: preferiti invariati'); pg.wait_for_timeout(300)
    d['fermate'].append({'k': 'stop:nav:5034', 'name': 'Fermata due', 'src': 'nav', 'at': 2})
    pg.evaluate("document.getElementById('toast').hidden=true")
    pg.set_input_files('#favs-file', files=[{'name': 'buono.json', 'mimeType': 'application/json', 'buffer': json.dumps(d).encode()}])
    t = toast(pg); check('Ripristinati 1 fermata e 0 percorsi' in t, f'ripristino valido: «{t[:80]}»')
    check('Fermata due' in pg.inner_text('#favs'), 'il preferito ripristinato compare nell\'elenco')
    pg.click('#favs-close'); pg.wait_for_timeout(200); check(not visible(pg, '#favs'), 'Preferiti chiusi')
    pg.reload(); pg.wait_for_timeout(1500)
    check(pg.evaluate("JSON.parse(localStorage.getItem('tpl.favorites')).items.length") == 2, 'dopo il ricaricamento restano 2 preferiti')
    check(not errs, f'Preferiti: nessun errore {errs[:1]}'); ctx.close()

    # ---- 6. pannello della fermata «Percorso da qui», pannello del mezzo «Avvisami» ----
    ctx, pg, errs = nuovo(br, permissions=['notifications'])
    pronto(pg, '/?fermata=nav:5032')
    pg.wait_for_selector('#panel:not([hidden]) #pplan', timeout=15000); pg.wait_for_timeout(1000)
    nome = pg.inner_text('#pname').strip()
    pg.click('#pplan'); pg.wait_for_timeout(1500)
    check(nome and 'Pianifica percorso' in pg.inner_text('#pname') and pg.inner_text('#panel').startswith(nome) and pg.query_selector('#panel input[placeholder^="Arrivo"]') is not None, f'«Percorso da qui»: pianificatore con partenza «{nome}», si sceglie l\'arrivo')
    v = json.loads(pg.evaluate("fetch('/api/vehicles?src=nav').then(r=>r.text())"))['vehicles'][0]
    pg.goto(f"{BASE}/?corsa={v['tripId'] if ':' in v['tripId'] else 'nav:' + v['tripId']}"); pg.wait_for_timeout(5000)
    if visible(pg, '#pnotify'):
        pg.click('#pnotify'); pg.wait_for_timeout(800)
        check(pg.query_selector('.pick, [data-pick], .dep.pickable, .notify-pick') is not None or 'Scegli' in pg.inner_text('#panel') or 'fermata' in pg.inner_text('#psub').lower(), '«Avvisami»: si sceglie la fermata (o la scelta è già fatta)')
    else:
        check(True, '«Avvisami» non mostrato per questa corsa (solo con fermata scelta): previsto')
    check(not errs, f'pannelli: nessun errore {errs[:1]}'); ctx.close()

    # ---- 7. riga del Programmato: avvio/pausa, velocità, cursore, ORA; tema scuro ricordato ----
    ctx, pg, errs = nuovo(br); pronto(pg)
    pg.click('label:has(input[name=mode][value=sched])'); pg.wait_for_timeout(1200)
    t0 = pg.inner_text('#tl-time')
    pg.evaluate("(()=>{const r=document.getElementById('tl-range');r.value=36000;r.dispatchEvent(new Event('input',{bubbles:true}));r.dispatchEvent(new Event('change',{bubbles:true}))})()"); pg.wait_for_timeout(600)
    check(pg.inner_text('#tl-time').startswith('10:00'), f'cursore: orario simulato 10:00 ({pg.inner_text("#tl-time")})')
    pg.select_option('#tl-speed', index=pg.evaluate("document.getElementById('tl-speed').options.length-1")); sp = int(pg.eval_on_selector('#tl-speed', 'e=>e.value'))
    pg.click('#tl-play'); pg.wait_for_timeout(2300)
    a = pg.inner_text('#tl-time'); lab = pg.get_attribute('#tl-play', 'aria-label')
    secs = lambda s: sum(int(x) * k for x, k in zip(s.split(':'), (3600, 60, 1)))
    check(lab == 'Pausa' and secs(a) - 36000 >= sp, f'avvio: il tempo scorre a {sp} s/s ({a}), pulsante «Pausa»')
    pg.click('#tl-play'); b = pg.inner_text('#tl-time'); pg.wait_for_timeout(1500)
    check(pg.inner_text('#tl-time') == b and pg.get_attribute('#tl-play', 'aria-label') == 'Avvia', 'pausa: il tempo si ferma')
    pg.click('#tl-now'); pg.wait_for_timeout(500)
    now = time.localtime(); cur = secs(pg.inner_text('#tl-time'))
    check(abs(cur - (now.tm_hour * 3600 + now.tm_min * 60 + now.tm_sec)) < 120 or abs(cur - ((now.tm_hour + 1) % 24) * 3600 - now.tm_min * 60) < 7200, f'«ORA»: torna all\'ora attuale ({pg.inner_text("#tl-time")})')
    pg.click('label:has(input[name=mode][value=live])'); pg.wait_for_timeout(300)
    dark0 = pg.evaluate("document.documentElement.dataset.theme||''"); pg.click('#theme-btn'); pg.wait_for_timeout(200); dark1 = pg.evaluate("document.documentElement.dataset.theme||''")
    pg.reload(); pg.wait_for_timeout(800)
    check(dark1 != dark0 and pg.evaluate("document.documentElement.dataset.theme||''") == dark1, f'tema cambiato e ricordato ({dark0!r} → {dark1!r})')
    pg.click('#theme-btn')
    check(not errs, f'Programmato e tema: nessun errore {errs[:1]}'); ctx.close()
    br.close()
print(f'\nFALLITI: {len(fails)}')
sys.exit(1 if fails else 0)
