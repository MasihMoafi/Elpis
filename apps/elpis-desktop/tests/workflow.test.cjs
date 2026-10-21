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

// A125: a lost event stream can miss the end of any open chat, including a chat outside the list's first page.
const { fixture } = require('./parity-fixture.cjs');
const { controlValue: draftValue } = require('./controls.cjs');
async function reconnectChats(run, colorScheme = 'light') {
 const threads=['chat-a','chat-b','chat-c'].map((id,index)=>({id,name:`Recovery ${index+1}`,model:'sol',modelProvider:'openai',status:{type:'active'},desktopAccess:{writable:true}}));
 const turns=new Map(threads.map(thread=>[thread.id,`turn-${thread.id}`])),reads=[],routes={};
 let recovered=false;
 for(const thread of threads){
  routes[`/api/threads/${thread.id}/resume`]=()=>{reads.push(thread.id);return {thread:{...thread,status:{type:turns.get(thread.id)?'active':'idle'}},activeTurnId:turns.get(thread.id)};};
  routes[`/api/threads/${thread.id}`]=()=>({thread,data:[{turnId:`turn-${thread.id}`,item:{id:`reply-${thread.id}`,type:'agentMessage',text:`${recovered?'Recovered':'Before'} ${thread.id}`}}],nextCursor:null});
 }
 // A background tab is not in the first page; list refresh alone cannot repair it.
 routes['/api/threads']=()=>({data:(recovered?threads.slice(1):threads).map(thread=>({...thread,status:{type:turns.get(thread.id)?'active':'idle'}})),nextCursor:null});
 const tabs=threads.map(thread=>({id:`tab-${thread.id}`,threadId:thread.id,title:thread.name}));tabs.splice(1,0,{id:'empty',threadId:null});
 const f=await fixture({threads,routes,colorScheme,storage:{'elpis-chat-tabs-v1':JSON.stringify({tabs,activeId:tabs.at(-1).id})}});
 const tab=async id=>{await f.page.getByRole('tablist',{name:'Chat tabs'}).getByRole('tab',{name:threads.find(t=>t.id===id).name,exact:true}).click();await f.page.getByText(`${recovered?'Recovered':'Before'} ${id}`,{exact:true}).waitFor();};
 try{
  for(const thread of threads){await tab(thread.id);await f.page.getByRole('button',{name:'Stop response',exact:true}).waitFor();}
  await run({...f,threads,turns,reads,routes,tab,recover:()=>{recovered=true;}});
  assert.deepEqual(f.errors,[]);
 }finally{
  if(process.env.ELPIS_RECONNECT_SHOTS){await fs.mkdir(process.env.ELPIS_RECONNECT_SHOTS,{recursive:true});await f.page.screenshot({path:path.join(process.env.ELPIS_RECONNECT_SHOTS,`${colorScheme}.png`)});}
  await f.close();
 }
}
async function eventually(check){const deadline=Date.now()+5000;while(true){try{return await check();}catch(error){if(Date.now()>deadline)throw error;await new Promise(resolve=>setTimeout(resolve,25));}}}

test('A125 reconnect re-reads the first, middle and last open chats and clears missed turn ends',()=>reconnectChats(async f=>{
 await f.composer.fill('Draft survives reconnect');
 const before=f.reads.length;
 f.emit('connection',{connected:false});
 await f.page.getByRole('status').filter({hasText:'Reconnecting to Elpis'}).waitFor();
 for(const thread of f.threads)f.turns.set(thread.id,null);
 f.recover();f.emit('connection',{connected:true});
 await f.page.getByText('Recovered chat-c',{exact:true}).waitFor();
 await eventually(()=>assert.deepEqual(new Set(f.reads.slice(before)),new Set(f.threads.map(t=>t.id)),'every open chat must be read after reconnect, including the off-page first tab'));
 for(const thread of f.threads){await f.tab(thread.id);await eventually(async()=>assert.equal(await f.page.getByRole('button',{name:'Stop response',exact:true}).count(),0));}
 assert.equal(await draftValue(f.composer),'Draft survives reconnect');
 assert.equal(f.posts.filter(post=>post.path.endsWith('/turns')).length,0,'recovery never resends messages');
}));

test('A125 reopening a chat clears a turn whose end was missed while another chat was shown',()=>reconnectChats(async f=>{
 f.turns.set('chat-a',null);
 await f.tab('chat-a');
 await eventually(async()=>assert.equal(await f.page.getByRole('button',{name:'Stop response',exact:true}).count(),0,'an authoritative idle resume clears the old active turn'));
}));

