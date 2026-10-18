const { chooseOption, controlValue } = require("./controls.cjs");
// Renderer contract checks against deterministic HTTP/SSE fixtures; no provider calls.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chooseTheme } = require('./controls.cjs');
const { chromium } = require(process.env.ELPIS_PLAYWRIGHT_PACKAGE || 'playwright');
const root = path.resolve(__dirname, '../out');

test('actual exported renderer: chat, steering, interrupt, existing writable history, themes and mobile', async () => {
  const calls=[]; const clients=new Set();
  const thread={id:'existing',name:'Investigate pruning quality',cwd:'/tmp/elpis-fixture',model:'gpt-6-luna',modelProvider:'openai',desktopAccess:{writable:false,reason:'Open in the terminal client.'},status:{type:'idle'}};
  const child={...thread,id:'child',name:'Inspect cache behaviour',parentThreadId:'existing'};
  const created={...thread,id:'created',name:null,preview:'New chat',desktopAccess:{writable:true,reason:null}};
  let createdThread=false;
  const emit=(method,params)=>{for(const res of clients)res.write(`event: message\ndata: ${JSON.stringify({method,params})}\n\n`);};
  const server=http.createServer(async(req,res)=>{
    const url=new URL(req.url,'http://localhost');let body='';for await(const chunk of req)body+=chunk;
    const data=body?JSON.parse(body):undefined; calls.push({method:req.method,path:url.pathname,data});
    const json=value=>{res.setHeader('content-type','application/json');res.end(JSON.stringify(value));};
    if(url.pathname==='/api/events'){res.writeHead(200,{'content-type':'text/event-stream'});res.write('event: connection\ndata: {"connected":true}\n\n');clients.add(res);req.on('close',()=>clients.delete(res));return;}
    if(url.pathname==='/api/session')return json({authenticated:true});
    if(url.pathname==='/api/health')return json({connected:true});
    if(url.pathname==='/api/models')return json({data:[{id:'luna',model:'gpt-6-luna',displayName:'Luna 6'},{id:'sol',model:'gpt-6-sol',displayName:'Sol 6'}],nextCursor:null});
    if(url.pathname==='/api/threads'&&req.method==='GET')return json({data:url.searchParams.has('ancestorThreadId')?(url.searchParams.get('ancestorThreadId')==='existing'?[child]:[]):[thread,...(createdThread?[created]:[])],nextCursor:null});
    if(url.pathname==='/api/threads'&&req.method==='POST'){createdThread=true;return json({thread:created});}
    if(url.pathname==='/api/threads/created/turns'){
      if(process.env.ELPIS_UI_MUTANT){res.statusCode=500;return json({error:'Deliberate send-route failure'});}
      json({turn:{id:'turn-1'}});setTimeout(()=>{
        emit('turn/started',{threadId:'created',turn:{id:'turn-1'}});
        emit('item/completed',{threadId:'created',turnId:'turn-1',item:{id:'user-1',type:'userMessage',content:[{type:'text',text:data.text}]}});
        emit('item/agentMessage/delta',{threadId:'created',turnId:'turn-1',itemId:'agent-1',delta:'I will inspect the cache path.'});
      },50);return;
    }
    if(url.pathname.endsWith('/resume')){const id=url.pathname.split('/')[3];return json({thread:{...(id==='child'?child:id==='created'?created:thread),desktopAccess:{writable:true,mode:'direct',reason:null}},activeTurnId:null});}
    if(url.pathname.endsWith('/steer'))return json({turnId:'turn-1'});
    if(url.pathname.endsWith('/interrupt')){json({});emit('turn/completed',{threadId:'created',turn:{id:'turn-1',status:'interrupted'}});return;}
    if(url.pathname.startsWith('/api/threads/'))return json({thread:url.pathname.endsWith('child')?child:url.pathname.endsWith('created')?created:thread,data:[{turnId:'old',item:{id:'answer',type:'agentMessage',text:'The cache prefix remains unchanged.'}},{turnId:'old',item:{id:'question',type:'userMessage',content:[{type:'text',text:'Check the prefix cache.'}]}}],nextCursor:null});
    try {const file=path.join(root,url.pathname==='/'?'index.html':url.pathname);const content=await fs.readFile(file);res.setHeader('content-type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':file.endsWith('.svg')?'image/svg+xml':'text/html');res.end(content);}catch{res.statusCode=404;res.end();}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const browser=await chromium.launch({executablePath:process.env.ELPIS_CHROMIUM||undefined,headless:true});
  try{
    const page=await browser.newPage({viewport:{width:1440,height:1000}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/#token=fixture`);
    await page.getByRole('button',{name:'Choose project',exact:true}).click();await page.getByRole('menuitem',{name:'New project…',exact:true}).click();await page.getByLabel('Workspace directory').fill('/tmp/elpis-fixture');await page.getByRole('button',{name:'Save project',exact:true}).click();
    await chooseOption(page.getByLabel('Model',{exact:true}), 'gpt-6-luna');
    await page.getByLabel('Message Elpis').fill('Check token accounting.');await page.getByRole('button',{name:'Send message',exact:true}).click();
    await page.getByText('I will inspect the cache path.',{exact:true}).waitFor({timeout:5000});
    assert.deepEqual(calls.find(c=>c.path==='/api/threads'&&c.method==='POST').data,{model:'gpt-6-luna',cwd:'/tmp/elpis-fixture'});
    assert.deepEqual(calls.find(c=>c.path.endsWith('/turns')).data,{text:'Check token accounting.'});
    await page.getByLabel('Message Elpis').fill('Also check the pruning overhead.');await page.getByRole('button',{name:'Send follow-up',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('textarea').value==='');
    assert.deepEqual(calls.find(c=>c.path.endsWith('/steer')).data,{text:'Also check the pruning overhead.',expectedTurnId:'turn-1'});
    await page.getByRole('button',{name:'Stop generation'}).click();await page.getByRole('button',{name:'Send message',exact:true}).waitFor();
    await page.getByLabel('Message Elpis').fill('Keep my draft');
    await page.getByRole('button',{name:'Investigate pruning quality',exact:true}).first().click();
    await page.getByText('The cache prefix remains unchanged.',{exact:true}).waitFor();
    // An existing chat opens writable: its own empty draft, followed live through a plain native rejoin.
    assert.equal(await controlValue(page.getByLabel('Message Elpis')),'');
    await page.getByLabel('Refresh conversation').click();await page.getByText('The cache prefix remains unchanged.',{exact:true}).waitFor();
    await page.locator('.thread-row[data-thread-id="child"] .thread-title').filter({hasText:'Inspect cache behaviour'}).waitFor();assert(calls.some(c=>c.path==='/api/threads'&&c.method==='GET'));
    assert.equal(await page.getByRole('button',{name:'Continue here',exact:true}).count(),0);assert.deepEqual(calls.find(c=>c.path==='/api/threads/existing/resume').data,{});
    await page.getByLabel('Search conversations').fill('Inspect cache');assert.equal(await page.getByRole('button',{name:'Investigate pruning quality',exact:true}).count(),0);
    await page.getByLabel('Search conversations').fill('');
    await page.locator('.thread-link[title="New chat"]').first().click();await page.getByRole('heading',{name:'New chat',exact:true}).waitFor();await page.getByLabel('Message Elpis').waitFor();assert.equal(await controlValue(page.getByLabel('Message Elpis')),'Keep my draft');
    const output=process.env.ELPIS_APP_SCREENSHOTS||'/tmp';
    await page.waitForFunction(()=>document.querySelector('.brand img')?.naturalWidth>0);
    assert.match(await page.locator('.brand img').getAttribute('src'), /\/elpis-wordmark-amber-light-loop\.svg$/, 'light theme: the website\'s light wordmark');
    assert((await page.locator('link[rel="icon"]').evaluateAll(links=>links.map(link=>link.getAttribute("href")))).every(href=>href.endsWith("/favicon-amber.svg")));
    await page.screenshot({path:path.join(output,'elpis-app-chat-light-1440.png')});
    await chooseTheme(page, 'dark');await page.waitForTimeout(250);await page.screenshot({path:path.join(output,'elpis-app-chat-dark-1440.png')});
    assert.match(await page.locator('.brand img').getAttribute('src'), /\/elpis-wordmark-amber-loop\.svg$/, 'dark theme: the website\'s wordmark');
    assert((await page.locator('link[rel="icon"]').evaluateAll(links=>links.map(link=>link.getAttribute("href")))).every(href=>href.endsWith("/favicon-amber.svg")));
    await page.setViewportSize({width:390,height:844});await page.screenshot({path:path.join(output,'elpis-app-chat-dark-390.png')});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    await page.getByLabel('Open sidebar').click();await chooseTheme(page, 'light');await page.waitForTimeout(250);await page.getByLabel('Close sidebar').click();await page.screenshot({path:path.join(output,'elpis-app-chat-light-390.png')});
    await page.getByLabel('Open sidebar').click();await page.getByRole('button',{name:'Observability',exact:true}).click();await page.getByRole('heading',{name:'Observability',exact:true}).waitFor();
    assert.deepEqual(errors,[]);
  }finally{await browser.close();for(const client of clients)client.end();await new Promise(resolve=>server.close(resolve));}
});
