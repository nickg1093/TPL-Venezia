const {parseWebForecast,URL:CPSM_URL}=require('../cpsm-web-forecast');
const ua='VeneziaTPL/1.0 (+https://veneziatpl.onrender.com/about-data.html)';
async function read(url){
 const r=await fetch(url,{headers:{'User-Agent':ua,Accept:'text/html'},signal:AbortSignal.timeout(12000),redirect:'error'});
 console.log('HTTP',r.status,new URL(url).hostname,r.headers.get('content-type'));
 if(!r.ok){await r.body?.cancel();return null;}
 if(Number(r.headers.get('content-length'))>1500000||!r.body){await r.body?.cancel();throw Error('response too large');}
 const rd=r.body.getReader(), chunks=[];let n=0,done=false;
 try{for(;;){const c=await rd.read();if(c.done){done=true;break;}n+=c.value.byteLength;if(n>1500000)throw Error('response too large');chunks.push(c.value);}}
 finally{if(!done)await rd.cancel().catch(()=>{});rd.releaseLock();}
 return Buffer.concat(chunks,n).toString('utf8');
}
(async()=>{
 try{const html=await read(CPSM_URL);if(html){const text=html.replace(/<!--[^]*?-->/g,' ').replace(/<(script|style|template)\b[^>]*>[^]*?<\/\1\s*>/gi,' ').replace(/<[^>]*>/g,' ').replace(/&(?:nbsp|#160|#xA0);/gi,' ').replace(/\s+/g,' ');console.log('CPSM issue header candidates:',[...text.matchAll(/Previsione delle ore[^]{0,100}/gi)].map(x=>x[0]).slice(0,5));const ix=text.indexOf('Valori di marea massimi e minimi previsti');if(ix>=0)console.log('CPSM text block:',text.slice(ix,ix+950));const x=parseWebForecast(html);console.log('CPSM public forecast valid:',new Date(x.issue).toISOString(),'extrema:',x.rows.length,'coverage:',x.rows.at(-1).DATA_ESTREMALE);}}
 catch(e){console.log('CPSM diagnostic:',String(e.message).slice(0,200));}
 try{const html=await read('https://www.venezia.isprambiente.it/');if(!html)return;
 const urls=[...html.matchAll(/(?:src|href)\s*=\s*["']([^"']+)["']/gi)].map(m=>{try{return new URL(m[1],'https://www.venezia.isprambiente.it/');}catch{return null;}}).filter(u=>u&&u.origin==='https://www.venezia.isprambiente.it'&&!u.search&&!u.hash);
 console.log('ISPRA public resource paths:',[...new Set(urls.filter(u=>/prev|boll|salut|marea|forecast|\.js$|\.xml$|\.json$|\.csv$|\.png$|\.jpe?g$/i.test(u.pathname)).map(u=>u.pathname))].slice(0,70));
 const clean=html.replace(/<!--[\s\S]*?-->/g,'').replace(/<(?:script|style)\b[^>]*>[\s\S]*?<\/(?:script|style)>/gi,'');
 const ix=clean.indexOf('icon_129.jpg');
 if(ix>=0)console.log('ISPRA station markup:',clean.slice(Math.max(0,ix-250),ix+1400).replace(/[\r\n]+/g,' ').replace(/[\x00-\x1f]/g,'').slice(0,1650));
 }catch(e){console.log('ISPRA diagnostic:',String(e.message).slice(0,200));}
})();