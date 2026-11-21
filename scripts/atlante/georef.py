# Georeferenziazione delle tavole dell'Atlante passerelle: immagine di fondo (curve RAMSES colorate) registrata sulle curve RAMSES (EPSG:3004)
import os
import sys, json, re, math, numpy as np, cv2, fitz
from pyproj import Transformer
Z = np.load(os.environ.get('RAMSES_NPZ', 'tmp-atlante/raster.npz')); D = Z['dist_dm']; X0 = float(Z['x0']); Y1 = float(Z['y1']); RES = float(Z['res']); H, W = D.shape
CONT = (D == 0)                                   # pixel di curva (0,5 m)
T2 = Transformer.from_crs(4326, 3004, always_xy=True); T4 = Transformer.from_crs(3004, 4326, always_xy=True)
PRJ = {p['id']: p for p in json.load(open(os.path.join(os.environ.get('ATLANTE_OUT', 'tmp-atlante'), 'progetto.json')))}
def ramses_mask(x0, y0, x1, y1, mpp):          # maschera delle curve nel riquadro EPSG:3004, mpp metri per pixel
    c0 = int((x0 - X0) / RES); c1 = int((x1 - X0) / RES); r0 = int((Y1 - y1) / RES); r1 = int((Y1 - y0) / RES)
    c0, r0 = max(c0, 0), max(r0, 0); c1, r1 = min(c1, W), min(r1, H)
    if c1 - c0 < 4 or r1 - r0 < 4: return np.zeros((2, 2), np.float32), x0, y1
    sub = CONT[r0:r1, c0:c1].astype(np.float32)
    f = RES / mpp
    m = cv2.resize(sub, (max(1, int(sub.shape[1] * f)), max(1, int(sub.shape[0] * f))), interpolation=cv2.INTER_AREA)
    return m, X0 + c0 * RES, Y1 - r0 * RES          # origine (angolo in alto a sinistra) in metri
def pdf_mask(img):                              # pixel colorati delle curve (rosso/arancio/giallo), non grigi né blu
    hsv = cv2.cvtColor(img, cv2.COLOR_RGB2HSV)
    return (((hsv[..., 0] < 35) | (hsv[..., 0] > 165)) & (hsv[..., 1] > 70) & (hsv[..., 2] > 80)).astype(np.float32)
BOXR = (X0 + 20, Y1 - H * RES + 20, X0 + W * RES - 20, Y1 - 20)
def dentro(xy, m=150): return BOXR[0] - m < xy[0] < BOXR[2] + m and BOXR[1] - m < xy[1] < BOXR[3] + m
def registra(img, guess_xy, raggio=450, mk=None, scale=(0.08, 1.2)):
    mk = pdf_mask(img) if mk is None else mk; h, w = mk.shape
    best = None
    for mpp_img in np.geomspace(scale[0], scale[1], 70):          # metri per pixel dell'immagine
        mpp = 1.0                                          # griglia di confronto: 1 m per pixel
        f = mpp_img / mpp; tw, th = int(w * f), int(h * f)
        if tw < 40 or th < 40 or tw > 3000: continue
        tpl = cv2.GaussianBlur(cv2.resize(mk, (tw, th), interpolation=cv2.INTER_AREA), (0, 0), 2)
        gx, gy = guess_xy
        x0, x1 = gx - raggio - tw * mpp, gx + raggio + tw * mpp; y0, y1 = gy - raggio - th * mpp, gy + raggio + th * mpp
        ref, ox, oy = ramses_mask(x0, y0, x1, y1, mpp)
        if ref.shape[0] <= th or ref.shape[1] <= tw: continue
        ref = cv2.GaussianBlur(ref, (0, 0), 2) + np.random.default_rng(0).random(ref.shape, dtype=np.float32) * 1e-3
        res = cv2.matchTemplate(ref, tpl, cv2.TM_CCOEFF_NORMED)
        _, mv, _, ml = cv2.minMaxLoc(res)
        if best is None or mv > best[0]: best = (mv, mpp_img, ox + ml[0] * mpp, oy - ml[1] * mpp, res)
    mv, mpp_img, ex, ny, res = best
    # nitidezza del picco: secondo massimo fuori da 15 px
    r2 = res.copy(); _, _, _, ml = cv2.minMaxLoc(r2); cv2.circle(r2, ml, 15, -1, -1); _, mv2, _, _ = cv2.minMaxLoc(r2)
    return {'score': round(float(mv), 3), 'secondo': round(float(mv2), 3), 'mpp': float(mpp_img), 'E0': float(ex), 'N0': float(ny)}
def overlay(img, r, path):
    h, w = img.shape[:2]; mpp = r['mpp']
    ref, ox, oy = ramses_mask(r['E0'], r['N0'] - h * mpp, r['E0'] + w * mpp, r['N0'], mpp)
    ref = cv2.resize(ref, (w, h)) > 0.05
    out = (img * 0.55).astype(np.uint8); out[ref] = (0, 90, 255)
    cv2.imwrite(path, cv2.cvtColor(out, cv2.COLOR_RGB2BGR)[::2, ::2])