test('A125 transport reconnect recovers background chats even from an empty tab and isolates read errors',()=>reconnectChats(async f=>{
 await f.page.getByRole('button',{name:'New chat tab',exact:true}).click();
 const before=f.reads.length;
 f.routes['/api/threads/chat-b/resume']=()=>{f.reads.push('chat-b');return {__http:503,error:{message:'Recovery read refused'}};};
 f.routes['/api/threads']=()=>({__http:503,error:{message:'List unavailable'}});
 f.turns.set('chat-a',null);f.turns.set('chat-c',null);f.recover();
 f.disconnectEvents();
 await f.page.getByRole('status').filter({hasText:'Reconnecting to Elpis'}).waitFor();
 await eventually(()=>assert.deepEqual(new Set(f.reads.slice(before)),new Set(f.threads.map(t=>t.id)),'a failed list or sibling read must not block the other open chats'));
 assert.equal(await f.shown(),null,'recovery must leave the empty tab selected');
 await f.tab('chat-a');
 await eventually(async()=>assert.equal(await f.page.getByRole('button',{name:'Stop response',exact:true}).count(),0));
 await f.tab('chat-b');
 await f.page.getByRole('button',{name:'Stop response',exact:true}).waitFor();
 await f.page.getByText(/Not following live .*Recovery read refused/).waitFor();
}, 'dark'));

test('A125 a refused history read does not prevent authoritative turn recovery',()=>reconnectChats(async f=>{
 f.routes['/api/threads/chat-c']=()=>({__http:503,error:{message:'History unavailable'}});
 f.emit('connection',{connected:false});
 await f.page.getByRole('status').filter({hasText:'Reconnecting to Elpis'}).waitFor();
 for(const thread of f.threads)f.turns.set(thread.id,null);
 f.emit('connection',{connected:true});
 await eventually(async()=>assert.equal(await f.page.getByRole('button',{name:'Stop response',exact:true}).count(),0,'resume still runs when history cannot be read'));
 await f.page.getByText(/Not following live .*History unavailable/).waitFor();
}));

test('A125 a delayed idle recovery cannot erase a newer live turn',()=>reconnectChats(async f=>{
 let entered,release;const started=new Promise(resolve=>{entered=resolve;}),hold=new Promise(resolve=>{release=resolve;});
 f.routes['/api/threads/chat-c/resume']=async()=>{f.reads.push('chat-c');entered();await hold;return {thread:{...f.threads[2],status:{type:'idle'}},activeTurnId:null};};
 f.emit('connection',{connected:false});
 await f.page.getByRole('status').filter({hasText:'Reconnecting to Elpis'}).waitFor();
 try{
  f.emit('connection',{connected:true});await started;
  f.emit('message',{method:'turn/started',params:{threadId:'chat-c',turn:{id:'newer-live-turn'}}});
  f.emit('message',{method:'item/completed',params:{threadId:'chat-c',turnId:'newer-live-turn',item:{id:'newer-item',type:'agentMessage',text:'New live event reached the page'}}});
  await f.page.getByText('New live event reached the page',{exact:true}).waitFor();
  const response=f.page.waitForResponse(reply=>new URL(reply.url()).pathname==='/api/threads/chat-c/resume');release();await (await response).finished();
  await f.page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  assert.equal(await f.page.getByRole('button',{name:'Stop response',exact:true}).count(),1,'a newer live turn remains running');
 }finally{release();}
}));

test('A125 initial stream subscription catches a turn that ended during startup',async()=>{
 const thread={id:'chat-a',name:'Startup recovery',status:{type:'active'},desktopAccess:{writable:true}};let reads=0;
 const f=await fixture({threads:[thread],storage:{'elpis-last-chat':'chat-a'},routes:{
  '/api/threads/chat-a/resume':()=>({thread:{...thread,status:{type:++reads===1?'active':'idle'}},activeTurnId:reads===1?'startup-turn':null})
 }});
 try{await eventually(()=>assert.ok(reads>=2,'the stream must re-read the state after the initial resume'));await eventually(async()=>assert.equal(await f.page.getByRole('button',{name:'Stop response',exact:true}).count(),0));assert.deepEqual(f.errors,[]);}
 finally{await f.close();}
});
