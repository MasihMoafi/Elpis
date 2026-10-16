const { controlValue } = require("./controls.cjs");
// Browser contracts for the actual static app; fixtures never run model calls.
const {test,before,after}=require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http');
const fs=require('node:fs/promises');
const path=require('node:path');
const {chromium}=require(process.env.ELPIS_PLAYWRIGHT_PACKAGE||'playwright');
let browser,server,url,reconnectFixture;const clients=new Set();
before(async()=>{
 server=http.createServer(async(req,res)=>{
  const route=new URL(req.url,'http://local').pathname;
  if(route==='/api/events'){res.writeHead(200,{'content-type':'text/event-stream'});res.write('event: connection\ndata: {"connected":true}\n\n');clients.add(res);req.on('close',()=>clients.delete(res));return;}
  if(reconnectFixture&&route.startsWith('/api/')){
   const f=reconnectFixture;f.calls.push({route,method:req.method});
   let data={data:[],nextCursor:null};
   if(route==='/api/health')data={connected:true};
   if(route==='/api/settings')data={main:{model:'fixture-model',provider:'fixture'},providers:[]};
   if(route==='/api/threads')data={data:[f.thread],nextCursor:null};
   if(route==='/api/threads/reconnect')data={thread:f.thread,data:[{turnId:'turn',item:{id:'reply',type:'agentMessage',text:f.reply}}],nextCursor:null};
   if(route==='/api/threads/reconnect/resume')data={thread:f.thread,activeTurnId:null};
   if(route==='/api/threads/reconnect/turns'){res.writeHead(503,{'content-type':'application/json'});res.end(JSON.stringify({error:{message:'Delivery is unknown. Review the history.'}}));return;}
   res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(data));return;
  }
  if(route.startsWith('/api/')){res.setHeader('content-type','application/json');res.end(JSON.stringify(route==='/api/health'?{connected:true}:{data:[],nextCursor:null}));return;}
  try{const file=path.join(__dirname,'../out',route==='/'?'index.html':route);res.setHeader('content-type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':file.endsWith('.svg')?'image/svg+xml':'text/html');res.end(await fs.readFile(file));}catch{res.statusCode=404;res.end();}
 });await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));url=`http://127.0.0.1:${server.address().port}`;
 browser=await chromium.launch({executablePath:process.env.ELPIS_CHROMIUM||undefined,headless:true});
});
after(async()=>{await browser?.close();for(const client of clients)client.end();await new Promise(resolve=>server.close(resolve));});
test('connection recovery preserves draft and delivery error, clears stale approvals and reloads history',async()=>{
 reconnectFixture={thread:{id:'reconnect',name:'Reconnect conversation',model:'fixture-model',modelProvider:'fixture',status:{type:'idle'},desktopAccess:{writable:true}},reply:'Before reconnect',calls:[]};
 const page=await browser.newPage({viewport:{width:1440,height:1000}});page.setDefaultTimeout(5000);
 const event=(name,data)=>{for(const client of clients)client.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);};
 try{
  await page.goto(url);await page.locator('.thread-link').filter({hasText:'Reconnect conversation'}).click();
  await page.getByText('Before reconnect',{exact:true}).waitFor();
  await page.getByLabel('Message Elpis',{exact:true}).fill('Keep this draft');
  await page.getByRole('button',{name:'Send message',exact:true}).click();
  await page.getByRole('alert').filter({hasText:'Delivery is unknown'}).waitFor();
  event('approval',{id:'stale',params:{threadId:'reconnect',reason:'Stale approval',availableDecisions:['accept']}});
  await page.getByText('Stale approval',{exact:true}).waitFor();
  event('connection',{connected:false});
  await page.getByRole('status').filter({hasText:'Reconnecting to Elpis'}).waitFor();
  assert.equal(await page.getByLabel('Message Elpis',{exact:true}).isDisabled(),true);
  assert.equal(await page.getByText('Stale approval',{exact:true}).count(),0);
  reconnectFixture.reply='Recovered history';const calls=reconnectFixture.calls.length;
  event('connection',{connected:true});
  await page.getByText('Recovered history',{exact:true}).waitFor();
  await page.waitForFunction(()=>!document.querySelector('textarea[aria-label="Message Elpis"]').disabled);
  assert.equal(await controlValue(page.getByLabel('Message Elpis',{exact:true})),'Keep this draft');
  assert.equal(await page.getByRole('alert').filter({hasText:'Delivery is unknown'}).count(),1);
  await new Promise(resolve=>setTimeout(resolve,100));
  const refreshed=reconnectFixture.calls.slice(calls).map(call=>call.route);
  for(const route of ['/api/threads','/api/models','/api/settings','/api/threads/reconnect','/api/threads/reconnect/resume'])assert(refreshed.includes(route),route);
  assert.equal(reconnectFixture.calls.filter(call=>call.route==='/api/threads/reconnect/turns').length,1,'unknown delivery is never replayed');
 }finally{await page.close();reconnectFixture=null;}
});
