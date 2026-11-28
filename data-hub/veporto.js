'use strict';
// Credentials are supplied by the operator only after permission is confirmed.
function createVeportoFetch({fetchFn,now,credentials}){
 let jwt=null,expires=0;
 const root='https://veporto.it/pwa-api/v1';
 async function login(headers){
  if(jwt&&expires>now()+60000)return null;
  if(!credentials?.username)throw Error('vePORTO credentials not configured');
  const r=await fetchFn(root+'/auth',{method:'POST',headers:{Accept:'application/json','Content-Type':'application/json','User-Agent':headers['User-Agent']},body:JSON.stringify(credentials),signal:AbortSignal.timeout(12000),redirect:'error'});
  if(!r.ok)return r;
  const token=(r.headers.get('authorization')||'').replace(/^Bearer\s+/i,'');
  await r.body?.cancel().catch(()=>{});
  if(!/^[\w-]+\.[\w-]+\.[\w-]+$/.test(token)||token.length>8192)throw Error('vePORTO invalid token');
  let exp;try{exp=JSON.parse(Buffer.from(token.split('.')[1],'base64url').toString('utf8')).exp;}catch{throw Error('vePORTO invalid expiry');}
  expires=Math.min(now()+13*60000,Number.isFinite(exp)?exp*1000-30000:Infinity);
  if(expires<=now())throw Error('vePORTO expired token');
  jwt=token;return null;
 }
 return async(url,opts)=>{
  const denied=await login(opts.headers);if(denied)return denied;
  let r=await fetchFn(url,{...opts,headers:{...opts.headers,Authorization:'Bearer '+jwt}});
  if(r.status===401){
    await r.body?.cancel().catch(()=>{});jwt=null;expires=0;
    const rejected=await login(opts.headers);if(rejected)return rejected;
    r=await fetchFn(url,{...opts,headers:{...opts.headers,Authorization:'Bearer '+jwt}});
  }
  return r;
 };
}
module.exports={createVeportoFetch};
