'use strict';
// Preserve healthy primary measurements, fill only absent/invalid/stale stations.
// Never change source timestamp or substitute a different station.
const EXPECTED=Object.freeze({vento:['1039','1029','1047','1049'],pressione:['1026'],tempacqua:['1025'],umidita:['1026','1039'],temparia:['1026','1039'],veporto:['SAN SERVOLO','MARITTIMA',"SANT'ANDREA"]});
function mergeSensors(primary,reserve,inspect,expected,now,age){
 const a=Array.isArray(primary)?primary:[],b=Array.isArray(reserve)?reserve:[];
 const recent=x=>x&&x.valid&&Number.isFinite(x.stamp)&&x.stamp<=now+300000&&x.stamp>=now-age;
 const latest=rows=>{const out=new Map();for(const row of rows){const m=inspect(row);if(!m?.id)continue;const old=out.get(m.id);if(!old||(Number.isFinite(m.stamp)&&(!Number.isFinite(old.stamp)||m.stamp>=old.stamp)))out.set(m.id,{...m,row});}return out;};
 const first=latest(a),second=latest(b),missing=[...new Set([...expected,...first.keys()])].filter(id=>!recent(first.get(id)));
 const replacements=new Map();
 for(const id of missing){const other=second.get(id);if(recent(other))replacements.set(id,other);}
 const rows=a.filter(row=>{const m=inspect(row),replacement=replacements.get(m?.id);return !replacement||(m.valid&&Number.isFinite(m.stamp)&&m.stamp<replacement.stamp);});
 for(const x of replacements.values())rows.push(x.row);
 return {rows,missing,filled:[...replacements.keys()]};
}
module.exports={EXPECTED,mergeSensors};
