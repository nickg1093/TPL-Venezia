import math, numpy as np
import os
from skimage.morphology import skeletonize
def mlen(g): return sum(math.dist(g[i-1], g[i]) for i in range(1, len(g)))
def segmenti(mask, min_px=12):
    # scheletro -> tratti tra estremi/incroci (8-connessione), in coordinate pixel (x, y)
    sk = skeletonize(mask > 0); ys, xs = np.nonzero(sk); P = set(zip(xs.tolist(), ys.tolist()))
    nb = lambda p: [(p[0]+dx, p[1]+dy) for dx in (-1,0,1) for dy in (-1,0,1) if (dx or dy) and (p[0]+dx, p[1]+dy) in P]
    deg = {p: len(nb(p)) for p in P}; nodi = {p for p in P if deg[p] != 2}; visti = set(); out = []
    for s in nodi:
        for q in nb(s):
            if (s, q) in visti: continue
            path = [s, q]; visti.add((s, q)); visti.add((q, s)); prev, cur = s, q
            while cur not in nodi:
                nx = [r for r in nb(cur) if r != prev and (cur, r) not in visti]
                if not nx: break
                visti.add((cur, nx[0])); visti.add((nx[0], cur)); prev, cur = cur, nx[0]; path.append(cur)
            if len(path) >= min_px: out.append(path)
    # anelli senza nodi
    return out
