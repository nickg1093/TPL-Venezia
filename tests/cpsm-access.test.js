const test=require('node:test'),assert=require('node:assert/strict');
const {createSourceGate}=require('../cpsm-access');
test('shared pause, Retry-After seconds/date, queued feeds never reach a blocked source',async()=>{
 let time=1000000, calls=0;
 const gate=createSourceGate({now:()=>time,gapMs:0});
 const denied=gate.run(async check=>{calls++;return check(new Response(null,{status:429,headers:{'Retry-After':'900'}}));});
 const queued=gate.run(async()=>{calls++;});
 await assert.rejects(denied,/pausa/); await assert.rejects(queued,/pausa/);
 assert.equal(calls,1); assert.equal(gate.state.until,time+900000);
 time+=900000;
 await assert.rejects(gate.run(check=>check(new Response(null,{status:403,headers:{'Retry-After':new Date(time+3600000).toUTCString()}}))),/pausa/);
 assert.equal(gate.state.until,time+3600000);
 time+=3600000; await gate.run(async()=>true); assert.equal(gate.state.until,0);
});
test('requests are serialized, spaced, and tide goes before queued weather',async()=>{
 let time=1000; const order=[];
 const gate=createSourceGate({now:()=>time,gapMs:10000,sleep:async ms=>{time+=ms;}});
 let release; const wait=new Promise(r=>release=r);
 const a=gate.run(async()=>{order.push(['first',time]);await wait;});
 const b=gate.run(async()=>order.push(['weather',time]),2);
 const c=gate.run(async()=>order.push(['tide',time]),0);
 release();await Promise.all([a,b,c]);
 assert.deepEqual(order,[['first',1000],['tide',11000],['weather',21000]]);
});
