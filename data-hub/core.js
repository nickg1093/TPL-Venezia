'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const {registry}=require('./registry');
const tide=require('./parsers/tide'), meteo=require('./parsers/meteo'), web=require('./parsers/web-forecast');
const {openHistory}=require('./history');
const mose=require('./parsers/mose');
const MIN=60000;
async function bounded(res,max){
 if(Number(res.headers.get('content-length'))>max||!res.body){await res.body?.cancel().catch(()=>{});throw Error('invalid body');}
 const reader=res.body.getReader(), chunks=[];let n=0,done=false;
 try{for(;;){const c=await reader.read();if(c.done){done=true;break;}n+=c.value.byteLength;if(n>max)throw Error('body too large');chunks.push(c.value);}}
 finally{if(!done)await reader.cancel().catch(()=>{});reader.releaseLock();}
 return Buffer.concat(chunks,n).toString('utf8');
}
function validate(key,body,now){
 const f=registry[key];let stamp;
 if(key==='mose'){const p=mose.parse(body);if(!p||p.barriere.length!==4||new Set(p.barriere.map(x=>x.barriera)).size!==4||p.barriere.some(x=>x.stato==='sconosciuto'))throw Error('invalid MOSE status');return now;}
 else if(key==='cpsm-web'){const p=web.parseWebForecast(body,now);stamp=p.issue;}
 else if(key==='ispra-level'){const p=tide.parseIspra(body,now);stamp=p?.ts;}
 else if(key==='cpsm-table'){
   const dates=[...body.matchAll(/<td\b[^>]*>\s*(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\s*<\/td>\s*<td\b[^>]*>\s*(-?\d+(?:[.,]\d+)?)\s*<\/td>/gi)].map(m=>Math.abs(Number(m[2].replace(',','.')))<=3?tide.solarToMs(m[1]):null).filter(t=>t&&t<=now+5*MIN);
   stamp=Math.max(0,...dates);
 }else{
   const rows=JSON.parse(body);
   if(!Array.isArray(rows)||!rows.length||rows.length>30000)throw Error('invalid rows');
   if(key==='livello')stamp=tide.selectCpsmLevel(tide.parseLevels(rows),now)?.ts;
   else if(key==='previsione'){
     const points=tide.parseForecast(rows);
     if(!points.some(p=>p.ts>now))throw Error('no future forecast');
     stamp=Math.max(0,...rows.map(r=>tide.solarToMs(r?.DATA_PREVISIONE??r?.data_previsione??r?.emissione)||0));
   }else if(key==='veporto'){stamp=Math.max(0,...meteo.parseVeporto(rows).filter(x=>x.valore!==null&&Number.isFinite(x.misuratoMs)).map(x=>x.misuratoMs));
   }else if(key==='metar'){
     stamp=Math.max(0,...rows.filter(r=>r?.icaoId==='LIPZ'&&typeof r.rawOb==='string').map(r=>typeof r.obsTime==='number'?r.obsTime*1000:Date.parse(r.obsTime)).filter(Number.isFinite));
   }else{
     // Keep the source's native measurements; clients still validate each station and metric.
     stamp=Math.max(0,...meteo.parseCpsm(key,rows).filter(r=>r.valore!==null&&Number.isFinite(r.misuratoMs)).map(r=>r.misuratoMs));
   }
 }
 if(!Number.isFinite(stamp)||stamp>now+5*MIN||now-stamp>f.maxAge)throw Error('stale or invalid source timestamp');
 return stamp;
}
function retryAfter(value,now){if(!value)return 0;const n=/^\d+$/.test(value)?Number(value)*1000:Date.parse(value)-now;return Number.isFinite(n)?Math.max(0,n):0;}
async function createHub({dir,enabled=[],contact,acquire,now=Date.now,gap=10000}){
 if(!dir)throw Error('HUB_STATE_DIR required');
 if(enabled.length&&typeof acquire!=='function')throw Error('acquisition transport required');
 if(enabled.some(k=>!Object.hasOwn(registry,k)))throw Error('unknown source');
 if(enabled.length&&(!contact||!/^https:\/\/[^ ]+$/.test(contact)))throw Error('public contact URL required');
 await fs.mkdir(dir,{recursive:true,mode:0o700});
 const filename=path.join(dir,'state-v1.json');
 let state={version:1,feeds:{},groups:{}};
 try{const raw=await fs.readFile(filename,'utf8');state=JSON.parse(raw);if(state.version!==1||!state.feeds||!state.groups)throw Error('invalid state');}
 catch(e){if(e.code!=='ENOENT')throw e;}
 const history=openHistory(dir);
 let writing=Promise.resolve(),flight=null,lastPrune=0;
 const save=()=>{const snapshot=JSON.stringify(state);writing=writing.catch(()=>{}).then(async()=>{const temp=filename+'.tmp';await fs.writeFile(temp,snapshot,{mode:0o600});await fs.rename(temp,filename);});return writing;};
 async function poll(key){
   const f=registry[key],t=now(),g=state.groups[f.group]??={lastStart:0,until:0,denied:false,failures:0};
   const s=state.feeds[key]??={};
   if(!enabled.includes(key)||g.denied||t<g.until||t-g.lastStart<gap||t<(s.nextAt||0))return false;
   g.lastStart=t;s.nextAt=t+f.interval;s.checkedAt=t;
   // Persist the attempt before making a network request.
   await save();
   try{
     const res=await acquire(key,{headers:{Accept:f.format==='json'?'application/json':f.format==='xml'?'application/xml,text/xml':'text/html','User-Agent':'VeneziaMeteoMarineHub/1.0 (+'+contact+')',...(s.etag?{'If-None-Match':s.etag}:{}),...(s.modified?{'If-Modified-Since':s.modified}:{})},signal:AbortSignal.timeout(25000),redirect:'error'});
     s.http=res.status;
     if(res.status===403||res.status===401){g.denied=true;s.error='access denied; operator review required';await res.body?.cancel().catch(()=>{});return false;}
     if(res.status===429||res.status===503){g.failures=(g.failures||0)+1;g.until=now()+Math.max(Math.min(1800000,MIN*2**Math.min(g.failures,5)),retryAfter(res.headers.get('retry-after'),now()));s.error='source cooldown';await res.body?.cancel().catch(()=>{});return false;}
     if(res.status===304){if(!s.body)throw Error('304 without snapshot');try{validate(key,s.body,now());}catch(e){s.etag=null;s.modified=null;throw e;}s.confirmedAt=now();s.error=null;g.failures=0;return true;}
     if(!res.ok){await res.body?.cancel().catch(()=>{});throw Error('upstream HTTP '+res.status);}
     let body=await bounded(res,f.maxBytes);
     if(key==='veporto'){const rows=JSON.parse(body);body=JSON.stringify(meteo.parseVeporto(rows).filter(x=>x.valore!==null&&Number.isFinite(x.misuratoMs)).map(x=>({nome:x.idStazione,ultimoDato:new Date(x.misuratoMs).toISOString(),meterDetails:[{tipo:'VISIBILIMETER',visibilita:x.valore}]})));}
     if(key==='mose')body=[...body.matchAll(/<table\b[^>]*>[\s\S]*?<\/table>/gi)].map(x=>x[0]).filter(x=>/barriere|orario/i.test(x)).join('\n');
     const stamp=validate(key,body,now());
     if(s.stamp&&stamp<s.stamp)throw Error('older source snapshot');
     history.record(key,body,stamp,now());
     Object.assign(s,{body,stamp,receivedAt:now(),confirmedAt:now(),etag:res.headers.get('etag'),modified:res.headers.get('last-modified'),hash:crypto.createHash('sha256').update(body).digest('hex'),error:null});
     g.failures=0;return true;
   }catch(e){s.error=String(e.message).slice(0,200);g.failures=(g.failures||0)+1;s.nextAt=now()+Math.max(f.interval,Math.min(1800000,MIN*2**Math.min(g.failures,5)));return false;}
   finally{await save();}
 }
 async function tick(){
   if(flight)return flight;
   flight=(async()=>{for(const key of enabled){await poll(key);}if(now()-lastPrune>=3600000){history.prune(Object.keys(registry),now());lastPrune=now();}})().finally(()=>{flight=null;});return flight;
 }
 function get(key){
   if(!Object.hasOwn(registry,key))return null;
   const s=state.feeds[key],f=registry[key];
   if(!s?.body)return null;
   if(key==='mose'&&(!s.confirmedAt||now()-s.confirmedAt>f.maxAge))return null;
   try{validate(key,s.body,now());}catch{return null;}
   return {body:s.body,hash:s.hash,stamp:s.stamp,format:f.format,error:s.error,confirmedAt:s.confirmedAt||s.receivedAt};
 }
 function status(){return Object.fromEntries(Object.entries(registry).map(([k,f])=>{const s=state.feeds[k]||{},g=state.groups[f.group]||{};return [k,{enabled:enabled.includes(k),available:!!get(k),observedOrIssuedAt:s.stamp||null,checkedAt:s.checkedAt||null,http:s.http||null,denied:!!g.denied,retryAt:g.until||null,error:s.error||null}];}));}
 return {tick,get,status,history:(key,from,to,limit,station)=>history.read(key,from,to,limit,station),flush:()=>writing,close:async()=>{if(flight)await flight;await writing;history.close();}};
}
module.exports={createHub,validate,retryAfter};
