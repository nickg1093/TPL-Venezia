'use strict';
const http=require('node:http'),crypto=require('node:crypto');
const {createHub}=require('./core');
const {registry}=require('./registry');
const {retention}=require('./history');
async function main(){
 const enabled=(process.env.HUB_ENABLED_FEEDS||'').split(',').map(x=>x.trim()).filter(Boolean);
 const hub=await createHub({dir:process.env.HUB_STATE_DIR,enabled,contact:process.env.HUB_CONTACT_URL,veportoCredentials:process.env.HUB_VEPORTO_USERNAME?{username:process.env.HUB_VEPORTO_USERNAME,password:process.env.HUB_VEPORTO_PASSWORD||null}:undefined});
 const secret=process.env.HUB_READ_TOKEN||'';
 const digest=s=>crypto.createHash('sha256').update(s).digest();
 function send(res,status,body,type='application/json; charset=utf-8',headers={}){
   res.writeHead(status,{'Content-Type':type,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; frame-ancestors 'none'",...headers});res.end(body);
 }
 const server=http.createServer({maxHeaderSize:8192,requestTimeout:10000,headersTimeout:5000},(req,res)=>{
   if(req.method!=='GET')return send(res,405,'{"error":"method"}');
   if(req.url==='/healthz')return send(res,200,'{"ok":true}');
   if(secret&&!crypto.timingSafeEqual(digest(req.headers.authorization||''),digest('Bearer '+secret)))return send(res,401,'{"error":"unauthorized"}');
   if(req.url==='/api/v1/status')return send(res,200,JSON.stringify({version:1,feeds:hub.status()}));
   const u=new URL(req.url,'http://localhost');
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
 server.maxConnections=100;
 const timer=setInterval(()=>hub.tick().catch(e=>console.error('Hub poll:',e.message)),10000);
 server.listen(Number(process.env.PORT||8080),'0.0.0.0',()=>{console.log('Data Hub ready');void hub.tick().catch(e=>console.error('Hub poll:',e.message));});
 process.once('SIGTERM',()=>{clearInterval(timer);server.close(()=>void hub.close().finally(()=>process.exit(0)));});
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
