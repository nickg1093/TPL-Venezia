'use strict';
// Browser transport exclusively for the authorized MOSE public status page.
// No browser fallback after denial, no credential reuse, no challenge handling.
const URL='https://www.autoritalaguna.it/operativita-m-o-s-e/';
const ORIGIN=new globalThis.URL(URL).origin;
const MAX=3000000;
function allowed(request){
 try{
   const u=new globalThis.URL(request.url());
   return u.protocol==='https:'&&u.origin===ORIGIN&&!u.username&&!u.password&&request.method()==='GET'&&(!request.isNavigationRequest()||u.href===URL);
 }catch{return false;}
}
function denial(response){
 const status=response.status();
 return [401,403,429,503].includes(status)?{status,headers:{'Retry-After':response.headers()['retry-after']||''}}:null;
}
function asResponse(d){return new Response(null,d);}
async function extractTables(page){
 // Extract only relevant rendered table markup, not the entire web document.
 await page.waitForFunction(()=>[...document.querySelectorAll('table')].some(t=>/barriere/i.test(t.innerText)&&/stato/i.test(t.innerText)),undefined,{timeout:5000});
 const html=await page.evaluate(max=>{
   let out='';
   for(const t of document.querySelectorAll('table')){
     if(!/barriere|orario/i.test(t.innerText))continue;
     if(out.length+t.outerHTML.length>max)throw Error('table limit');
     out+=t.outerHTML+'\n';
   }
   return out;
 },MAX);
 if(!html||Buffer.byteLength(html)>MAX)throw Error('MOSE invalid table size');
 return html;
}
function createMoseBrowserFetch({launch=opts=>require('playwright').chromium.launch(opts)}={}){
 return async function readMose(url,options={}){
   if(String(url)!==URL||options.method&&options.method!=='GET')throw Error('browser source not allowed');
   const signal=options.signal;
   if(signal?.aborted)throw Error('browser request aborted');
   const userAgent=new Headers(options.headers).get('user-agent');
   if(!userAgent||!userAgent.startsWith('VeneziaMeteoMarineHub/'))throw Error('declared crawler identity required');
   let browser,context,blocked=null;
   const abort=()=>{void context?.close().catch(()=>{});};
   signal?.addEventListener('abort',abort,{once:true});
   try{
     browser=await launch({headless:true,chromiumSandbox:true,timeout:10000});
     if(signal?.aborted)throw Error('browser request aborted');
     context=await browser.newContext({userAgent,serviceWorkers:'block',acceptDownloads:false,ignoreHTTPSErrors:false});
     if(signal?.aborted)throw Error('browser request aborted');
     await context.route('**/*',route=>blocked||!allowed(route.request())?route.abort():route.continue());
     await context.routeWebSocket('**/*',ws=>ws.close());
     const page=await context.newPage();
     page.on('response',response=>{try{if(new globalThis.URL(response.url()).origin===ORIGIN)blocked=blocked||denial(response);}catch{}});
     let response;
     try{response=await page.goto(URL,{waitUntil:'domcontentloaded',timeout:10000});}
     catch(e){if(blocked)return asResponse(blocked);throw e;}
     if(blocked)return asResponse(blocked);
     if(!response||page.url()!==URL)throw Error('unexpected MOSE navigation');
     if(!response.ok())return new Response(null,{status:response.status()});
     // Explicit challenge or denial page is never interacted with.
     const title=await page.title();
     if(/access denied|request blocked|captcha|security check/i.test(title))return new Response(null,{status:403});
     let body;
     try{body=await extractTables(page);}
     catch(e){if(blocked)return asResponse(blocked);throw e;}
     if(blocked)return asResponse(blocked);
     if(signal?.aborted||page.url()!==URL)throw Error('browser navigation aborted or changed');
     return new Response(body,{status:200,headers:{'Content-Type':'text/html; charset=utf-8'}});
   }finally{
     signal?.removeEventListener('abort',abort);
     if(context)await context.close().catch(()=>{});
     if(browser)await browser.close().catch(()=>{});
   }
 };
}
module.exports={createMoseBrowserFetch,extractTables,allowed,URL};
