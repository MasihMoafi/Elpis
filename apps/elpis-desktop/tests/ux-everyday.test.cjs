// Everyday focus and error contracts against the exported renderer. No runtime or model calls.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const http=require('node:http');
const path=require('node:path');
const {chromium}=require(process.env.ELPIS_PLAYWRIGHT_PACKAGE||'playwright');
const { chooseOption, openSettings, chooseTheme } = require('./controls.cjs');

async function fixture(run){
 const clients=new Set(),posts=[];
 const thread={id:'ux-chat',name:'Everyday chat',model:'sol',modelProvider:'fixture',cwd:'/tmp/ux-fixture',status:{type:'idle'},desktopAccess:{writable:true,mode:'direct'}};
 const user={id:'ask',type:'userMessage',content:[{type:'text',text:'Check everyday interactions'}]};
 const reply={id:'reply',type:'agentMessage',text:'Local fixture reply'};
 const emit=(method,params)=>{for(const c of clients)c.write(`event: message\ndata: ${JSON.stringify({method,params})}\n\n`);};
 const server=http.createServer(async(req,res)=>{
  const url=new URL(req.url,'http://local');let raw='';for await(const c of req)raw+=c;
  const data=raw?JSON.parse(raw):{};if(req.method==='POST')posts.push({path:url.pathname,data});
  const json=value=>{res.setHeader('content-type','application/json');res.end(JSON.stringify(value));};
  if(url.pathname==='/api/events'){res.writeHead(200,{'content-type':'text/event-stream'});res.write('event: connection\ndata: {"connected":true}\n\n');clients.add(res);req.on('close',()=>clients.delete(res));return;}
  if(url.pathname==='/api/session')return json({authenticated:true});
  if(url.pathname==='/api/health')return json({connected:true});
  if(url.pathname==='/api/models')return json({data:[{id:'sol',model:'sol',displayName:'Sol',supportedReasoningEfforts:[{reasoningEffort:'high'}]},{id:'sol-fast',model:'sol-fast',displayName:'Sol fast',supportedReasoningEfforts:[{reasoningEffort:'high'}]}],nextCursor:null});
  if(url.pathname==='/api/settings')return json({main:{model:'sol',provider:'fixture'},providers:[{id:'fixture',displayName:'Local fixture'}]});
  if(url.pathname==='/api/threads')return json(req.method==='POST'?{thread}:{data:url.searchParams.has('searchTerm')?[]:[thread],nextCursor:null});
  if(url.pathname.endsWith('/resume'))return json({thread,activeTurnId:null});
  if(url.pathname.endsWith('/context'))return json({tokenUsage:null});
  if(url.pathname.endsWith('/turns')){setTimeout(()=>{emit('turn/started',{threadId:thread.id,turn:{id:'next'}});emit('turn/completed',{threadId:thread.id,turn:{id:'next',status:'completed'}});},30);return json({turn:{id:'next'}});}
  if(url.pathname.endsWith('/revert')){const id=`replacement-${posts.length}`;setTimeout(()=>{emit('turn/started',{threadId:thread.id,turn:{id}});emit('item/completed',{threadId:thread.id,turnId:id,item:{...user,id:id+'-ask',content:[{type:'text',text:data.text}]}});emit('item/completed',{threadId:thread.id,turnId:id,item:{...reply,id:id+'-reply'}});emit('turn/completed',{threadId:thread.id,turn:{id,status:'completed'}});},60);return json({turn:{id}});}
  if(url.pathname.endsWith('/interrupt')){emit('turn/completed',{threadId:thread.id,turn:{id:'running',status:'interrupted'}});return json({});}
  if(url.pathname===`/api/threads/${thread.id}`)return json({thread,data:[{turnId:'first',item:reply},{turnId:'first',item:user}],nextCursor:null});
  if(url.pathname.startsWith('/api/'))return json({data:[]});
  try{const file=path.join(__dirname,'../out',url.pathname==='/'?'index.html':url.pathname);res.setHeader('content-type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html');res.end(await fs.readFile(file));}catch{res.statusCode=404;res.end();}
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const browser=await chromium.launch({executablePath:process.env.ELPIS_CHROMIUM||undefined,headless:true});
 try{
  const page=await browser.newPage({viewport:{width:1320,height:900}});page.setDefaultTimeout(4000);
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const composer=page.getByLabel('Message Elpis',{exact:true});await composer.waitFor();await page.waitForFunction(()=>!document.querySelector('[aria-label="Message Elpis"]').disabled);
  const open=async()=>{await page.locator('.thread-link').filter({hasText:thread.name}).click();await page.getByText(reply.text,{exact:true}).waitFor();};
  const focused=()=>composer.evaluate(e=>e===document.activeElement);
  const shot=async name=>{if(process.env.ELPIS_UX_SHOTS){await fs.mkdir(process.env.ELPIS_UX_SHOTS,{recursive:true});await page.screenshot({path:path.join(process.env.ELPIS_UX_SHOTS,`${name}.png`)});}};
  const approve=id=>{for(const c of clients)c.write(`event: approval\ndata: ${JSON.stringify({id,params:{threadId:'ux-chat',command:'printf local',reason:'Local approval fixture',availableDecisions:['accept','decline']}})}\n\n`);};
  await run({page,composer,open,focused,emit,approve,posts,shot});assert.deepEqual(errors,[]);
 }finally{await browser.close();for(const c of clients)c.end();server.closeAllConnections();await new Promise(r=>server.close(r));}
}

test('new chat is ready to type, and click-send restores composer focus',()=>fixture(async({page,composer,focused,shot})=>{
 await page.waitForTimeout(180);await shot('initial-focus');assert.equal(await focused(),true,'first launch focuses the composer');
 await composer.fill('Send with a pointer');await page.getByRole('button',{name:'Send message',exact:true}).click();
 await page.getByRole('button',{name:'Send message',exact:true}).waitFor({state:'visible'});await page.waitForTimeout(180);
 await shot('click-send-focus');assert.equal(await focused(),true,'a disappearing send button must not strand focus');
}));

test('Stop restores focus without stealing it from another field during a slow send',()=>fixture(async({page,composer,open,focused,emit})=>{
 await open();emit('turn/started',{threadId:'ux-chat',turn:{id:'running'}});
 const stop=page.getByRole('button',{name:'Stop response',exact:true});await stop.waitFor();await stop.click();await stop.waitFor({state:'detached'});await page.waitForTimeout(180);
 assert.equal(await focused(),true,'Stop returns to the composer');
 let release;await page.route('**/api/threads/ux-chat/turns',async route=>{await new Promise(r=>release=r);await route.fulfill({json:{turn:{id:'delayed'}}});});
 await composer.fill('Slow submission');await page.getByRole('button',{name:'Send message',exact:true}).click();await page.getByLabel('Search conversations').fill('Keep focus here');
 release();await page.waitForTimeout(200);assert.equal(await page.getByLabel('Search conversations').evaluate(e=>e===document.activeElement),true,'late sends preserve a new focus choice');
}));

test('Escape clears conversation search and returns to the draft',()=>fixture(async({page,composer,focused,shot})=>{
 await composer.fill('Unsent draft');await page.keyboard.press('Control+Shift+K');const search=page.getByLabel('Search conversations');await search.fill('no-match-1701');
 await page.getByText('No matching conversations.',{exact:true}).waitFor();await shot('search-empty');await search.press('Escape');await page.waitForTimeout(180);
 assert.equal(await search.inputValue(),'');assert.equal(await composer.inputValue(),'Unsent draft');assert.equal(await focused(),true);
}));

test('keyboard shortcuts return to the field that opened them, and edit Cancel returns to the composer',()=>fixture(async({page,composer,open,focused})=>{
 // Prime a popup trigger: its historical focus must not win over the actual keyboard origin.
 await page.getByRole('button',{name:'Add files and more',exact:true}).click();
 const menu=page.getByRole('menu');await menu.waitFor();await page.keyboard.press('Escape');await menu.waitFor({state:'detached'});
 const search=page.getByLabel('Search conversations');await search.focus();await page.keyboard.press('Control+/');const dialog=page.getByRole('alertdialog');await dialog.waitFor();
 await page.getByLabel('Search keyboard shortcuts').fill('no-match');await page.keyboard.press('Escape');await dialog.waitFor({state:'detached'});await page.waitForFunction(element=>element===document.activeElement && !element.closest('[inert]'),await search.elementHandle());
 assert.equal(await search.evaluate(e=>e===document.activeElement),true,'restore the actual keyboard origin');
 await open();await page.getByRole('button',{name:'Edit message',exact:true}).click();await page.getByLabel('Edited message').waitFor();await page.getByRole('button',{name:'Cancel',exact:true}).click();await page.waitForTimeout(180);
 assert.equal(await focused(),true);assert.equal(await composer.inputValue(),'');assert.equal(await page.getByText('Check everyday interactions',{exact:true}).count(),1);
}));

test('unreadable server errors stay human-readable and retain drafts; specific refusals stay specific',()=>fixture(async({page,composer,open,shot})=>{
 await open();let response={error:{code:-32601}};
 await page.route('**/api/threads/ux-chat/turns',route=>route.fulfill({status:503,json:response}));
 await composer.fill('Keep my failed draft');await composer.press('Enter');const alert=page.getByRole('alert').filter({hasText:/./});await alert.first().waitFor();await shot('unreadable-error');
 const text=await alert.allTextContents();assert.doesNotMatch(text.join(' '),/\[object Object\]|-32601|Request failed \(\d+\)/);assert.match(text.join(' '),/Elpis.*unavailable|could not|couldn.t/i);assert.equal(await composer.inputValue(),'Keep my failed draft');
 response={error:{message:'Elpis rejected the operation (-32601). No automatic retry was made.'}};await composer.press('Enter');await page.waitForTimeout(120);assert.doesNotMatch((await alert.allTextContents()).join(' '),/-32601|rejected the operation/,'generic protocol errors must be readable too');
 response={error:{message:'This conversation is read-only. Continue in a new chat.'}};await composer.press('Enter');await page.getByText(response.error.message,{exact:false}).first().waitFor();assert.equal(await composer.inputValue(),'Keep my failed draft');
}));

test('queued follow-ups stay queued after Stop and send exactly once after normal completion',()=>fixture(async({page,composer,open,emit,posts})=>{
 await open();await openSettings(page);await page.getByRole('radio',{name:'Queue',exact:true}).click();await page.getByRole('button',{name:'Back to app',exact:true}).click();
 emit('turn/started',{threadId:'ux-chat',turn:{id:'running'}});await page.getByRole('button',{name:'Stop response',exact:true}).waitFor();
 await composer.fill('QUEUED_UI_SENTINEL_1701');await composer.press('Enter');const queue=page.getByRole('list',{name:'Queued follow-ups'});await queue.waitFor();
 assert.equal(posts.filter(p=>p.path.endsWith('/turns')).length,0,'queuing does not steer or start a turn');
 emit('turn/completed',{threadId:'ux-chat',turn:{id:'running',status:'interrupted'}});await page.getByRole('button',{name:'Stop response',exact:true}).waitFor({state:'detached'});assert.equal(await queue.count(),1);
 assert.equal(posts.filter(p=>p.path.endsWith('/turns')).length,0,'Stop never sends waiting messages');
 emit('turn/started',{threadId:'ux-chat',turn:{id:'running-2'}});emit('turn/completed',{threadId:'ux-chat',turn:{id:'running-2',status:'completed'}});await queue.waitFor({state:'detached'});await page.waitForTimeout(180);
 assert.deepEqual(posts.filter(p=>p.path.endsWith('/turns')).map(p=>p.data),[{text:'QUEUED_UI_SENTINEL_1701'}]);
}));

test('streaming follows the latest text until the person scrolls up, then preserves their reading position',()=>fixture(async({page,open,emit,shot})=>{
 await open();emit('turn/started',{threadId:'ux-chat',turn:{id:'stream'}});emit('item/started',{threadId:'ux-chat',turnId:'stream',item:{id:'stream-reply',type:'agentMessage',text:''}});
 const delta=text=>emit('item/agentMessage/delta',{threadId:'ux-chat',turnId:'stream',itemId:'stream-reply',delta:text});
 delta(Array.from({length:120},(_,i)=>`Streaming paragraph ${i}`).join('\n\n'));
 const scroller=page.locator('.chat-scroll');await page.getByText('Streaming paragraph 119',{exact:true}).waitFor({state:'attached'});await page.waitForTimeout(100);
 const gap=()=>scroller.evaluate(e=>e.scrollHeight-e.clientHeight-e.scrollTop);assert((await gap())<10,'stream starts at the latest text');
 await scroller.evaluate(e=>{e.scrollTop=120;e.dispatchEvent(new Event('scroll'));});delta('\n\nNewest text after scrolling up');await page.getByText('Newest text after scrolling up',{exact:true}).waitFor({state:'attached'});await page.waitForTimeout(100);
 assert(Math.abs((await scroller.evaluate(e=>e.scrollTop))-120)<5,'incoming text does not pull the reader down');await shot('stream-reading-position');
 await scroller.evaluate(e=>{e.scrollTop=e.scrollHeight;e.dispatchEvent(new Event('scroll'));});delta('\n\nLatest text after returning');await page.getByText('Latest text after returning',{exact:true}).waitFor({state:'attached'});await page.waitForTimeout(100);assert((await gap())<10,'following resumes at the bottom');
}));

test('approving or declining a card returns focus to the composer',()=>fixture(async({page,open,approve,focused,posts})=>{
 await open();
 for(const [id,label,decision] of [['allow-card','Allow once','accept'],['deny-card','Deny','decline']]){
  approve(id);const action=page.locator('.approval').getByRole('button',{name:label,exact:true});await action.click();await action.waitFor({state:'detached'});await page.waitForTimeout(180);
  assert.equal(await focused(),true,`${label} returns to the draft`);assert.deepEqual(posts.find(p=>p.path===`/api/approvals/${id}`).data,{decision});
 }
}));

test('editing and resending, then regenerating a reply, keep the composer ready for the next instruction',()=>fixture(async({page,open,focused,posts})=>{
 await open();await page.getByRole('button',{name:'Edit message',exact:true}).click();await page.getByLabel('Edited message').fill('Edited prompt');await page.getByRole('form',{name:'Edit message',exact:true}).getByRole('button',{name:'Send',exact:true}).click();
 await page.getByLabel('Edited message').waitFor({state:'detached'});await page.getByText('Edited prompt',{exact:true}).waitFor();await page.waitForTimeout(180);assert.equal(await focused(),true,'edit and resend returns to the composer');
 const regenerate=page.getByRole('button',{name:'Regenerate reply',exact:true});await regenerate.click();await page.waitForTimeout(250);await regenerate.waitFor();assert.equal(await focused(),true,'regenerate returns to the composer');
 assert.deepEqual(posts.filter(p=>p.path.endsWith('/revert')).map(p=>p.data.text),['Edited prompt','Edited prompt']);
}));

test('removing the last attachment returns to the composer without losing its text',()=>fixture(async({page,composer,focused})=>{
 await composer.fill('Keep this text');await composer.evaluate(e=>{const data=new DataTransfer();data.items.add(new File(['Local note'],'note.txt',{type:'text/plain'}));e.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:data}));});
 const remove=page.getByRole('button',{name:'Remove note.txt',exact:true});await remove.click();await remove.waitFor({state:'detached'});await page.waitForTimeout(180);assert.equal(await focused(),true);assert.equal(await composer.inputValue(),'Keep this text');
}));

