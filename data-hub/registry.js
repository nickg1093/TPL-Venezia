'use strict';
const base='https://dati.venezia.it/sites/default/files/dataset/opendata/';
const registry=Object.freeze({
 ...Object.fromEntries(['livello','previsione','vento','pressione','tempacqua','umidita','temparia'].map(k=>[k,{url:base+k+'.json',group:'cpsm',format:'json',interval:k==='previsione'?300000:300000,maxAge:k==='previsione'?259200000:1500000,maxBytes:k==='livello'||k==='previsione'?1000000:200000}])),
 'cpsm-web':{url:'https://www.comune.venezia.it/it/content/centro-previsioni-e-segnalazioni-maree-beta',group:'cpsm-web',format:'html',interval:300000,maxAge:259200000,maxBytes:1500000},
 'cpsm-table':{url:'https://www.comune.venezia.it/sites/default/files/publicCPSM2/stazioni/temporeale/Punta_Salute.html',group:'cpsm-web',format:'html',interval:300000,maxAge:1200000,maxBytes:1000000},
 'ispra-level':{url:'https://www.venezia.isprambiente.it/dati/Dati2.xml',group:'ispra',format:'xml',interval:300000,maxAge:2100000,maxBytes:2000000},
 'veporto':{url:'https://veporto.it/pwa-api/v1/meteo-station?limit=1000',group:'veporto',format:'json',interval:300000,maxAge:1500000,maxBytes:256000},
 'mose':{url:'https://www.autoritalaguna.it/operativita-m-o-s-e/',group:'mose',format:'html',interval:300000,maxAge:2700000,maxBytes:3000000},
 'metar':{url:'https://aviationweather.gov/api/data/metar?ids=LIPZ&format=json&hours=48',group:'metar',format:'json',interval:300000,maxAge:6000000,maxBytes:200000}
});
function keyFor(url){
 const s=String(url);
 if(s===registry.metar.url.replace('hours=48','hours=3'))return 'metar';
 for(const [key,f] of Object.entries(registry))if(s===f.url)return key;
 if(s.startsWith(base.replace('://dati.','://www.dati.')))return keyFor(s.replace('://www.dati.','://dati.'));
 return null;
}
module.exports={registry,keyFor};
