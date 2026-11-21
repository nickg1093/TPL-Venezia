import json, sys, math, numpy as np, cv2; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from georef import ramses_mask, T2, PRJ
C = json.load(open(os.path.join(os.environ.get('ATLANTE_OUT', 'tmp-atlante'), 'confronto.json')))
def tile(tav):
    rs = [r for r in C if r['id'][1:-1] == tav and r.get('g')]
    pts = [T2.transform(lo, la) for r in rs for s in r['g'] for la, lo in s] + [T2.transform(lo, la) for r in rs if r['id'] in PRJ for la, lo in PRJ[r['id']]['pts']]
    if not pts: return None
    xs, ys = zip(*pts); m = 25; x0, x1, y0, y1 = min(xs) - m, max(xs) + m, min(ys) - m, max(ys) + m
    mpp = max((x1 - x0) / 560, (y1 - y0) / 400, 0.25)
    ref, ox, oy = ramses_mask(x0, y0, x1, y1, mpp); img = np.full(ref.shape + (3,), 255, np.uint8); img[ref > 0.05] = (205, 205, 205)
    P = lambda la, lo: (lambda E, N: (int((E - ox) / mpp), int((oy - N) / mpp)))(*T2.transform(lo, la))
    cols = [(230, 40, 40), (40, 160, 40), (40, 80, 230), (220, 140, 0), (170, 40, 170), (0, 160, 170), (120, 90, 40)]
    for i, r in enumerate(sorted(rs, key=lambda r: r['id'])):
        c = cols[i % len(cols)]
        for s in r['g']:
            q = [P(la, lo) for la, lo in s]
            for a, b in zip(q, q[1:]): cv2.line(img, a, b, c, 3)
        if r['id'] in PRJ:
            q = [P(la, lo) for la, lo in PRJ[r['id']]['pts']]
            for k, (a, b) in enumerate(zip(q, q[1:])): cv2.line(img, a, b, (0, 0, 0), 1)
            cv2.circle(img, q[0], 3, (0, 0, 0), -1); cv2.putText(img, r['id'][-1] + "'", (q[0][0] + 4, q[0][1] - 4), 0, 0.45, (0, 0, 0), 1)
        q = P(*r['g'][0][len(r['g'][0]) // 2]); cv2.putText(img, r['id'][-1], (q[0] + 5, q[1] + 5), 0, 0.6, c, 2)
    cv2.putText(img, f'tav {tav}  colore=tavola  nero=progetto  {mpp:.2f} m/px', (5, 15), 0, 0.45, (0, 0, 0), 1)
    return img
for group in sys.argv[1:]:
    ims = [t for t in (tile(x) for x in group.split(',')) if t is not None]
    h = max(i.shape[0] for i in ims); ims = [cv2.copyMakeBorder(i, 0, h - i.shape[0], 0, 6, cv2.BORDER_CONSTANT, value=(255, 255, 255)) for i in ims]
    cv2.imwrite(os.environ.get('ATLANTE_OUT', 'tmp-atlante') + f"/qa_{group.replace(',', '_')}.png", cv2.cvtColor(np.hstack(ims), cv2.COLOR_RGB2BGR))