test('Back to app restores the saved draft and focuses it',()=>fixture(async({page,composer,focused})=>{
 await composer.fill('Keep my settings draft');await openSettings(page);await page.getByRole('tab',{name:'Appearance',exact:true}).click();await page.getByRole('button',{name:'Back to app',exact:true}).click();await page.waitForTimeout(180);assert.equal(await focused(),true);assert.equal(await composer.inputValue(),'Keep my settings draft');
}));

test('fork opens the new chat ready to type, and a delayed fork never overrides a newer draft',()=>fixture(async({page,composer,open,focused})=>{
 await open();const fork={id:'ux-fork',name:'Everyday chat (fork)',model:'sol',status:{type:'idle'},desktopAccess:{writable:true,mode:'direct'}};
 let delayed=false,release;
 await page.route('**/api/threads/ux-chat/fork',async route=>{if(delayed)await new Promise(r=>release=r);await route.fulfill({json:{thread:fork}});});
 await page.route('**/api/threads/ux-fork**',route=>route.fulfill({json:{thread:fork,activeTurnId:null,data:[{turnId:'fork-turn',item:{id:'fork-reply',type:'agentMessage',text:'Fork history'}}],nextCursor:null}}));
 await page.getByRole('button',{name:'Fork chat from here',exact:true}).click();await page.getByRole('heading',{name:fork.name,exact:true}).waitFor();await page.waitForTimeout(180);assert.equal(await focused(),true);
 await page.getByRole('button',{name:'Everyday chat',exact:true}).first().click();await page.getByText('Local fixture reply',{exact:true}).waitFor();delayed=true;await page.getByRole('button',{name:'Fork chat from here',exact:true}).click();
 await page.getByRole('button',{name:'New chat',exact:true}).click();await composer.fill('A newer draft');release();await page.waitForTimeout(200);assert.equal(await page.getByRole('heading',{name:'What should we build?',exact:true}).count(),1);assert.equal(await composer.inputValue(),'A newer draft');
}));

