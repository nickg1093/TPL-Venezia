'use strict';
const http=require('node:http'),crypto=require('node:crypto');
const {createHub}=require('./core');
const {registry}=require('./registry');
const {retention}=require('./history');
const {createBrowserEngine,assertEligible}=require('./browser-engine');
async function main(){
 const enabled=(process.env.HUB_ENABLED_FEEDS||'').split(',').map(x=>x.trim()).filter(Boolean);
 const secret=process.env.HUB_READ_TOKEN||'';
 if(enabled.length&&secret.length<32)throw Error('HUB_READ_TOKEN must contain at least 32 characters when feeds are enabled');
 assertEligible(enabled);
 const hub=await createHub({acquire:createBrowserEngine(),dir:process.env.HUB_STATE_DIR,enabled,contact:process.env.HUB_CONTACT_URL});
 const digest=s=>crypto.createHash('sha256').update(s).digest();
 function send(res,status,body,type='application/json; charset=utf-8',headers={}){
   res.writeHead(status,{'Content-Type':type,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; frame-ancestors 'none'",...headers});res.end(body);
 }
 let windowStart=Date.now(),requests=0,stopping=false;
 const server=http.createServer({maxHeaderSize:8192,requestTimeout:10000,headersTimeout:5000},(req,res)=>{
   const now=Date.now();if(now-windowStart>=60000){windowStart=now;requests=0;}
   if(++requests>600)return send(res,429,'{"error":"rate limit"}',undefined,{'Retry-After':String(Math.max(1,Math.ceil((60000-(now-windowStart))/1000)))});
   if(stopping)return send(res,503,'{"error":"shutting down"}');
   if(req.method!=='GET')return send(res,405,'{"error":"method"}');
   if(req.url==='/healthz')return send(res,200,'{"ok":true}');
   if(req.url==='/about')return send(res,200,'Venezia MeteoMarine Data Hub — progetto indipendente, non ufficiale, senza scopo di lucro. Acquisisce esclusivamente fonti abilitate e autorizzate. Dati non validati: non sostituiscono le comunicazioni ufficiali. Contatto: '+(process.env.HUB_CONTACT_URL||'da configurare'),'text/plain; charset=utf-8');
   if(secret&&!crypto.timingSafeEqual(digest(req.headers.authorization||''),digest('Bearer '+secret)))return send(res,401,'{"error":"unauthorized"}');
   if(req.url==='/api/v1/status')return send(res,200,JSON.stringify({version:1,feeds:hub.status()}));
   let u;try{u=new URL(req.url,'http://localhost');}catch{return send(res,400,'{"error":"invalid URL"}');}
   const hm=/^\/api\/v1\/history\/([a-z-]+)$/.exec(u.pathname);
   if(hm&&Object.hasOwn(registry,hm[1])){
     const now=Date.now(),key=hm[1],from=Number(u.searchParams.get('from')||now-retention(key)),to=Number(u.searchParams.get('to')||now),limit=Number(u.searchParams.get('limit')||200),station=u.searchParams.get('station')||'';
     if(!Number.isSafeInteger(from)||!Number.isSafeInteger(to)||from>to||from<now-retention(key)-60000||to>now+300000||!Number.isInteger(limit)||limit<1||limit>500||station.length>100)return send(res,400,'{"error":"invalid range"}');
     return send(res,200,JSON.stringify({feed:key,...hub.history(key,from,to,limit,station)}));
   }
   const m=/^\/api\/v1\/feeds\/([a-z-]+)$/.exec(req.url);
   if(!m)return send(res,404,'{"error":"not found"}');
   const data=hub.get(m[1]);if(!data)return send(res,503,'{"error":"no valid source snapshot"}');
   const etag='"'+data.hash+'"', headers={'ETag':etag,'X-Source-Timestamp':new Date(data.stamp).toISOString(),'X-Source-Checked-At':new Date(data.confirmedAt).toISOString()};
   if(req.headers['if-none-match']===etag)return send(res,304,'',undefined,headers);
   // HTML/XML served as inert text, never executable browser documents.
   return send(res,200,data.body,data.format==='json'?'application/json; charset=utf-8':'text/plain; charset=utf-8',headers);
 });
 server.maxConnections=100;server.maxRequestsPerSocket=100;server.keepAliveTimeout=5000;
 const timer=setInterval(()=>hub.tick().catch(e=>console.error('Hub poll:',e.message)),10000);
 server.listen(Number(process.env.PORT||8080),'0.0.0.0',()=>{console.log('Data Hub ready');void hub.tick().catch(e=>console.error('Hub poll:',e.message));});
 function shutdown(){if(stopping)return;stopping=true;clearInterval(timer);server.close(()=>void hub.close().then(()=>process.exit(0)).catch(()=>process.exit(1)));}
 process.once('SIGTERM',shutdown);process.once('SIGINT',shutdown);
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
