'use strict';
function solarToMs(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(String(s || '').trim());
  if (!m) return null;
  const [y,mo,d,h,mi,se] = m.slice(1).map(Number);
  const local = Date.UTC(y, mo-1, d, h, mi, se || 0), check = new Date(local);
  if (!Number.isFinite(local) || check.getUTCFullYear()!==y || check.getUTCMonth()!==mo-1 || check.getUTCDate()!==d || check.getUTCHours()!==h || check.getUTCMinutes()!==mi || check.getUTCSeconds()!==(se||0)) return null;
  return local-SOLAR;
}
const SOLAR=3600000;
const rome = new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Rome',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});
function forecastTime(value){
 if(typeof value!=='string')return null;
 const s=value.trim().replace(' ','T');
 if(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/i.test(s)){
  if(solarToMs(s.slice(0,19))==null)return null;
  const ms=Date.parse(s);return Number.isFinite(ms)?ms:null;
 }
 if(!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d$/.test(s)||solarToMs(s)==null)return null;
 const times=[1,2].map(x=>Date.parse(s+'+0'+x+':00')).filter(t=>Number.isFinite(t)&&rome.format(new Date(t)).replace(' ','T')===s);
 return times.length===1?times[0]:null;
}
function selectForecast(rows,now=Date.now()){
 if(!Array.isArray(rows))throw Error('invalid forecast rows');
 const valid=rows.flatMap(row=>{
  const issue=forecastTime(row?.DATA_PREVISIONE),ts=forecastTime(row?.DATA_ESTREMALE);
  const raw=String(row?.VALORE??'').trim();
  const cm=/^-?\d+(?:[.,]\d+)?$/.test(raw)?Number(raw.replace(',','.')):NaN;
  const typ=String(row?.TIPO_ESTREMALE??'').trim().toLowerCase();
  const type=/^(?:max|alt[ae])/.test(typ)?'max':/^(?:min|bass[ae])/.test(typ)?'min':null;
  return issue!==null&&ts!==null&&type&&Number.isFinite(cm)&&Math.abs(cm)<=300?[{issue,ts,type,cm:Math.round(cm)}]:[];
 });
 const issue=Math.max(0,...valid.map(p=>p.issue));
 if(!issue||issue>now+300000||now-issue>72*3600000)throw Error('invalid forecast issue');
 const points=[...new Map(valid.filter(p=>p.issue===issue&&p.ts>=issue-86400000&&p.ts<=issue+96*3600000).map(p=>[p.ts,{type:p.type,cm:p.cm,ts:p.ts}])).values()].sort((a,b)=>a.ts-b.ts);
 if(!points.some(p=>p.ts>now))throw Error('no future forecast');
 return {issue,points};
}
module.exports={forecastTime,selectForecast};
