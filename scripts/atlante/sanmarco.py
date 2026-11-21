# San Marco 2023: mappa raster (21 tessere per pagina) con i percorsi disegnati a colori; colori dalla legenda della pagina successiva
import sys, json, re, math; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from georef import *
from atlante_util import *
PDF = os.path.join(os.environ.get('ATLANTE_PDF', 'dati-passerelle'), '1_sanmarco_20230417.pdf')
doc = fitz.open(PDF); Z = 3.0; out = []
def legenda(page):            # «Percorso X» -> colore del pallino accanto (riempimenti circolari)
    dots = [(d['fill'], d['rect']) for d in page.get_drawings() if d.get('fill') and d['rect'].width < 14 and abs(d['rect'].width - d['rect'].height) < 2]
    res = {}
    for b in page.get_text('blocks'):
        m = re.match(r'^\s*Percorso\s+([A-G])\b', b[4])
        if not m or not dots: continue
        c = min(dots, key=lambda d: math.dist((b[0], b[1]), (d[1].x0, d[1].y0)))
        if math.dist((b[0], b[1]), (c[1].x0, c[1].y0)) < 120: res[m.group(1)] = tuple(int(255 * v) for v in c[0])
    return res
def card_text(page): return ' '.join(b[4].replace('\n', ' ') for b in page.get_text('blocks'))
SOLO = sys.argv[1:] 
for pn in range(1, len(doc) - 1):
    page = doc[pn]; tt = card_text(page)
    mt = re.search(r'tavola\s*n?°?\s*1\.(\d+)', tt)
    if not mt or 'TAVOLE' in tt or 'lunghezza' in tt.lower() or 'descrizione tavole' in tt: continue
    tav = f'1.{mt.group(1)}'; leg = legenda(doc[pn + 1])
    if SOLO and tav not in SOLO: continue
    pix = page.get_pixmap(matrix=fitz.Matrix(Z, Z), alpha=False)
    img = np.frombuffer(pix.samples, np.uint8).reshape(pix.h, pix.w, 3).copy()
    hsv = cv2.cvtColor(img, cv2.COLOR_RGB2HSV)
    # curve: rosso scuro/bruno sottile (non i colori pieni dei percorsi)
    mk = ((((hsv[..., 0] < 12) | (hsv[..., 0] > 168)) & (hsv[..., 1] > 60) & (hsv[..., 2] > 50) & (hsv[..., 2] < 215))).astype(np.float32)
    mk[:int(40 * Z), :] = 0
    ids = [k for k in PRJ if re.fullmatch(r'T' + re.escape(tav) + r'[A-G]', k)]
    pts = [T2.transform(lo, la) for k in ids for la, lo in PRJ[k]['pts']]
    g = (float(np.mean([a for a, b in pts])), float(np.mean([b for a, b in pts])))
    cand = []
    for nome, m in (('scure', mk), ('colorate', pdf_mask(img) * (np.arange(img.shape[0])[:, None] > 40 * Z))):
        rr = registra(img, g, mk=m.astype(np.float32), scale=(0.07, 0.5), raggio=600); rr['maschera'] = nome; cand.append(rr)
    r = max(cand, key=lambda x: x['score'] - x['secondo'])
    rec = {'pdf': '1_sanmarco_20230417.pdf', 'pagina': pn + 1, 'tavola': tav, 'georef': r, 'legenda': leg, 'percorsi': []}
    overlay(img, r, os.environ.get('ATLANTE_OUT', 'tmp-atlante') + f'/ov_{tav}.png')
    for lab, col in leg.items():
        dcol = np.linalg.norm(img.astype(np.int16) - np.array(col, np.int16), axis=2)
        rm = (dcol < 45).astype(np.uint8); rm[:int(40 * Z), :] = 0
        rm = cv2.morphologyEx(rm, cv2.MORPH_OPEN, np.ones((2, 2), np.uint8))
        n, lab_img, stats, _ = cv2.connectedComponentsWithStats(rm)
        keep = np.zeros_like(rm)
        for i in range(1, n):
            x, y, w, h, a = stats[i]
            if a >= 40 and max(w, h) >= 25: keep[lab_img == i] = 1     # tratti lunghi (non pallini, non testo)
        segs = segmenti(keep)
        geo = lambda p: (r['E0'] + p[0] * r['mpp'], r['N0'] - p[1] * r['mpp'])
        gp = [[geo(p) for p in s[::3] + [s[-1]]] for s in segs]
        o = {'id': f'T{tav}{lab}', 'colore': col, 'px': int(keep.sum()), 'segmenti': len(gp), 'm_tavola': round(sum(mlen(s) for s in gp), 1),
             'g': [[[round(v, 6) for v in T4.transform(E, N)[::-1]] for E, N in s] for s in gp]}
        rec['percorsi'].append(o)
    out.append(rec); print(tav, r, [(o['id'], o['m_tavola'], o['segmenti']) for o in rec['percorsi']], flush=True)
json.dump(out, open(os.path.join(os.environ.get('ATLANTE_OUT', 'tmp-atlante'), 'sanmarco.json'), 'w'))
