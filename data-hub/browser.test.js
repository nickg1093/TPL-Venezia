'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createMoseBrowserFetch,allowed,URL}=require('./mose-browser');
const {createHub}=require('./core');
const {createBrowserEngine,assertEligible}=require('./browser-engine');
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const headers={'User-Agent':'VeneziaMeteoMarineHub/1.0 (+https://example.test/about)'};
test('fixed source only; deny unrelated origin and POST',async()=>{
 const get=(url,method='GET',nav=false)=>({url:()=>url,method:()=>method,isNavigationRequest:()=>nav});
 assert.equal(allowed(get(URL,'GET',true)),true);
 assert.equal(allowed(get('https://example.com/')),false);
 assert.equal(allowed(get(URL,'POST')),false);
 assert.equal(allowed(get('https://www.autoritalaguna.it/other','GET',true)),false);
 const fetch=createMoseBrowserFetch({launch:async()=>{throw Error('should not launch');}});
 await assert.rejects(fetch('https://example.com/',{headers}),/not allowed/);
 await assert.rejects(fetch(URL,{}),/identity/);
});
test('MOSE browser stops on HTTP 403, closes resources, and persists denial across restart',async()=>{
 let launches=0,closes=0,contextCloses=0,navs=0,t=Date.parse('2026-11-28T10:00:00Z');
 const read=createMoseBrowserFetch({launch:async opts=>{
   launches++;assert.equal(opts.chromiumSandbox,true);assert.equal(opts.headless,true);
   return {close:async()=>{closes++;},newContext:async opts=>{
     assert.equal(opts.serviceWorkers,'block');assert.ok(opts.userAgent.includes('VeneziaMeteoMarineHub'));
     return {close:async()=>{contextCloses++;},route:async()=>{},routeWebSocket:async()=>{},newPage:async()=>({
       on:()=>{},url:()=>URL,goto:async()=>{navs++;return {status:()=>403,ok:()=>false};},
       title:async()=>{throw Error('must not inspect denial');}
     })};
   }};
 }});
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'hub-browser-'));
 const opts={dir,enabled:['mose'],contact:'https://example.test/about',now:()=>t,gap:0,acquire:(key,options)=>{assert.equal(key,'mose');return read(URL,options);}};
 try{let h=await createHub(opts);await h.tick();assert.ok(h.status().mose.denied);assert.equal(h.status().mose.http,403);assert.equal(h.get('mose'),null);await h.close();t+=3600000;h=await createHub(opts);await h.tick();assert.equal(launches,1);assert.equal(navs,1);assert.equal(closes,1);assert.equal(contextCloses,1);await h.close();}finally{await fs.rm(dir,{recursive:true,force:true});}
});

test('production engine rejects suspended publishers before launching Chromium',async()=>{
 let launches=0;
 const engine=createBrowserEngine({launch:async()=>{launches++;throw Error('unexpected launch');}});
 for(const key of ['livello','previsione','vento','pressione','temparia','tempacqua','umidita','cpsm-web','cpsm-table','veporto']){
  assert.throws(()=>assertEligible([key]),/suspended/);
  await assert.rejects(engine(key,{headers}),/suspended/);
 }
 assert.equal(launches,0);
 assert.doesNotThrow(()=>assertEligible(['mose','ispra-level','metar']));
});
test('storage cannot acquire an enabled source without explicit transport',async()=>{
 await assert.rejects(createHub({dir:'unused',enabled:['mose'],contact:'https://example.test/about'}),/transport required/);
});
