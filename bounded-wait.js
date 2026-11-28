'use strict';
// A caller can stop waiting without cancelling the shared background collector.
async function boundedWait(promise,ms){
 let timer;
 try{return await Promise.race([Promise.resolve(promise),new Promise(resolve=>{timer=setTimeout(()=>resolve(undefined),ms);})]);}
 finally{clearTimeout(timer);}
}
module.exports={boundedWait};
