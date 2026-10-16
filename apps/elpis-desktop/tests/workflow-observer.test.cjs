// The observer must read existing sessions without taking over or resuming them.
const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs/promises');const path=require('node:path');const http=require('node:http');
const {chromium}=require(process.env.ELPIS_PLAYWRIGHT_PACKAGE||'playwright');
test('a chat the app cannot follow live is refreshed by reading: messages, child status, history and scroll survive',async()=>{
 const calls=[],clients=new Set();let childReads=0,lineageReads=0;
 const root={id:'root',name:'Root conversation',desktopAccess:{writable:false,reason:'Terminal owned'},status:{type:'active'}};
 const child={...root,id:'child',name:'Evidence agent',parentThreadId:'root'};
 const item=(id,text)=>({turnId:'turn',item:{id,type:'agentMessage',text}});
 const server=http.createServer(async(req,res)=>{const url=new URL(req.url,'http://local');calls.push({method:req.method,path:url.pathname});for await(const chunk of req){}const json=data=>{res.setHeader('content-type','application/json');res.end(JSON.stringify(data));};
  if(url.pathname==='/api/events'){res.writeHead(200,{'content-type':'text/event-stream'});res.write('event: connection\ndata: {"connected":true}\n\n');clients.add(res);return;}
  if(url.pathname==='/api/health')return json({connected:true});if(url.pathname==='/api/models')return json({data:[]});
  if(url.pathname==='/api/threads'){if(url.searchParams.has('ancestorThreadId')){lineageReads++;return json({data:[{...child,status:{type:lineageReads>1?'idle':'active'}},...(lineageReads>1?[{...child,id:'new-child',name:'Newly spawned reviewer'}]:[])],nextCursor:null});}return json({data:[root],nextCursor:null});}
  if(url.pathname==='/api/threads/root')return json({thread:root,data:[item('root-text','Root transcript')],nextCursor:null});
  if(url.pathname==='/api/threads/child'){if(url.searchParams.has('cursor'))return json({thread:child,data:[item('old','Earlier retained history')],nextCursor:null});childReads++;return json({thread:child,data:[...(childReads>1?[item('latest','A new observation arrived')]:[]),...Array.from({length:20},(_,i)=>item(`line-${i}`,`Recorded observation ${i}.\n\n${'Supporting evidence. '.repeat(30)}`))],nextCursor:'older'});}
  try{const file=path.join(__dirname,'../out',url.pathname==='/'?'index.html':url.pathname);res.setHeader('content-type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html');res.end(await fs.readFile(file));}catch{res.statusCode=404;res.end();}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const browser=await chromium.launch({executablePath:process.env.ELPIS_CHROMIUM||undefined,headless:true});
 try{const page=await browser.newPage({viewport:{width:1440,height:800}});page.setDefaultTimeout(10000);await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.getByRole('button',{name:'Root conversation',exact:true}).click();await page.locator('.thread-row[data-thread-id="child"] .thread-link').click();await page.getByRole('button',{name:'Load earlier messages',exact:true}).click();await page.getByText('Earlier retained history',{exact:true}).waitFor();
  await page.locator('.chat-scroll').evaluate(element=>{element.scrollTop=100;element.dispatchEvent(new Event('scroll',{bubbles:true}));});const position=await page.locator('.chat-scroll').evaluate(element=>element.scrollTop);
  await page.getByText('A new observation arrived',{exact:true}).waitFor({state:'attached'});assert.equal(await page.getByText('Earlier retained history',{exact:true}).count(),1);assert.equal(await page.locator('.chat-scroll').evaluate(element=>element.scrollTop),position);
  await page.locator('.thread-row[data-thread-id="new-child"] .thread-title').filter({hasText:'Newly spawned reviewer'}).waitFor();await page.getByRole('button',{name:'Agents',exact:true}).click();assert.match(await page.locator('.agent-row[data-thread-id="child"] .agent-state').innerText(),/idle/i);
  assert.deepEqual([...new Set(calls.filter(c=>c.method==='POST').map(c=>c.path))].sort(),['/api/threads/child/resume','/api/threads/root/resume'],'opening only asks to follow live; nothing is written');
  await page.screenshot({path:'/tmp/elpis-observer-agents.png'});
 }finally{await browser.close();for(const c of clients)c.end();await new Promise(resolve=>server.close(resolve));}
});
