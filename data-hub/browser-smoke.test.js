'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {chromium}=require('playwright');
const {extractTables}=require('./mose-browser');
const {validate}=require('./core');
test('real sandboxed Chromium renders fixture and extracts only MOSE table',async()=>{
 const browser=await chromium.launch({headless:true,chromiumSandbox:true,timeout:15000});
 try{const ctx=await browser.newContext({serviceWorkers:'block',acceptDownloads:false});await ctx.route('**/*',r=>r.abort());await ctx.routeWebSocket('**/*',ws=>ws.close());
 const page=await ctx.newPage();
 await page.setContent('<main><p>unrelated</p><table><thead><tr><th>Bocche di porto</th><th>Barriere</th><th>Stato</th></tr></thead><tbody>'+['Lido 1','Lido 2','Malamocco','Chioggia'].map(k=>'<tr><td>'+k+'</td><td>'+k+'</td><td>Paratoie in recesso</td></tr>').join('')+'</tbody></table></main>');
 const html=await extractTables(page);assert.ok(!html.includes('unrelated'));assert.ok(html.includes('Chioggia'));assert.equal(validate('mose',html,100000),100000);await ctx.close();
 }finally{await browser.close();}
});
