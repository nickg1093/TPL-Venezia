# PROVE DELLA v33.5 (Playwright + Chromium), con il server avviato sul feed simulato (come run.py):
#   1) pannello di un mezzo in tempo reale: «Posizione aggiornata N secondi/minuti fa» dall'ora del MEZZO, contata di nuovo ogni secondo;
#      per il mezzo che non la trasmette (V11 nel feed simulato) «Ora della posizione non trasmessa dal mezzo»; niente in «Programmato»;
#   2) pianificatore: «Modifica» su Percorsi recenti e Percorsi salvati (cambia arrivo, inverti, nome, salva modifiche / salva come nuovo,
#      doppioni rifiutati, elimina), memoria del dispositivo dopo la riapertura, tasto «indietro»;
#   3) Informazioni: collegamento a Instagram; schermo intero: scelta, memoria e rientro al tocco; nessun elemento tagliato dopo il cambio di dimensione.
# Uso: python3 tests/ui/modifica.py [http://localhost:3111]   (anche TESTO=1.3)
import sys, os, re, json, pathlib
from playwright.sync_api import sync_playwright
BASE = sys.argv[1] if len(sys.argv) > 1 else 'http://localhost:3111'
STUB = (pathlib.Path(__file__).parent / 'leaflet-stub.js').read_text()
TESTO = os.environ.get('TESTO', '')
TESTO_JS = f"try{{localStorage.setItem('tpl.testo','{TESTO}')}}catch(e){{}}" if TESTO in ('1.15', '1.3') else "0"
GUIDE_OFF = "try{localStorage.setItem('tpl.guida', JSON.stringify({v:'v33.12', mappa:true, pannello:true}))}catch(e){}"
SIZES = [('phone', 390, 844), ('phone-small', 360, 640), ('landscape', 844, 390), ('desktop', 1440, 900)]
fails = []
def check(ok, msg):
    print(('  ok   ' if ok else '  FAIL ') + msg)
    if not ok: fails.append(msg)
def inview(page, sel):   # tutti gli elementi visibili dentro la finestra (niente di tagliato)
    return page.evaluate("""s=>[...document.querySelectorAll(s)].filter(e=>e.offsetParent).every(e=>{const r=e.getBoundingClientRect();return r.left>=-1&&r.right<=innerWidth+1&&r.width>0})""", sel)
# un percorso recente e due salvati, con punti sulla mappa (validi per entrambe le memorie)
P = lambda lab, lat, lon: {'kind': 'point', 'label': lab, 'lat': lat, 'lon': lon}
A, B, C, D = P('Punto A', 45.4380, 12.3200), P('Punto B', 45.4340, 12.3390), P('Punto C', 45.4300, 12.3300), P('Punto D', 45.4410, 12.3260)
key = lambda e: f"pt:{e['lat']:.4f},{e['lon']:.4f}"
SEED = ("try{if(!sessionStorage.getItem('seeded')){sessionStorage.setItem('seeded','1');"
        f"localStorage.setItem('tpl.percorso', JSON.stringify({{v:2,recenti:[{{from:{json.dumps(A)},to:{json.dumps(B)},at:1}}]}}));"
        f"localStorage.setItem('tpl.percorsi', JSON.stringify({{v:1,items:[{{k:'{key(C)}>{key(D)}',from:{json.dumps(C)},to:{json.dumps(D)},at:2,name:'Casa'}},{{k:'{key(A)}>{key(D)}',from:{json.dumps(A)},to:{json.dumps(D)},at:3}}]}}));"
        "}}catch(e){}")

