'use strict';
// Browser-only acquisition of independently authorized sources.
// Previously blocked publishers remain suspended until their access path is resolved.
const {registry}=require('./registry');
const {createMoseBrowserFetch}=require('./mose-browser');
const eligible=Object.freeze(['mose','ispra-level','metar']);
function assertEligible(keys){
 for(const key of keys)if(!eligible.includes(key))throw Error('Source suspended pending access resolution: '+key);
}
function createBrowserEngine({launch=opts=>require('playwright').chromium.launch(opts)}={}){
 const readMose=createMoseBrowserFetch({launch});
 return async function acquire(key,options={}){
   assertEligible([key]);
   const f=registry[key];
   if(key==='mose')return readMose(f.url,options);
   const userAgent=new Headers(options.headers).get('user-agent');
   if(!userAgent||!userAgent.startsWith('VeneziaMeteoMarineHub/'))throw Error('declared crawler identity required');
   const signal=options.signal;
   if(signal?.aborted)throw Error('browser request aborted');
   let browser,context,denied=null,redirected=false;
   const abort=()=>{void context?.close().catch(()=>{});};
   signal?.addEventListener('abort',abort,{once:true});
   try{
     browser=await launch({headless:true,chromiumSandbox:true,timeout:10000});
     if(signal?.aborted)throw Error('browser request aborted');
     context=await browser.newContext({userAgent,javaScriptEnabled:false,serviceWorkers:'block',acceptDownloads:false,ignoreHTTPSErrors:false});
     if(signal?.aborted)throw Error('browser request aborted');
     await context.route('**/*',route=>{
       const req=route.request();
       return !denied&&!redirected&&req.url()===f.url&&req.method()==='GET'&&req.isNavigationRequest()?route.continue():route.abort();
     });
     await context.routeWebSocket('**/*',ws=>ws.close());
     const page=await context.newPage();
     page.on('response',res=>{
       if(res.url()!==f.url)return;
       const status=res.status();
       if([401,403,429,503].includes(status))denied={status,headers:{'Retry-After':res.headers()['retry-after']||''}};
       else if(status>=300&&status<400)redirected=true;
     });
     let response;
     try{response=await page.goto(f.url,{waitUntil:'domcontentloaded',timeout:10000});}
     catch(e){if(denied)return new Response(null,denied);throw e;}
     if(denied)return new Response(null,denied);
     if(redirected||!response||page.url()!==f.url)throw Error('unexpected navigation');
     const status=response.status();
     if(!response.ok())return new Response(null,{status,headers:{'Retry-After':response.headers()['retry-after']||''}});
     const h=response.headers(),type=h['content-type']||'';
     if(f.format==='json'?!/json/i.test(type):!/xml/i.test(type))return new Response(null,{status:403});
     if(Number(h['content-length'])>f.maxBytes)throw Error('body too large');
     const body=await response.body();
     if(signal?.aborted||body.byteLength>f.maxBytes)throw Error('invalid body size or deadline');
     return new Response(body,{status:200,headers:{'Content-Type':type}});
   }finally{
     signal?.removeEventListener('abort',abort);
     if(context)await context.close().catch(()=>{});
     if(browser)await browser.close().catch(()=>{});
   }
 };
}
module.exports={createBrowserEngine,assertEligible,eligible};
