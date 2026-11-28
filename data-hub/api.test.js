'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),{spawn}=require('node:child_process'),net=require('node:net');
test('standalone HTTP API: authentication, health, history bounds and no arbitrary proxy',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'hub-api-'));
 const probe=net.createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));
 const token='test-token-'+'x'.repeat(40);
 const child=spawn(process.execPath,[path.join(__dirname,'server.js')],{env:{...process.env,HUB_STATE_DIR:dir,HUB_ENABLED_FEEDS:'',HUB_READ_TOKEN:token,PORT:String(port)},stdio:['ignore','pipe','pipe']});
 try{
  await new Promise((resolve,reject)=>{let buf='';const timer=setTimeout(()=>reject(Error('server not ready')),8000);child.stdout.on('data',d=>{buf+=d.toString();if(buf.includes('Data Hub ready')){clearTimeout(timer);resolve();}});child.once('exit',code=>{clearTimeout(timer);reject(Error('server exit '+code));});});
  const base='http://127.0.0.1:'+port,headers={Authorization:'Bearer '+token};
  assert.equal((await fetch(base+'/healthz')).status,200);
  assert.equal((await fetch(base+'/api/v1/status')).status,401);
  assert.equal((await fetch(base+'/api/v1/status',{headers})).status,200);
  assert.equal((await fetch(base+'/api/v1/feeds/livello',{headers})).status,503);
  assert.equal((await fetch(base+'/api/v1/history/livello?limit=99999',{headers})).status,400);
  assert.equal((await fetch(base+'/api/v1/history/livello',{headers})).status,200);
  assert.equal((await fetch(base+'/api/v1/feeds/arbitrary?url=https://example.com',{headers})).status,404);
  assert.equal((await fetch(base+'/api/v1/status',{method:'POST',headers})).status,405);
 }finally{child.kill('SIGTERM');await new Promise(r=>{if(child.exitCode!==null)r();else child.once('exit',r);});await fs.rm(dir,{recursive:true,force:true});}
});
