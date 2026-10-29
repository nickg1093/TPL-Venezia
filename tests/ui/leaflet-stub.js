// Leaflet MINIMO per le prove dell'interfaccia (solo test): proiezione lineare, marcatori come elementi DOM. Non è Leaflet: serve a provare
// layout, pannelli, navigazione, inseguimento e disegno dei livelli senza scaricare librerie. Le funzioni usate da public/js/*.js sono qui.
(function () {
  const ll = (a, b) => Array.isArray(a) ? { lat: a[0], lng: a[1], lon: a[1] } : (a && typeof a === 'object' ? { lat: a.lat, lng: a.lng ?? a.lon, lon: a.lng ?? a.lon } : { lat: a, lng: b, lon: b });
  const pt = (x, y) => ({ x, y, subtract(o) { return pt(x - o.x, y - o.y); } });
  class Ev { on(t, f) { (this._h ||= {})[t] = [...(this._h[t] || []), f]; return this; } fire(t, e) { for (const f of (this._h?.[t] || [])) f(e); } }
  class Layer extends Ev { addTo(g) { g.addLayer(this); return this; } bindTooltip() { return this; } setTooltipContent() {} remove() { if (this._g) this._g.removeLayer(this); else this._rm?.(); } }
  class Group extends Layer {
    constructor() { super(); this.items = new Set(); }
    addLayer(l) { this.items.add(l); l._g = this; if (this._map) l._add?.(this._map); }
    removeLayer(l) { this.items.delete(l); l._rm?.(); }
    clearLayers() { for (const l of this.items) l._rm?.(); this.items.clear(); }
    _add(m) { this._map = m; for (const l of this.items) l._add?.(m); }
    get count() { return this.items.size; }
  }
  class Marker extends Layer {
    constructor(p, o = {}) { super(); this.p = ll(p); this.o = o; this.cls = 'leaflet-marker-icon'; }
    _add(m) { this.el?.remove(); this.m = m; this.el = document.createElement('div'); this.el.className = 'leaflet-marker-icon ' + (this.o.icon?.className || ''); this.el.style.position = 'absolute'; this._ic(); m._els.appendChild(this.el); m._all.add(this); this.pos();
      this.el.addEventListener('click', e => { e.stopPropagation(); this.fire('click', e); }); }
    _ic() { if (this.el && this.o.icon) { this.el.innerHTML = this.o.icon.html || ''; this.el.className = 'leaflet-marker-icon ' + (this.o.icon.className || ''); } }
    _rm() { this.el?.remove(); this.m?._all.delete(this); }
    pos() { if (!this.el) return; const c = this.m.latLngToContainerPoint(this.p); this.el.style.left = c.x + 'px'; this.el.style.top = c.y + 'px'; this.el.style.transform = 'translate(-50%,-50%)'; }
    setLatLng(p) { this.p = ll(p); this.pos(); return this; } getLatLng() { return this.p; }
    setIcon(i) { this.o.icon = i; this._ic(); } on(t, f) { return super.on(t, f); }
  }
  class Circle extends Marker {
    constructor(p, o) { super(p, o); }
    _add(m) { super._add(m); this.el.className = 'leaflet-circle'; this.el.dataset.sel = this.o.radius > 7 ? '1' : '0'; this.el.style.cssText += `;width:${this.o.radius * 2}px;height:${this.o.radius * 2}px;border-radius:50%;background:${this.o.fillColor || '#fff'};border:1px solid #000;pointer-events:auto`; }
  }
  class Poly extends Layer {
    constructor(p, o) { super(); this.pts = p; this.o = o; }
    _add(m) { this.m = m; m._polys.add(this); } _rm() { this.m?._polys.delete(this); }
  }
  class Map_ extends Group {
    constructor(id, o) { super(); this.el = typeof id === 'string' ? document.getElementById(id) : id; this._h = {}; this._all = new Set(); this._polys = new Set(); this.c = { lat: 45.437, lng: 12.335 }; this.z = 12;
      this._els = document.createElement('div'); this._els.className = 'leaflet-pane'; this._els.style.cssText = 'position:absolute;inset:0;overflow:hidden'; this.el.classList.add('leaflet-container'); this.el.appendChild(this._els);
      this.el.addEventListener('click', () => this.fire('click', {})); this._map = this; window.__map = this; }
    k(z) { return 256 * 2 ** z / 360; }
    getZoom() { return this.z; } getSize() { return pt(this.el.clientWidth, this.el.clientHeight); }
    project(p, z = this.z) { p = ll(p); return pt(p.lng * this.k(z), -p.lat * this.k(z) * 1.4); }
    unproject(q, z = this.z) { return { lat: -q.y / (this.k(z) * 1.4), lng: q.x / this.k(z), lon: q.x / this.k(z) }; }
    latLngToContainerPoint(p) { const a = this.project(p), c = this.project(this.c), s = this.getSize(); return pt(a.x - c.x + s.x / 2, a.y - c.y + s.y / 2); }
    getBounds() { const s = this.getSize(), tl = this.unproject(pt(this.project(this.c).x - s.x / 2, this.project(this.c).y - s.y / 2)), br = this.unproject(pt(this.project(this.c).x + s.x / 2, this.project(this.c).y + s.y / 2));
      const b = { pad() { return b; }, contains(p) { p = ll(p); return p.lat <= tl.lat && p.lat >= br.lat && p.lng >= tl.lng && p.lng <= br.lng; } }; return b; }
    _moved() { for (const m of this._all) m.pos(); this.fire('moveend', {}); }
    setView(p, z = this.z) { this.c = ll(p); this.z = z; this._moved(); return this; }
    panTo(p) { this.c = ll(p); this._moved(); } flyTo(p, z) { this.c = ll(p); this.z = z; this._moved(); }
    panBy(d) { const c = this.project(this.c); this.c = this.unproject(pt(c.x + d[0], c.y + d[1])); this._moved(); }
    invalidateSize() { this._moved(); } stopLocate() {} locate() { window.__geo ? this.fire('locationfound', { latlng: ll(window.__geo), accuracy: 10 }) : this.fire('locationerror', {}); }
  }
  window.L = { map: (i, o) => new Map_(i, o), latLng: ll, point: pt, divIcon: o => o, tileLayer: () => ({ addTo() { return this; } }), layerGroup: () => new Group(),
    marker: (p, o) => new Marker(p, o), circleMarker: (p, o) => new Circle(p, o), polyline: (p, o) => new Poly(p, o),
    control: { zoom: () => ({ addTo() { return this; } }) } };
  // gli strati aggiunti alla mappa ricevono _add
  const addTo = Group.prototype.addTo; Group.prototype.addTo = function (m) { this._map = m; return addTo.call(this, m); };
  Layer.prototype.addTo = function (g) { g.addLayer ? g.addLayer(this) : g; if (g._map && this._add) { /* già nel gruppo */ } if (g instanceof Map_) this._add(g); return this; };
  Group.prototype.addLayer = function (l) { this.items.add(l); l._g = this; if (this._map) l._add?.(this._map); };
})();
