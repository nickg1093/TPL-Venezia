'use strict';
const BASE='https://dati.venezia.it/sites/default/files/dataset/opendata/';
const sources={
 'https://veporto.it/pwa-api/v1/meteo-station?limit=1000':'veporto',
 'https://www.autoritalaguna.it/operativita-m-o-s-e/':'mose',
 'https://www.comune.venezia.it/it/content/centro-previsioni-e-segnalazioni-maree-beta':'cpsm-web',
 'https://www.comune.venezia.it/sites/default/files/publicCPSM2/stazioni/temporeale/Punta_Salute.html':'cpsm-table',
 'https://www.venezia.isprambiente.it/dati/Dati2.xml':'ispra-level',
 'https://aviationweather.gov/api/data/metar?ids=LIPZ&format=json&hours=3':'metar',
 'https://aviationweather.gov/api/data/metar?ids=LIPZ&format=json&hours=48':'metar'
};
for(const key of ['livello','previsione','vento','pressione','tempacqua','umidita','temparia']){sources[BASE+key+'.json']=key;sources[BASE.replace('://dati.','://www.dati.')+key+'.json']=key;}
function hubFetch(url,options={},fetchFn=globalThis.fetch){
 const key=Object.hasOwn(sources,String(url))?sources[String(url)]:null;
 if(!key||!process.env.METEO_HUB_URL)return fetchFn(url,options);
 const base=new URL(process.env.METEO_HUB_URL);
 if(base.protocol!=='https:'||base.username||base.password||base.search||base.hash||base.pathname!=='/')throw Error('METEO_HUB_URL must be an HTTPS origin');
 if(options.method&&options.method!=='GET')throw Error('hub only supports GET');
 const headers=new Headers();const old=new Headers(options.headers||{});
 if(old.has('if-none-match'))headers.set('If-None-Match',old.get('if-none-match'));
 if(process.env.METEO_HUB_TOKEN)headers.set('Authorization','Bearer '+process.env.METEO_HUB_TOKEN);
 headers.set('Accept','*/*');
 return fetchFn(new URL('/api/v1/feeds/'+key,base).href,{headers,signal:options.signal||AbortSignal.timeout(8000),redirect:'error'});
}

module.exports={hubFetch};