for(const action of ['Send now','Remove from queue'])test(`queued follow-up ${action} returns focus to the composer`,()=>fixture(async({page,composer,open,emit,focused})=>{
 await open();await openSettings(page);await page.getByRole('radio',{name:'Queue',exact:true}).click();await page.getByRole('button',{name:'Back to app',exact:true}).click();emit('turn/started',{threadId:'ux-chat',turn:{id:'running'}});await page.getByRole('button',{name:'Stop response',exact:true}).waitFor();
 await composer.fill('Waiting instruction');await composer.press('Enter');const queue=page.getByRole('list',{name:'Queued follow-ups'});await queue.waitFor();await queue.getByRole('button',{name:action,exact:true}).click();await queue.waitFor({state:'detached'});await page.waitForTimeout(180);assert.equal(await focused(),true);
}));

test('a queued turn uses the model and Plan mode selected with its message; the effort is saved to the chat at once',()=>fixture(async({page,composer,open,emit,posts})=>{
 await open();await openSettings(page);await page.getByRole('radio',{name:'Queue',exact:true}).click();await page.getByRole('button',{name:'Back to app',exact:true}).click();emit('turn/started',{threadId:'ux-chat',turn:{id:'running'}});await page.getByRole('button',{name:'Stop response',exact:true}).waitFor();
 await chooseOption(page.getByLabel('Model',{exact:true}),'sol-fast');await chooseOption(page.getByLabel('Reasoning effort',{exact:true}),'high');await page.getByRole('button',{name:'Add files and more',exact:true}).click();await page.getByRole('menuitem',{name:/Plan mode/}).click();
 await composer.fill('Use these queued choices');await composer.press('Enter');const queue=page.getByRole('list',{name:'Queued follow-ups'});await queue.waitFor();emit('turn/completed',{threadId:'ux-chat',turn:{id:'running',status:'completed'}});await queue.waitFor({state:'detached'});await page.waitForTimeout(180);
 assert.deepEqual(posts.filter(p=>p.path.endsWith('/effort')).map(p=>p.data),[{effort:'high'}]);
 assert.deepEqual(posts.filter(p=>p.path.endsWith('/turns')).map(p=>p.data),[{text:'Use these queued choices',model:'sol-fast',mode:'plan'}]);
}));

test('small sidebar section labels have readable contrast in both themes',()=>fixture(async({page})=>{
 for(const dark of [false,true]){
  if(dark)await chooseTheme(page, 'dark');
  const colors=await page.locator('.section-label').first().evaluate(e=>({text:getComputedStyle(e).color,background:getComputedStyle(e.closest('aside')).backgroundColor}));
  const luminance=color=>{const rgb=color.match(/[\d.]+/g).slice(0,3).map(Number).map(n=>{const c=n/255;return c<=0.04045?c/12.92:((c+0.055)/1.055)**2.4;});return rgb[0]*0.2126+rgb[1]*0.7152+rgb[2]*0.0722;};
  const a=luminance(colors.text),b=luminance(colors.background),ratio=(Math.max(a,b)+0.05)/(Math.min(a,b)+0.05);
  assert(ratio>=4.5,`${dark?'dark':'light'} section label contrast ${ratio.toFixed(2)} must be at least 4.5`);
 }
}));
