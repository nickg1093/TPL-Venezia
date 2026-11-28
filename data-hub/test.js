const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {createHub:makeHub}=require('./core'),{hubFetch}=require('./client');
const {registry}=require('./registry'),{createVeportoFetch}=require('./veporto');
// Legacy format fixtures exercise storage only; never production network.
function createHub({fetchFn,veportoCredentials,now=Date.now,...opts}){
 const vp=createVeportoFetch({fetchFn,now,credentials:veportoCredentials});
 return makeHub({...opts,now,acquire:(key,options)=>(key==='veporto'?vp:fetchFn)(registry[key].url,options)});
}
test('authorized feed cache survives restart; 403 locks publisher; no additional requests',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'hub-'));let t=Date.parse('2026-11-28T10:00:00Z'),calls=0;
 const opts={dir,enabled:['livello','previsione'],contact:'https://example.test/about',now:()=>t,gap:0,fetchFn:async()=>{calls++;return calls===1?Response.json([{ID_stazione:1025,stazione:'Punta Salute Canal Grande',data:'2026-11-28 10:55:00',valore:'0.7'}]):new Response(null,{status:403});}};
 try{let h=await createHub(opts);await h.tick();assert.equal(calls,2);assert.ok(h.get('livello'));assert.ok(h.status().livello.denied);await h.close();h=await createHub(opts);await h.tick();assert.equal(calls,2);assert.ok(h.get('livello'));assert.equal(h.history('livello',t-3600000,t,20).items.length,1);t+=3600000;assert.equal(h.get('livello'),null);await h.close();}finally{await fs.rm(dir,{recursive:true,force:true});}
});
test('disabled by default; client uses fixed endpoint and never falls back to upstream',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'hub-'));try{const h=await createHub({dir,fetchFn:async()=>{throw Error('unexpected network');}});await h.tick();assert.equal(h.get('livello'),null);await h.close();}finally{await fs.rm(dir,{recursive:true,force:true});}
 const old=process.env.METEO_HUB_URL;process.env.METEO_HUB_URL='https://hub.example.test';
 try{let calls=0;const r=await hubFetch('https://dati.venezia.it/sites/default/files/dataset/opendata/livello.json',{},async(url)=>{calls++;assert.equal(url,'https://hub.example.test/api/v1/feeds/livello');return new Response(null,{status:503});});assert.equal(r.status,503);assert.equal(calls,1);}finally{if(old===undefined)delete process.env.METEO_HUB_URL;else process.env.METEO_HUB_URL=old;}
});

test('vePORTO selected sensors only, no credentials stored, dedup and original timestamps across restart',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'hub-vp-'));let t=Date.parse('2026-11-28T10:00:00Z'),auth=0,reads=0;
 const token='abc.'+Buffer.from(JSON.stringify({exp:t/1000+3600})).toString('base64url')+'.sig';
 const opts={dir,enabled:['veporto'],contact:'https://example.test/about',now:()=>t,gap:0,veportoCredentials:{username:'test-user',password:'not-real-secret'},fetchFn:async(url,options)=>{
   if(url.endsWith('/auth')){auth++;return new Response(null,{headers:{authorization:'Bearer '+token}});}
   reads++;assert.equal(options.headers.Authorization,'Bearer '+token);
   return Response.json([{nome:'SAN SERVOLO',ultimoDato:'2026-11-28T09:59:00Z',meterDetails:[{tipo:'VISIBILIMETER',visibilita:350}]},{nome:'UNRELATED',ultimoDato:'2026-11-28T09:59:00Z',meterDetails:[{tipo:'OTHER',value:1}]}]);
 }};
 try{let h=await createHub(opts);await h.tick();assert.equal(auth,1);assert.equal(reads,1);assert.equal(JSON.parse(h.get('veporto').body).length,1);t+=300000;await h.tick();assert.equal(auth,1);assert.equal(h.history('veporto',t-3600000,t,20).items.length,1);await h.close();const disk=await fs.readFile(path.join(dir,'state-v1.json'),'utf8');assert.ok(!disk.includes(token)&&!disk.includes('not-real-secret'));h=await createHub(opts);assert.equal(h.history('veporto',t-3600000,t,20).items[0].timestamp,Date.parse('2026-11-28T09:59:00Z'));t+=1800000;assert.equal(h.get('veporto'),null);await h.close();}finally{await fs.rm(dir,{recursive:true,force:true});}
});
test('MOSE confirms unchanged state but does not refresh on reads; rejects incomplete table',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'hub-mose-'));let t=Date.parse('2026-11-28T10:00:00Z'),calls=0;
 const body='<table><thead><tr><th>Bocche di porto</th><th>Barriere</th><th>Stato</th></tr></thead><tbody>'+['Lido 1','Lido 2','Malamocco','Chioggia'].map(k=>'<tr><td>'+k+'</td><td>'+k+'</td><td>Paratoie in recesso</td></tr>').join('')+'</tbody></table>';
 try{const h=await createHub({dir,enabled:['mose'],contact:'https://example.test/about',now:()=>t,gap:0,fetchFn:async()=>{calls++;return calls===1?new Response(body,{headers:{etag:'"mose"'}}):new Response(null,{status:304});}});await h.tick();assert.equal(h.get('mose').confirmedAt,t);t+=300000;await h.tick();assert.equal(h.get('mose').confirmedAt,t);t+=2700001;assert.equal(h.get('mose'),null);assert.equal(calls,2);await h.close();}finally{await fs.rm(dir,{recursive:true,force:true});}
});
