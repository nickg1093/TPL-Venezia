'use strict';
// A cache-only reserve. Requests never initiate upstream acquisition.
const BASE='https://dati.venezia.it/sites/default/files/dataset/opendata/';
const feeds={
 'https://veporto.it/pwa-api/v1/meteo-station?limit=1000':'veporto',
 'https://www.autoritalaguna.it/operativita-m-o-s-e/':'mose',
 'https://www.comune.venezia.it/it/content/centro-previsioni-e-segnalazioni-maree-beta':'cpsm-web',
 'https://www.comune.venezia.it/sites/default/files/publicCPSM2/stazioni/temporeale/Punta_Salute.html':'cpsm-table',
 'https://www.venezia.isprambiente.it/dati/Dati2.xml':'ispra-level',
 'https://aviationweather.gov/api/data/metar?ids=LIPZ&format=json&hours=3':'metar',
 'https://aviationweather.gov/api/data/metar?ids=LIPZ&format=json&hours=48':'metar'
};
for(const key of ['livello','previsione','vento','pressione','tempacqua','umidita','temparia'])feeds[BASE+key+'.json']=key;
const enabled=()=>{try{const u=new URL(process.env.METEO_HUB_URL||'');return u.protocol==='https:'&&!u.username&&!u.password&&!u.search&&!u.hash&&u.pathname==='/'&&(process.env.METEO_HUB_TOKEN||'').length>=32;}catch{return false;}};
const inflight=new Map(), cooldown=new Map();
async function readHub(url,{fetchFn=globalThis.fetch,maxBytes=1000000,parse=body=>JSON.parse(body),now=Date.now()}={}){
 if(!enabled()||!Object.hasOwn(feeds,url))throw Error('Hub reserve unavailable');
 const base=new URL(process.env.METEO_HUB_URL);
 if(base.protocol!=='https:'||base.username||base.password||base.search||base.hash||base.pathname!=='/')throw Error('invalid Hub origin');
 const key=feeds[url], target=new URL('/api/v1/feeds/'+key,base).href;
 const token=process.env.METEO_HUB_TOKEN||'';
 if(token.length<32)throw Error('Hub read token not configured');
 if(Date.now()<(cooldown.get(target)||0))throw Error('Hub reserve cooldown');
 let promise=inflight.get(target);
 if(!promise){
  promise=(async()=>{
   const r=await fetchFn(target,{headers:{Accept:'*/*',Authorization:'Bearer '+token},signal:AbortSignal.timeout(8000),redirect:'error'});
   if(!r.ok||r.status!==200){await r.body?.cancel().catch(()=>{});throw Error('Hub HTTP '+r.status);}
   if(!r.body||Number(r.headers.get('content-length'))>maxBytes){await r.body?.cancel().catch(()=>{});throw Error('Hub body invalid');}
   const reader=r.body.getReader(), chunks=[];let total=0,done=false;
   try{for(;;){const x=await reader.read();if(x.done){done=true;break;}total+=x.value.byteLength;if(total>maxBytes)throw Error('Hub body too large');chunks.push(x.value);}}
   finally{if(!done)await reader.cancel().catch(()=>{});reader.releaseLock();}
   return {body:Buffer.concat(chunks,total).toString('utf8'),checkedAt:Date.parse(r.headers.get('X-Source-Checked-At')||''),stamp:Date.parse(r.headers.get('X-Source-Timestamp')||'')};
  })().catch(e=>{cooldown.set(target,Date.now()+60000);throw e;}).finally(()=>inflight.delete(target));
  inflight.set(target,promise);
 }
 const result=await promise;
 if(!Number.isFinite(result.stamp)||result.stamp>now+300000)throw Error('Hub source timestamp missing or future');
 if(Buffer.byteLength(result.body)>maxBytes)throw Error('Hub body too large');
 try{return await parse(result.body,result);}catch(e){cooldown.set(target,Date.now()+60000);throw e;}
}
async function withReserve(primary,url,opts){
 try{return await primary();}catch(original){
  if(!enabled())throw original;
  try{return await readHub(url,opts);}catch{throw original;}
 }
}
module.exports={readHub,withReserve,enabled};