with sync_playwright() as p:
    br = p.chromium.launch()
    for name, w, h in SIZES:
        print(f'== {name} {w}x{h}{" TESTO=" + TESTO if TESTO else ""}')
        ctx = br.new_context(viewport={'width': w, 'height': h}, has_touch=name.startswith('phone'), extra_http_headers={'X-Forwarded-For': f'10.7.{w % 250}.{h % 250}'}, service_workers='block')
        for s in (GUIDE_OFF, TESTO_JS, SEED): ctx.add_init_script(s)
        page = ctx.new_page(); errs = []
        page.on('pageerror', lambda e: errs.append(str(e)))
        page.route('**/vendor/leaflet/leaflet.js', lambda r: r.fulfill(body=STUB, content_type='application/javascript'))
        page.route('**/vendor/leaflet/leaflet.css', lambda r: r.fulfill(body='', content_type='text/css'))
        page.route('https://tile.openstreetmap.org/**', lambda r: r.abort())
        page.goto(BASE); page.wait_for_selector('.bus-marker', timeout=20000); page.wait_for_timeout(1500)

        # ---- 1) ULTIMO AGGIORNAMENTO DEL MEZZO ----
        n = page.evaluate("document.querySelectorAll('.leaflet-marker-icon.bus-marker').length")
        seen_ok = seen_nots = False
        for i in range(n):
            page.evaluate(f"(()=>{{const m=[...document.querySelectorAll('.leaflet-marker-icon.bus-marker')][{i}];if(m&&!m.querySelector('.bus.idle, .bus.unk'))m.click()}})()")
            try: page.wait_for_selector('#panel:not([hidden]) .tl', timeout=2500)
            except Exception: continue
            page.wait_for_timeout(250)
            vn = page.inner_text('#pstatus') if page.query_selector('#pstatus') else ''
            up = page.query_selector('#psub .vupd')
            if '4011' in vn:
                check(up is not None and 'non trasmessa' in up.inner_text() and 'aggiornata' not in up.inner_text(), 'mezzo senza ora del rilevamento (V11): «Ora della posizione non trasmessa dal mezzo»'); seen_nots = True
            elif not seen_ok and up and 'non trasmessa' not in up.inner_text():
                t = up.inner_text()
                check(re.search(r'^Posizione aggiornata (\d+ second[oi] fa|\d+ minut[oi] fa|più di un\'ora fa)', t) is not None and 'alle' not in t, f'tempo dall\'ultimo rilevamento del mezzo: «{t}»')
                vals = {t}
                for _ in range(5):
                    page.wait_for_timeout(700); vals.add(page.inner_text('#psub .vupd') if page.query_selector('#psub .vupd') else '')
                check(len(vals) > 1 or 'minut' in t or 'ora' in t, f'il tempo si aggiorna da solo (ogni secondo): {sorted(vals)}')
                r = page.evaluate("(()=>{const e=document.querySelector('#psub .vupd');const b=e.getBoundingClientRect(),p=document.getElementById('panel').getBoundingClientRect();return b.left>=p.left-1&&b.right<=p.right+1&&b.width>0})()")
                check(r, 'riga dell\'aggiornamento dentro il pannello'); seen_ok = True
            if seen_ok and seen_nots: break
        check(seen_ok, 'trovato un mezzo con l\'ora del rilevamento')
        check(seen_nots, 'trovato il mezzo simulato senza ora del rilevamento (V11)')
        page.keyboard.press('Escape'); page.wait_for_timeout(300)
        # programmato: nessuna indicazione
        page.evaluate("(()=>{const r=document.querySelector('input[name=mode][value=sched]');r.checked=true;r.dispatchEvent(new Event('change',{bubbles:true}))})()")
        page.wait_for_selector('.bus-marker', timeout=20000); page.wait_for_timeout(1200)
        page.evaluate("[...document.querySelectorAll('.leaflet-marker-icon.bus-marker')][0]?.click()")
        try:
            page.wait_for_selector('#panel:not([hidden]) .tl', timeout=6000); page.wait_for_timeout(300)
            check(page.query_selector('#psub .vupd') is None, '«Programmato»: nessuna ora di aggiornamento del mezzo')
        except Exception: check(False, 'pannello di una corsa in «Programmato»')
        page.keyboard.press('Escape'); page.wait_for_timeout(200)
        page.evaluate("(()=>{const r=document.querySelector('input[name=mode][value=live]');r.checked=true;r.dispatchEvent(new Event('change',{bubbles:true}))})()")
        page.wait_for_timeout(800)

        # ---- 2) MODIFICA DEI PERCORSI RECENTI E SALVATI ----
        page.click('#plan-btn'); page.wait_for_selector('.pp-sugs', timeout=6000)
        cats = page.eval_on_selector_all('.pp-cat', 'e=>e.map(x=>x.innerText)')
        check(any('recenti' in c.lower() for c in cats) and any('salvati' in c.lower() for c in cats), f'sezioni con «Modifica»: {cats}')
        check(inview(page, '.pp-cat .nlink'), '«Modifica» visibile e non tagliato')
        # salvati: modifica -> arrivo nuovo da ricerca, nome, salva modifiche (stessa posizione, niente voci nuove)
        page.click('[data-lst="route"]'); page.wait_for_selector('[data-ded="route"]')
        check(inview(page, '.pp-erow .fv-acts .ibtn'), 'comandi di modifica (modifica, su, giù, elimina) dentro lo schermo')
        page.click('[data-ded="route"]'); page.wait_for_selector('.pp-draft')
        check(page.input_value('.pp-dn') == 'Casa', 'scheda di modifica: nome attuale')
        check(inview(page, '.pp-dacts .pp-act'), 'pulsanti della scheda dentro lo schermo')
        page.click('[data-df="to"]'); page.wait_for_selector('.pp-q')
        check('Nuovo arrivo' in (page.get_attribute('.pp-q', 'placeholder') or ''), 'ricerca del nuovo arrivo')
        page.fill('.pp-q', 'Rialto'); page.wait_for_timeout(300)
        page.click('.pp-sug[data-s="zone"], .pp-sug[data-s="stop"]'); page.wait_for_selector('.pp-draft')
        to_lab = page.inner_text('[data-df="to"] .pp-v')
        check('Rialto' in to_lab, f'arrivo cambiato nella bozza ({to_lab})')
        check(len(json.loads(page.evaluate("localStorage.getItem('tpl.percorsi')"))['items']) == 2 and 'Punto D' in page.evaluate("localStorage.getItem('tpl.percorsi')"), 'bozza: memoria non ancora toccata')
        page.fill('.pp-dn', 'Casa → Rialto'); page.click('[data-dsave]'); page.wait_for_timeout(300)
        it = json.loads(page.evaluate("localStorage.getItem('tpl.percorsi')"))['items']
        check(len(it) == 2 and it[0]['name'] == 'Casa → Rialto' and 'Rialto' in it[0]['to']['label'] and it[0]['from']['label'] == 'Punto C' and it[0]['at'] == 2, f'salva modifiche: stessa voce, stessa posizione ({[x.get("name") or x["to"]["label"] for x in it]})')
        # salva come nuovo con lo stesso percorso di un altro salvato: rifiutato, niente doppioni
        page.click(f'[data-ded="route"][data-k="{key(A)}>{key(D)}"]'); page.wait_for_selector('.pp-draft')
        page.click('[data-df="to"]'); page.fill('.pp-q', 'Rialto'); page.wait_for_timeout(300); page.click('.pp-sug[data-s="zone"], .pp-sug[data-s="stop"]'); page.wait_for_selector('.pp-draft')
        page.click('[data-df="from"]'); page.wait_for_selector('.pp-q'); page.click('.pp-qback'); page.wait_for_timeout(300)
        check(page.query_selector('.pp-draft') is not None and 'Punto A' in page.inner_text('[data-df="from"] .pp-v'), '«annulla» dalla ricerca torna alla scheda di modifica, partenza invariata')
        page.click('.pp-dswap'); page.wait_for_timeout(150)
        check('Rialto' in page.inner_text('[data-df="from"] .pp-v'), 'inverti partenza e arrivo nella bozza')
        page.click('.pp-dswap'); page.wait_for_timeout(150)
        page.click('[data-dnew]'); page.wait_for_timeout(300)
        it = json.loads(page.evaluate("localStorage.getItem('tpl.percorsi')"))['items']
        check(len(it) == 3, f'salva come nuovo: voce nuova, l\'originale resta ({len(it)} salvati)')
        page.wait_for_selector('.pp-sugs'); page.click(f'[data-ded="route"][data-k="{key(A)}>{key(D)}"]'); page.wait_for_selector('.pp-draft')
        page.click('[data-df="to"]'); page.fill('.pp-q', 'Rialto'); page.wait_for_timeout(300); page.click('.pp-sug[data-s="zone"], .pp-sug[data-s="stop"]'); page.wait_for_selector('.pp-draft')
        page.click('[data-dsave]'); page.wait_for_timeout(300)
        it2 = json.loads(page.evaluate("localStorage.getItem('tpl.percorsi')"))['items']
        check(len(it2) == 3 and page.query_selector('.pp-draft') is not None, 'modifica che duplicherebbe un altro salvato: rifiutata, la scheda resta aperta')
        page.click('[data-dcancel]'); page.wait_for_selector('.pp-sugs')
        # recenti: modifica + aggiungi ai salvati, poi elimina
        page.click('[data-lst="recent"]'); page.wait_for_selector('[data-ded="recent"]')
        page.click('[data-ded="recent"]'); page.wait_for_selector('.pp-draft')
        check(page.query_selector('.pp-dn') is None, 'recente: senza nome (non lo prevede)')
        page.click('.pp-dswap'); page.click('[data-dsave]'); page.wait_for_timeout(300)
        rc = json.loads(page.evaluate("localStorage.getItem('tpl.percorso')"))['recenti']
        check(len(rc) == 1 and rc[0]['from']['label'] == 'Punto B' and rc[0]['to']['label'] == 'Punto A', 'recente modificato al suo posto (invertito)')
        page.click('[data-lst="recent"]') if page.query_selector('[data-lst="recent"][aria-pressed="false"]') else None
        page.wait_for_selector('[data-ddel="recent"]'); page.click('[data-ddel="recent"]'); page.wait_for_timeout(250)
        check(json.loads(page.evaluate("localStorage.getItem('tpl.percorso')"))['recenti'] == [], 'recente eliminato')
        check(not errs, 'nessun errore in pagina ' + str(errs[:2]))
        # memoria dopo la riapertura (seme solo alla prima apertura della sessione)
        page.reload(); page.wait_for_selector('.bus-marker', timeout=20000); page.click('#plan-btn'); page.wait_for_selector('.pp-sugs')
        txt = page.inner_text('.pp-sugs')
        check('Casa → Rialto' in txt and 'Percorsi recenti' not in txt, 'dopo la riapertura: modifiche conservate')
        # «indietro» del sistema: dalla scheda di modifica si torna agli elenchi
        page.click('[data-lst="route"]'); page.click('[data-ded="route"]'); page.wait_for_selector('.pp-draft'); page.wait_for_timeout(200)
        page.go_back(); page.wait_for_timeout(500)
        check(page.query_selector('.pp-draft') is None and page.query_selector('.pp-sugs') is not None, '«indietro»: chiude la scheda di modifica senza salvare')

        # ---- 3) SCHERMO INTERO ----
        page.keyboard.press('Escape'); page.wait_for_timeout(200); page.keyboard.press('Escape'); page.wait_for_timeout(200)
        page.click('#info-btn'); page.wait_for_selector('#info:not([hidden])', timeout=5000)
        ig = page.evaluate("""(()=>{const a=document.querySelector('#info .ip-hero a.ip-social');if(!a)return null;a.scrollIntoView({block:'center'});const u=a.querySelector('use').getBBox(),r=a.getBoundingClientRect();return {h:a.href,t:a.target,rel:a.rel,w:u.width,ah:r.height,in:r.left>=0&&r.right<=innerWidth+1}})()""")
        check(ig and ig['h'] == 'https://www.instagram.com/olocin_g/' and ig['t'] == '_blank' and 'noopener' in ig['rel'] and 'noreferrer' in ig['rel'], f'Informazioni: collegamento a Instagram @olocin_g {ig}')
        check(ig and ig['w'] > 0 and ig['ah'] >= 44 and ig['in'], 'icona di Instagram disegnata, area tattile ≥ 44 px, dentro lo schermo')
        vis = page.evaluate("!document.getElementById('ip-fs').hidden")
        check(vis, 'Informazioni: scelta «Schermo intero» dove il sistema lo permette')
        if vis:
            page.evaluate("document.getElementById('ip-fs').scrollIntoView({block:'center'})")
            page.click('[data-fs="1"]'); page.wait_for_timeout(700)
            check(page.evaluate("!!document.fullscreenElement"), 'schermo intero attivo')
            check(page.evaluate("localStorage.getItem('tpl.schermo')") == '1', 'scelta salvata')
            check(page.get_attribute('[data-fs="1"]', 'aria-checked') == 'true', 'scelta segnata')
            page.evaluate("document.exitFullscreen()"); page.wait_for_timeout(500)
            page.mouse.click(5, h // 2)
            page.wait_for_timeout(700)
            check(page.evaluate("!!document.fullscreenElement"), 'uscita dal sistema («indietro»): si rientra al tocco successivo')
            page.keyboard.press('Escape'); page.wait_for_timeout(400)
            inn = "['plan-btn','locate','favs-btn','theme-btn'].filter(i=>{const e=document.getElementById(i);if(!e||!e.offsetParent)return false;const r=e.getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight+1&&r.left>=0&&r.right<=innerWidth+1})"
            a_fs = page.evaluate(inn); page.evaluate("document.exitFullscreen()"); page.wait_for_timeout(600); a_no = page.evaluate(inn)
            check(set(a_no) <= set(a_fs) and 'plan-btn' in a_fs, f'a schermo intero restano dentro lo schermo gli stessi comandi ({a_fs} / {a_no})')
            page.mouse.click(5, h // 2); page.wait_for_timeout(700)
            page.reload(); page.wait_for_selector('.bus-marker', timeout=20000); page.wait_for_timeout(500)
            check(page.evaluate("!document.fullscreenElement"), 'riapertura: il sistema richiede un tocco prima di entrare')
            page.mouse.click(5, h // 2); page.wait_for_timeout(700)
            check(page.evaluate("!!document.fullscreenElement"), 'riapertura: schermo intero al primo tocco')
            page.click('#info-btn'); page.wait_for_selector('#info:not([hidden])'); page.evaluate("document.getElementById('ip-fs').scrollIntoView({block:'center'})")
            page.click('[data-fs="0"]'); page.wait_for_timeout(600)
            check(page.evaluate("!document.fullscreenElement && !localStorage.getItem('tpl.schermo')"), 'scelta «Con le barre»: esce e non rientra')
            page.mouse.click(5, h // 2); page.wait_for_timeout(500)
            check(page.evaluate("!document.fullscreenElement"), 'con le barre: un tocco non riattiva lo schermo intero')
        check(not errs, 'nessun errore in pagina (fine) ' + str(errs[:2]))
        ctx.close()
    br.close()
print(f'\n{"TUTTO OK" if not fails else str(len(fails)) + " FALLITI"}')
sys.exit(1 if fails else 0)
