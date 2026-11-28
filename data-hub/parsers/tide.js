'use strict';
const SOLAR=3600000, STALE_MS=20*60000;
const MAIN={id:'1025'},FALLBACK=['1045','1029'],ISPRA_ST={marker:'129',id:'I129',name:'Punta della Salute (ISPRA)'};
function solarToMs(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(String(s || '').trim());
  if (!m) return null;
  const [y,mo,d,h,mi,se] = m.slice(1).map(Number);
  const local = Date.UTC(y, mo-1, d, h, mi, se || 0), check = new Date(local);
  if (!Number.isFinite(local) || check.getUTCFullYear()!==y || check.getUTCMonth()!==mo-1 || check.getUTCDate()!==d || check.getUTCHours()!==h || check.getUTCMinutes()!==mi || check.getUTCSeconds()!==(se||0)) return null;
  return local-SOLAR;
}
// "0.79 m" -> 79 (cm); -999 / non numerico -> null
function toCm(v) {
  const m = /^\s*(-?\d+(?:[.,]\d+)?)\s*m?\s*$/i.exec(String(v ?? ''));
  const n = m ? Number(m[1].replace(',','.')) : NaN;
  return Number.isFinite(n) && Math.abs(n)<=3 ? Math.round(n*100) : null;
}

function parseLevels(json) {
  if (!Array.isArray(json)) return [];
  return json.filter(o=>o && typeof o==='object').map(o => ({ id: String(o.ID_stazione), name: o.stazione, cm: toCm(o.valore), ts: solarToMs(o.data) })).filter(s => s.ts != null);
}

// Select the latest valid observation per station; prefer the reference station.
function selectCpsmLevel(rows, now=Date.now()) {
  const valid=rows.filter(s=>s.cm!=null && s.ts<=now+5*60e3 && s.ts>=now-STALE_MS);
  for(const id of [MAIN.id,...FALLBACK]) {
    const newest=valid.filter(s=>s.id===id).sort((a,b)=>b.ts-a.ts)[0];
    if(newest)return {...newest,src:'cpsm'};
  }
  return null;
}
function parseIspra(xml, now = Date.now()) {
  const m = new RegExp(`<marker\\s+id\\s*=\\s*"${ISPRA_ST.marker}"[^>]*>([\\s\\S]*?)</marker>`).exec(String(xml || ''));
  if (!m) return null;
  const ins = /<instrument[^>]*type\s*=\s*"Marea"[^>]*>\s*<value\s+datetime\s*=\s*"(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2})(?::(\d{2}))?"\s*>\s*(-?\d+(?:[.,]\d+)?)\s*<\/value>/.exec(m[1]);
  if (!ins) return null;
  let ts = Date.UTC(+ins[3], +ins[2] - 1, +ins[1], +ins[4], +ins[5], +(ins[6] || 0)) - SOLAR;
  if (ts > now + 10 * 60e3) ts -= 3600e3;
  const cm = Math.round(parseFloat(ins[7].replace(',', '.')));
  if (!Number.isFinite(cm) || cm <= -400 || cm >= 500 || ts > now + 10 * 60e3) return null;
  return { id: ISPRA_ST.id, name: ISPRA_ST.name, cm, ts, src: 'ispra' };
}
function parseForecast(json) {
  let arr = Array.isArray(json) ? json : null;
  if (!arr && json && typeof json === 'object') {
    const st = [json];
    while (st.length) { const o = st.pop(); if (Array.isArray(o) && o.length && o[0] && typeof o[0] === 'object') { arr = o; break; } if (o && typeof o === 'object') st.push(...Object.values(o)); }
  }
  if (!arr) return [];
  const pick = (o, re) => { const k = Object.keys(o).find(k => re.test(k)); return k === undefined ? undefined : o[k]; };
  const out = []; let prevTs = null;
  for (const o of arr) {
    if (!o || typeof o !== 'object') continue;
    const cm = parseFloat(String(pick(o, /^(valore|value|livello|altezza|cm)$/i) ?? '').replace(',', '.'));
    const typ = String(pick(o, /^(tipo|tipo_?estremale|type|estremale|estremo)$/i) ?? '').toLowerCase(), type = /max|alt/.test(typ) ? 'max' : /min|bass/.test(typ) ? 'min' : null;
    const issued = solarToMs(pick(o, /emissione|data_?previsione/i));
    let ts = solarToMs(pick(o, /^(data_?ora|data_?estremale|datetime|istante|timestamp)$/i));
    if (ts == null) {
      const hm = /^(\d{1,2}):(\d{2})/.exec(String(pick(o, /^ora$/i) ?? ''));
      if (hm && issued != null) {
        const day0 = Math.floor((issued + SOLAR) / 864e5) * 864e5 - SOLAR;       // mezzanotte (solare) del giorno di emissione
        ts = day0 + (+hm[1] * 3600 + +hm[2] * 60) * 1000;
        if (prevTs != null) { while (ts < prevTs) ts += 864e5; } else if (ts < issued - 3600e3) ts += 864e5;   // elenco cronologico: passaggio di giorno
      }
    }
    if (!Number.isFinite(cm) || Math.abs(cm)>300 || !type || ts == null) continue;
    out.push({ type, cm: Math.round(cm), ts }); prevTs = ts;
  }
  return [...new Map(out.map(p=>[p.ts,p])).values()].sort((a,b)=>a.ts-b.ts);
}



module.exports={solarToMs,toCm,parseLevels,selectCpsmLevel,parseIspra,parseForecast};
