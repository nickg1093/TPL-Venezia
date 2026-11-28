const test=require('node:test'),assert=require('node:assert/strict');
const {withReserve}=require('../hub-reserve');
test('direct success never contacts hub; fail reads only cached hub; original error on dual failure',async()=>{
 const old=process.env.METEO_HUB_URL,ot=process.env.METEO_HUB_TOKEN;
 process.env.METEO_HUB_URL='https://hub.example.test';process.env.METEO_HUB_TOKEN='x'.repeat(32);
 const url='https://dati.venezia.it/sites/default/files/dataset/opendata/livello.json';
 let calls=0;const now=Date.now(),opts={now,fetchFn:async(u,o)=>{calls++;assert.equal(u,'https://hub.example.test/api/v1/feeds/livello');assert.equal(o.headers.Authorization,'Bearer '+'x'.repeat(32));assert.equal(o.redirect,'error');return Response.json([{v:1}],{headers:{'X-Source-Timestamp':new Date(now-60000).toISOString()}});}};
 try{assert.deepEqual(await withReserve(async()=>[42],url,opts),[42]);assert.equal(calls,0);assert.deepEqual(await withReserve(async()=>{throw Error('source denied');},url,opts),[{v:1}]);assert.equal(calls,1);await assert.rejects(withReserve(async()=>{throw Error('original');},url,{...opts,fetchFn:async()=>new Response(null,{status:503})}),/original/);}finally{if(old===undefined)delete process.env.METEO_HUB_URL;else process.env.METEO_HUB_URL=old;if(ot===undefined)delete process.env.METEO_HUB_TOKEN;else process.env.METEO_HUB_TOKEN=ot;}
});
test('unconfigured hub preserves original error and never contacts network',async()=>{const old=process.env.METEO_HUB_URL;delete process.env.METEO_HUB_URL;try{await assert.rejects(withReserve(async()=>{throw Error('direct failure');},'https://example.test',{fetchFn:async()=>{throw Error('unexpected network');}}),/direct failure/);}finally{if(old!==undefined)process.env.METEO_HUB_URL=old;}});
