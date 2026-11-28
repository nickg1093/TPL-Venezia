'use strict';
const {DatabaseSync}=require('node:sqlite');
const path=require('node:path');
const tide=require('./parsers/tide'),meteo=require('./parsers/meteo'),web=require('./parsers/web-forecast'),mose=require('./parsers/mose');
const DAY=86400000;
function retention(key){return ['livello','ispra-level','cpsm-table'].includes(key)?30*DAY:['previsione','cpsm-web','mose'].includes(key)?7*DAY:2*DAY;}
function records(key,body,stamp,now){
 const rec=(id,t,data)=>({id:String(id),t:t==null?NaN:Number(t),data});
 if(key==='livello')return tide.parseLevels(JSON.parse(body)).filter(x=>x.cm!==null).map(x=>rec(x.id,x.ts,{cm:x.cm,station:x.name}));
 if(key==='ispra-level'){const p=tide.parseIspra(body,now);return p?[rec(p.id,p.ts,{cm:p.cm,station:p.name})]:[];}
 if(key==='cpsm-table')return [...body.matchAll(/<td\b[^>]*>\s*(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\s*<\/td>\s*<td\b[^>]*>\s*(-?\d+(?:[.,]\d+)?)\s*<\/td>/gi)].map(m=>rec('Punta Salute',tide.solarToMs(m[1]),{cm:Math.round(Number(m[2].replace(',','.'))*100)})).filter(r=>Math.abs(r.data.cm)<=300);
 if(key==='previsione')return [rec('bulletin',stamp,{extremes:tide.parseForecast(JSON.parse(body))})];
 if(key==='cpsm-web')return [rec('bulletin',stamp,{extremes:web.parseWebForecast(body,now).rows})];
 if(key==='mose')return [rec('barriers',stamp,mose.parse(body))];
 const rows=JSON.parse(body);
 if(key==='veporto')return meteo.parseVeporto(rows).filter(x=>x.valore!==null).map(x=>rec(x.idStazione,x.misuratoMs,x));
 if(key==='metar')return rows.filter(x=>x?.icaoId==='LIPZ'&&typeof x.rawOb==='string').map(x=>rec('LIPZ',typeof x.obsTime==='number'?x.obsTime*1000:Date.parse(x.obsTime),{rawOb:x.rawOb}));
 return meteo.parseCpsm(key,rows).filter(x=>x.valore!==null).map(x=>rec(x.idStazione,x.misuratoMs,x));
}
function openHistory(dir){
 const db=new DatabaseSync(path.join(dir,'history-v1.sqlite'));
 db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS observations(feed TEXT NOT NULL, station TEXT NOT NULL, stamp INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(feed,station,stamp)) WITHOUT ROWID; CREATE INDEX IF NOT EXISTS observations_time ON observations(feed,stamp);');
 const put=db.prepare('INSERT INTO observations(feed,station,stamp,data) VALUES(?,?,?,?) ON CONFLICT(feed,station,stamp) DO UPDATE SET data=excluded.data WHERE data<>excluded.data');
 function record(key,body,stamp,now){
  const rs=records(key,body,stamp,now).filter(x=>Number.isSafeInteger(x.t)&&x.t>=now-retention(key)&&x.t<=now+300000&&x.data);
  db.exec('BEGIN IMMEDIATE');
  try{for(const x of rs){const data=JSON.stringify(x.data);if(Buffer.byteLength(data)<=64000)put.run(key,x.id.slice(0,100),x.t,data);}db.exec('COMMIT');}
  catch(e){db.exec('ROLLBACK');throw e;}
 }
 function prune(keys,now){const del=db.prepare('DELETE FROM observations WHERE feed=? AND stamp<?');for(const key of keys)del.run(key,now-retention(key));}
 function read(key,from,to,limit,afterStation=''){
  const rows=db.prepare('SELECT station,stamp,data FROM observations WHERE feed=? AND (stamp>? OR (stamp=? AND station>?)) AND stamp<=? ORDER BY stamp,station LIMIT ?').all(key,from,from,afterStation,to,limit+1);
  let bytes=0;const items=[];
  for(const row of rows.slice(0,limit)){bytes+=Buffer.byteLength(row.data);if(bytes>800000)break;items.push({station:row.station,timestamp:row.stamp,data:JSON.parse(row.data)});}
  return {items,next:rows.length>items.length&&items.length?{from:items.at(-1).timestamp,station:items.at(-1).station}:null};
 }
 return {record,read,prune,close:()=>db.close()};
}
module.exports={openHistory,retention};
