'use strict';
// Bounded read-only pagination; no upstream requests. Caller inserts missing points.
const allowed=new Set(['livello','cpsm-table','ispra-level','vento','pressione','tempacqua','umidita','temparia','veporto','metar']);
async function readHistory(key,from,to,{fetchFn=globalThis.fetch,limit=500,maxPages=16,onPage=()=>{}}={}){
 if(!process.env.METEO_HUB_URL)return 0;
 if(!allowed.has(key)||!Number.isSafeInteger(from)||!Number.isSafeInteger(to)||from>to)throw Error('invalid history request');
 const base=new URL(process.env.METEO_HUB_URL),token=process.env.METEO_HUB_TOKEN||'';
 if(base.protocol!=='https:'||base.username||base.password||base.search||base.hash||base.pathname!=='/'||token.length<32)throw Error('invalid Hub configuration');
 let cursor=from,station='',count=0;
 for(let page=0;page<maxPages;page++){
  const url=new URL('/api/v1/history/'+key,base);
  url.search=new URLSearchParams({from:String(cursor),to:String(to),limit:String(limit),station});
  const response=await fetchFn(url.href,{headers:{Authorization:'Bearer '+token,Accept:'application/json'},redirect:'error',signal:AbortSignal.timeout(8000)});
  if(!response.ok||!response.body){await response.body?.cancel().catch(()=>{});throw Error('Hub history unavailable');}
  const reader=response.body.getReader(),chunks=[];let total=0,done=false;
  try{for(;;){const x=await reader.read();if(x.done){done=true;break;}total+=x.value.byteLength;if(total>1000000)throw Error('Hub history too large');chunks.push(x.value);}}
  finally{if(!done)await reader.cancel().catch(()=>{});reader.releaseLock();}
  const payload=JSON.parse(Buffer.concat(chunks,total).toString('utf8'));
  if(payload.feed!==key||!Array.isArray(payload.items)||payload.items.length>limit)throw Error('invalid Hub history');
  const items=payload.items.filter(x=>Number.isSafeInteger(x?.timestamp)&&x.timestamp>=from&&x.timestamp<=to&&typeof x.station==='string'&&x.station.length<=100&&x.data&&typeof x.data==='object');
  await onPage(items);count+=items.length;
  if(!payload.next)return count;
  const n=payload.next;
  if(!Number.isSafeInteger(n.from)||n.from<cursor||n.from>to||typeof n.station!=='string'||n.station.length>100||(n.from===cursor&&n.station<=station))throw Error('invalid history cursor');
  cursor=n.from;station=n.station;
 }
 throw Error('Hub history pagination limit');
}
module.exports={readHistory};
