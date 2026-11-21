# Rasterizza le curve RAMSES (EPSG:3004, quote LIVELLO_PS in cm su ZMPS) a 0,5 m e calcola per ogni pixel
import os
# la quota della curva più vicina e la distanza da essa. Uscita: npz con livello (int16), distanza (uint16, decimetri), georef.
import sys, numpy as np, shapefile
from PIL import Image, ImageDraw
from scipy import ndimage
src, out = sys.argv[1], sys.argv[2]
RES = 0.5
r = shapefile.Reader(src)
x0, y0, x1, y1 = r.bbox
x0 = np.floor(x0) - 5; y0 = np.floor(y0) - 5; x1 = np.ceil(x1) + 5; y1 = np.ceil(y1) + 5
W = int((x1 - x0) / RES) + 1; H = int((y1 - y0) / RES) + 1
print('raster', W, H, W * H / 1e6, 'Mpx', flush=True)
levels = np.array([rec[2] for rec in r.iterRecords()], dtype=np.int32)
order = np.argsort(-levels, kind='stable')          # prima le quote alte: dove più curve cadono nello stesso pixel vince la più bassa
img = Image.new('I', (W, H), 0); dr = ImageDraw.Draw(img)
for n, i in enumerate(order):
    s = r.shape(int(i)); pts = np.asarray(s.points)
    if len(pts) == 0: continue
    px = (pts[:, 0] - x0) / RES; py = (y1 - pts[:, 1]) / RES
    parts = list(s.parts) + [len(pts)]
    for a, b in zip(parts[:-1], parts[1:]):
        seg = list(zip(px[a:b].tolist(), py[a:b].tolist()))
        if len(seg) == 1: dr.point(seg, fill=int(levels[i]))
        else: dr.line(seg, fill=int(levels[i]), width=1)
    if n % 50000 == 0: print(n, flush=True)
lv = np.asarray(img, dtype=np.int32); del img
mask = lv > 0
print('pixel con curva', mask.sum(), flush=True)
dist, ind = ndimage.distance_transform_edt(~mask, return_indices=True)
near = lv[ind[0], ind[1]].astype(np.int16); del ind, lv
dd = np.minimum(np.round(dist * RES * 10), 65535).astype(np.uint16); del dist
np.savez(out, livello=near, dist_dm=dd, x0=x0, y1=y1, res=RES)
print('salvato', out)
