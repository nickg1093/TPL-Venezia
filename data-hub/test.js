const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {createHub}=require('./core'),{hubFetch}=require('../hub-client');
test('authorized feed cache survives restart; 403 locks publisher; no additional requests',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'hub-'));let t=Date.parse('2026-11-28T10:00:00Z'),calls=0;
 const opts={dir,enabled:['livello','previsione'],contact:'https://example.test/about',now:()=>t,gap:0,fetchFn:async()=>{calls++;return calls===1?Response.json([{ID_stazione:1025,stazione:'Punta Salute Canal Grande',data:'2026-11-28 10:55:00',valore:'0.7'}]):new Response(null,{status:403});}};
 try{let h=await createHub(opts);await h.tick();assert.equal(calls,2);assert.ok(h.get('livello'));assert.ok(h.status().livello.denied);h=await createHub(opts);await h.tick();assert.equal(calls,2);assert.ok(h.get('livello'));t+=3600000;assert.equal(h.get('livello'),null);}finally{await fs.rm(dir,{recursive:true,force:true});}
});
test('disabled by default; client uses fixed endpoint and never falls back to upstream',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'hub-'));try{const h=await createHub({dir,fetchFn:async()=>{throw Error('unexpected network');}});await h.tick();assert.equal(h.get('livello'),null);}finally{await fs.rm(dir,{recursive:true,force:true});}
 const old=process.env.METEO_HUB_URL;process.env.METEO_HUB_URL='https://hub.example.test';
 try{let calls=0;const r=await hubFetch('https://dati.venezia.it/sites/default/files/dataset/opendata/livello.json',{},async(url)=>{calls++;assert.equal(url,'https://hub.example.test/api/v1/feeds/livello');return new Response(null,{status:503});});assert.equal(r.status,503);assert.equal(calls,1);}finally{if(old===undefined)delete process.env.METEO_HUB_URL;else process.env.METEO_HUB_URL=old;}
});
