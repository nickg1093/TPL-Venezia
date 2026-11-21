# Analisi delle tavole dell'Atlante passerelle: georeferenziazione (curve RAMSES) e tracciati vettoriali dei percorsi
import sys, json, re, glob, os, math; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from georef import *
from scipy.optimize import linear_sum_assignment
DIR = os.environ.get('ATLANTE_PDF', 'dati-passerelle')
def mlen(g): return sum(math.dist(g[i-1], g[i]) for i in range(1, len(g)))
def polylines(dr):
    out, cur = [], []
    for it in dr['items']:
        if it[0] == 'l': a, b = it[1], it[2]
        elif it[0] == 'c': a, b = it[1], it[4]
        else: continue
        if cur and math.dist(cur[-1], (a.x, a.y)) < 0.5: cur.append((b.x, b.y))
        else:
            if len(cur) > 1: out.append(cur)
            cur = [(a.x, a.y), (b.x, b.y)]
    if len(cur) > 1: out.append(cur)
    return out
def refine(img, r, guess, mk=None):
    best = r; mk = pdf_mask(img) if mk is None else mk; h, w = mk.shape
    for f in np.linspace(0.95, 1.05, 21):
        mpp_img = r['mpp'] * f; tw, th = int(w * mpp_img), int(h * mpp_img)
        tpl = cv2.GaussianBlur(cv2.resize(mk, (tw, th), interpolation=cv2.INTER_AREA), (0, 0), 2)
        gx, gy = r['E0'] + tw / 2, r['N0'] - th / 2
        ref, ox, oy = ramses_mask(gx - tw / 2 - 30, gy - th / 2 - 30, gx + tw / 2 + 30, gy + th / 2 + 30, 1.0)
        if ref.shape[0] <= th or ref.shape[1] <= tw: continue
        ref = cv2.GaussianBlur(ref, (0, 0), 2) + np.random.default_rng(0).random(ref.shape, dtype=np.float32) * 1e-3
        res = cv2.matchTemplate(ref, tpl, cv2.TM_CCOEFF_NORMED); _, mv, _, ml = cv2.minMaxLoc(res)
        # sotto-pixel: parabola sul picco
        x, y = ml; dx = dy = 0.0
        if 0 < x < res.shape[1] - 1: a, b, c = res[y, x - 1], res[y, x], res[y, x + 1]; dx = 0.5 * (a - c) / (a - 2 * b + c) if (a - 2 * b + c) else 0
        if 0 < y < res.shape[0] - 1: a, b, c = res[y - 1, x], res[y, x], res[y + 1, x]; dy = 0.5 * (a - c) / (a - 2 * b + c) if (a - 2 * b + c) else 0
        if mv > best['score']: best = {**r, 'score': round(float(mv), 3), 'mpp': float(mpp_img), 'E0': float(ox + x + dx), 'N0': float(oy - y - dy)}
    return best
risultati = []
for f in sorted(glob.glob(DIR + '/[2-9]_*.pdf') + glob.glob(DIR + '/10_*.pdf'), key=lambda s: int(os.path.basename(s).split('_')[0])):
    doc = fitz.open(f)
    for pn, page in enumerate(doc):
        dr = [d for d in page.get_drawings() if d.get('color') and (d.get('width') or 0) >= 3]
        title = ' '.join(s['text'] for b in page.get_text('dict')['blocks'] for l in b.get('lines', []) for s in l['spans'])
        mt = re.search(r'tavola\s*n?°?\s*(\d+)\s*\.\s*(\d+)', title)
        labels = [(re.sub(r'\s+', ' ', w[4]).strip(), w[:4]) for w in page.get_text('blocks') if re.match(r'^\s*Percorso\s+[A-G]\s*$', w[4])]
        if not dr or not mt or not labels: continue
        tav = f'{mt.group(1)}.{mt.group(2)}'
        infos = sorted(page.get_image_info(xrefs=True), key=lambda i: -(i['bbox'][2]-i['bbox'][0])*(i['bbox'][3]-i['bbox'][1]))
        im = infos[0]; pix = fitz.Pixmap(doc, im['xref']); pix = fitz.Pixmap(fitz.csRGB, pix) if pix.n > 3 or pix.alpha else pix
        img = np.frombuffer(pix.samples, np.uint8).reshape(pix.h, pix.w, pix.n)[..., :3].copy()
        ids = [k for k in PRJ if k.startswith('T' + tav) and len(k) == len('T' + tav) + 1]
        pts = [T2.transform(lo, la) for k in ids for la, lo in PRJ[k]['pts']]
        rec = {'pdf': os.path.basename(f), 'pagina': pn + 1, 'tavola': tav, 'img': [pix.w, pix.h], 'curve_px': round(float(pdf_mask(img).mean()), 4)}
        if pts: gxy = (float(np.mean([a for a, b in pts])), float(np.mean([b for a, b in pts])))
        if not pts or rec['curve_px'] < 0.01 or not dentro(gxy): rec['georef'] = None
        else:
            g = (float(np.mean([a for a, b in pts])), float(np.mean([b for a, b in pts])))
            r = registra(img, g); r = refine(img, r, g); rec['georef'] = r
            overlay(img, r, os.environ.get('ATLANTE_OUT', 'tmp-atlante') + f"/ov_{tav}.png")
        # colori dei tracciati e assegnazione alle etichette (minima distanza complessiva)
        per = {}
        for d in dr:
            c = tuple(round(x, 2) for x in d['color'])
            if c in ((1.0, 1.0, 1.0),): continue
            per.setdefault(c, []).extend(polylines(d))
        cols = list(per); L = [l for l, _ in labels]
        cost = np.array([[min(math.dist(((bx0 + bx1) / 2, (by0 + by1) / 2), p) for pl in per[c] for p in pl) for (_, (bx0, by0, bx1, by1)) in labels] for c in cols])
        ri, ci = linear_sum_assignment(cost)
        T = im['transform']; a_, d_, e_, f_ = T[0], T[3], T[4], T[5]
        def geo(p):
            ix = (p[0] - e_) / a_ * pix.w; iy = (p[1] - f_) / d_ * pix.h
            E = rec['georef']['E0'] + ix * rec['georef']['mpp']; N = rec['georef']['N0'] - iy * rec['georef']['mpp']
            return E, N
        rec['percorsi'] = []
        for i, j in zip(ri, ci):
            lab = L[j].split()[-1]; c = cols[i]; pls = per[c]
            o = {'id': f'T{tav}{lab}', 'colore': c, 'dist_etichetta_pt': round(float(cost[i, j]), 1), 'segmenti': len(pls)}
            if rec['georef']:
                gp = [[geo(p) for p in pl] for pl in pls]
                o['m_tavola'] = round(sum(mlen(pl) for pl in gp), 1)
                o['g'] = [[[round(v, 6) for v in T4.transform(E, N)[::-1]] for E, N in pl] for pl in gp]
            rec['percorsi'].append(o)
        rec['non_assegnati'] = [str(cols[i]) for i in range(len(cols)) if i not in ri]
        risultati.append(rec); print(tav, rec.get('georef'), [(o['id'], o.get('m_tavola')) for o in rec['percorsi']], rec['non_assegnati'], flush=True)
json.dump(risultati, open(os.path.join(os.environ.get('ATLANTE_OUT', 'tmp-atlante'), 'atlante.json'), 'w'))
