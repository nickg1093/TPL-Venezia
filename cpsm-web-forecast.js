'use strict';
// Public, human-readable CPSM bulletin. Only parse the visible dated extrema list.
// Do not use the debugging array, images, or astronomic-only forecasts.
const URL='https://www.comune.venezia.it/it/content/centro-previsioni-e-segnalazioni-maree-beta';
const LICENSE_URL='https://creativecommons.org/licenses/by-nc-sa/3.0/it/';
const MONTHS='gennaio febbraio marzo aprile maggio giugno luglio agosto settembre ottobre novembre dicembre'.split(' ');
const monthPattern=MONTHS.join('|');
const formatter=new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Rome',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});
const pad=n=>String(n).padStart(2,'0');
function localStamp(year,month,day,hm) {
  if(!/^(?:[01]?\d|2[0-3]):[0-5]\d$/.test(hm))return null;
  const [h,m]=hm.split(':').map(Number);
  const local=year+'-'+pad(month)+'-'+pad(day)+' '+pad(h)+':'+pad(m)+':00';
  const iso=local.replace(' ','T');
  const candidates=[1,2].map(offset=>new Date(iso+'+0'+offset+':00')).filter(d=>Number.isFinite(+d)&&formatter.format(d)===local);
  return candidates.length===1 ? +candidates[0] : null;
}
function visibleText(html) {
  return String(html).replace(/<!--[\s\S]*?-->/g,' ').replace(/<(script|style|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,' ')
    .replace(/<[^>]*>/g,' ').replace(/&(?:nbsp|#160|#xA0);/gi,' ').replace(/&(?:minus|#8722|#x2212);/gi,'-')
    .replace(/\u2212/g,'-').replace(/\s+/g,' ').trim();
}
function parseWebForecast(html,now=Date.now()) {
  const text=visibleText(html);
  if(!/Centro Previsioni e Segnalazioni Maree/i.test(text)||!/zero mareografico di punta salute/i.test(text))throw Error('Bollettino CPSM: riferimento non riconosciuto');
  const start=/Previsione delle ore\s+(\d{1,2}:\d{2})\s+del giorno\s+(\d{1,2})\s+([a-z]+)(?:\s+(\d{4}))?/i.exec(text);
  if(!start)throw Error('Bollettino CPSM: emissione assente');
  const month=MONTHS.indexOf(start[3].toLowerCase())+1, currentYear=Number(formatter.format(new Date(now)).slice(0,4));
  const years=start[4]?[Number(start[4])]:[currentYear-1,currentYear,currentYear+1];
  const issues=years.map(y=>({y,t:localStamp(y,month,Number(start[2]),start[1])})).filter(x=>x.t!==null&&x.t<=now+300000&&x.t>=now-72*3600000);
  if(issues.length!==1)throw Error('Bollettino CPSM: emissione non recente o ambigua');
  const issue=issues[0].t, year=issues[0].y;
  const tail=text.slice(start.index+start[0].length);
  const block=/Valori di marea massimi e minimi previsti\s+([\s\S]*?)\s+Prossimo aggiornamento/i.exec(tail);
  if(!block)throw Error('Bollettino CPSM: elenco estremali assente');
  const datePattern=new RegExp('\\b(\\d{1,2})\\s+('+monthPattern+')\\b','gi');
  const days=[...block[1].matchAll(datePattern)],rows=[];
  if(!days.length||block[1].slice(0,days[0].index).trim())throw Error('Bollettino CPSM: giorni non riconosciuti');
  let previous=-Infinity;
  for(let i=0;i<days.length;i++){
    const d=days[i], day=Number(d[1]), mo=MONTHS.indexOf(d[2].toLowerCase())+1;
    const part=block[1].slice(d.index+d[0].length,days[i+1]?.index??block[1].length).trim();
    const rowPattern=/ore\s+(\d{1,2}:\d{2})\s*,\s*(massimo|minimo)\s*,\s*([+-]?\s*\d+(?:[.,]\d+)?)\s*cm\s*\.?/gi;
    const matches=[...part.matchAll(rowPattern)];
    if(!matches.length||part.replace(rowPattern,'').trim())throw Error('Bollettino CPSM: estremali incompleti');
    for(const row of matches){
      const candidates=[year-1,year,year+1].map(y=>localStamp(y,mo,day,row[1])).filter(t=>t!==null&&t>=issue-24*3600000&&t<=issue+96*3600000);
      const value=Number(row[3].replace(/\s/g,'').replace(',','.'));
      if(candidates.length!==1||!Number.isFinite(value)||Math.abs(value)>300||candidates[0]<=previous)throw Error('Bollettino CPSM: estremo non valido o ambiguo');
      previous=candidates[0];
      rows.push({DATA_PREVISIONE:new Date(issue).toISOString(),DATA_ESTREMALE:new Date(previous).toISOString(),VALORE:value,TIPO_ESTREMALE:row[2].toLowerCase()==='massimo'?'max':'min',FORECAST_SOURCE:'cpsm-web'});
    }
  }
  if(rows.length<2||!rows.some(x=>Date.parse(x.DATA_ESTREMALE)>now))throw Error('Bollettino CPSM: nessun estremo futuro');
  return {issue,rows};
}
async function boundedHtml(response) {
  const max=1_500_000;
  if(Number(response.headers?.get?.('content-length'))>max||!response.body){try{await response.body?.cancel();}catch{}throw Error('Bollettino CPSM: risposta non valida o eccessiva');}
  const reader=response.body.getReader(), chunks=[];let size=0,complete=false;
  try { for(;;){const {done,value}=await reader.read();if(done){complete=true;break;}size+=value.byteLength;if(size>max)throw Error('Bollettino CPSM: risposta eccessiva');chunks.push(value);} }
  finally {if(!complete)await reader.cancel().catch(()=>{});reader.releaseLock();}
  return Buffer.concat(chunks,size).toString('utf8');
}
function createWebForecastReader({gate,userAgent,now=()=>Date.now(),fetchFn=(...args)=>fetch(...args)}){
  let pending=null,last=null,nextAt=-Infinity;
  return function read(){
    if(process.env.CPSM_WEB_FORECAST_ENABLED==='false')return Promise.reject(Error('Bollettino web disattivato'));
    const time=now();
    if(pending)return pending;
    if(time<nextAt){
      if(last&&time-last.issue<=72*3600000&&last.rows.some(x=>Date.parse(x.DATA_ESTREMALE)>time))return Promise.resolve(last);
      return Promise.reject(Error('Bollettino CPSM: prossimo controllo non ancora previsto'));
    }
    pending=gate.run(async check=>{
      const response=await check(await fetchFn(URL,{headers:{Accept:'text/html','User-Agent':userAgent},signal:AbortSignal.timeout(10000),redirect:'error'}));
      if(!response.ok){try{await response.body?.cancel();}catch{}throw Error('Bollettino CPSM HTTP '+response.status);}
      const parsed=parseWebForecast(await boundedHtml(response),now());
      if(last&&parsed.issue<last.issue)throw Error('Bollettino CPSM: emissione precedente');
      last=parsed;return parsed;
    },1).finally(()=>{nextAt=now()+5*60000;pending=null;});
    return pending;
  };
}

module.exports={URL,LICENSE_URL,parseWebForecast,createWebForecastReader};
