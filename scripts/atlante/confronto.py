import json, math, re, numpy as np
import os
from pyproj import Transformer
T2 = Transformer.from_crs(4326, 3004, always_xy=True)
at = json.load(open('data/acqua/passerelle-atlante.json'))
UFF = {p['id'].replace(' ', ''): p['metri'] for p in at['percorsi']}
SM23 = {'T1.1A': (30, 90), 'T1.1B': (120, 85), 'T1.1C': (36, 90), 'T1.1D': (12, 90), 'T1.1E': (48, 80), 'T1.1F': (24, 65), 'T1.1G': (12, 100),
        'T1.2A': (32, 95), 'T1.2B': (105, 110), 'T1.2C': (16, 100), 'T1.3A': (112, 110), 'T1.3B': (32, 100), 'T1.3C': (48, 105), 'T1.4A': (40, 100),
        'T1.5A': (8, 110), 'T1.6A': (92, 95), 'T1.7A': (124, 105), 'T1.7B': (72, 110), 'T1.7C': (232, 105), 'T1.7D': (8, 100), 'T1.8A': (9, 100),
        'T1.9A': (32, 105), 'T1.9B': (40, 90), 'T1.9C': (28, 115), 'T1.9D': (12, 110), 'T1.10A': (128, 95), 'T1.11A': (96, 105), 'T1.11B': (80, 100)}
PRJ = {p['id']: p for p in json.load(open(os.path.join(os.environ.get('ATLANTE_OUT', 'tmp-atlante'), 'progetto.json')))}
def xy(g): return [T2.transform(lo, la) for la, lo in g]
def dense(pl, step=2):
    out = []
    for a, b in zip(pl, pl[1:]):
        n = max(1, int(math.dist(a, b) / step))
        out += [(a[0] + (b[0] - a[0]) * k / n, a[1] + (b[1] - a[1]) * k / n) for k in range(n)]
    return out + [pl[-1]]
def dseg(p, a, b):
    ax, ay = b[0] - a[0], b[1] - a[1]; L = ax * ax + ay * ay; t = 0 if L == 0 else max(0, min(1, ((p[0] - a[0]) * ax + (p[1] - a[1]) * ay) / L))
    return math.hypot(p[0] - a[0] - t * ax, p[1] - a[1] - t * ay)
def dpl(p, pls): return min(dseg(p, a, b) for pl in pls for a, b in zip(pl, pl[1:]))
righe = []
for file in ('atlante.json', 'sanmarco.json'):
    for rec in json.load(open(os.environ.get('ATLANTE_OUT', 'tmp-atlante') + '/' + file)):
        G = rec.get('georef'); okg = bool(G) and G['score'] >= 0.6 and G['score'] - G['secondo'] >= 0.12
        for o in rec['percorsi']:
            uff = SM23.get(o['id'], (None,))[0] if file == 'sanmarco.json' else UFF.get(o['id'])
            r = {'id': o['id'], 'fonte': f"{rec['pdf']} p.{rec['pagina']}", 'georef': None if not G else {'score': G['score'], 'secondo': G['secondo'], 'mpp': round(G['mpp'], 4)}, 'georef_ok': okg,
                 'm_uff': uff, 'm_tavola': o.get('m_tavola')}
            if okg and o.get('g') and o.get('m_tavola'):
                pls = [xy(s) for s in o['g'] if len(s) > 1]
                r['lung_ok'] = uff is not None and abs(o['m_tavola'] - uff) <= max(8, 0.25 * uff)
                if o['id'] in PRJ:
                    pp = xy(PRJ[o['id']]['pts'])
                    d1 = [dpl(p, [pp]) for pl in pls for p in dense(pl)]; d2 = [dpl(p, pls) for p in dense(pp)]
                    r['dist_media'] = round(float(np.mean(d1)), 1); r['hausdorff'] = round(max(max(d1), max(d2)), 1)
                r['g'] = o['g']
            righe.append(r)
json.dump(righe, open(os.path.join(os.environ.get('ATLANTE_OUT', 'tmp-atlante'), 'confronto.json'), 'w'))
for r in righe:
    print(f"{r['id']:8} {('georef %.2f/%.2f' % (r['georef']['score'], r['georef']['secondo'])) if r['georef'] else 'no georef':18} ok={str(r['georef_ok'])[0]} uff={r['m_uff']} tav={r['m_tavola']} lung_ok={str(r.get('lung_ok','-'))[0]} media={r.get('dist_media','-')} haus={r.get('hausdorff','-')}")
