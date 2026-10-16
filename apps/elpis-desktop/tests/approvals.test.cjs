const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),http=require('node:http');
const {chromium}=require(process.env.ELPIS_PLAYWRIGHT_PACKAGE||'playwright');
const {chooseOption}=require('./controls.cjs');
const thread={id:'chat',name:'Approval fixture',model:'mock',desktopAccess:{writable:true,reason:null}};
async function fixture(t,theme){
  const streams=new Set(),posts=[];let fail=false;
  const server=http.createServer(async(req,res)=>{
    const url=new URL(req.url,'http://local');let raw='';for await(const p of req)raw+=p;
    const json=data=>{res.setHeader('content-type','application/json');res.end(JSON.stringify(data));};
    if(url.pathname==='/api/events'){res.writeHead(200,{'content-type':'text/event-stream'});res.write('event: connection\ndata: {"connected":true}\n\n');streams.add(res);return;}
    if(url.pathname==='/api/health')return json({connected:true});
    if(url.pathname==='/api/models')return json({data:[]});
    if(url.pathname==='/api/settings')return json({main:{model:'mock',provider:'openai'},background:{},memory:{},smartPrune:{},write:{reason:'Fixture'}});
    if(url.pathname==='/api/threads')return json({data:[thread],nextCursor:null});
    if(url.pathname.endsWith('/context'))return json({threadId:'chat',tokenUsage:null,smartPrune:null});
    if(url.pathname.startsWith('/api/threads/'))return json({thread,data:[],nextCursor:null});
    if(url.pathname.startsWith('/api/approvals/')){posts.push(JSON.parse(raw));if(fail){res.statusCode=502;return json({error:'Fixture engine unavailable'});}return json({resolved:true});}
    try{const file=path.join(__dirname,'../out',url.pathname==='/'?'index.html':url.pathname);res.setHeader('content-type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html');res.end(await fs.readFile(file));}catch{res.statusCode=404;res.end();}
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const browser=await chromium.launch({executablePath:process.env.ELPIS_CHROMIUM,headless:true,args:['--no-sandbox']});
  t.after(async()=>{await browser.close();for(const s of streams)s.end();server.closeAllConnections();await new Promise(r=>server.close(r));});
  const page=await browser.newPage({viewport:{width:1280,height:1000},colorScheme:theme});page.setDefaultTimeout(6000);
  await page.goto(`http://127.0.0.1:${server.address().port}`);await page.getByRole('button',{name:thread.name,exact:true}).click();
  const emit=(method,params)=>{for(const s of streams)s.write(`event: approval\ndata: ${JSON.stringify({id:`approval-${posts.length}`,ownerThreadId:'chat',method,params:{threadId:'chat',...params}})}\n\n`);};
  await fs.mkdir('/tmp/elpis-approvals',{recursive:true});
  const shot=async name=>{await page.locator('.approval').screenshot({path:`/tmp/elpis-approvals/${name}-${theme}.png`});};
  const answered=async count=>{await page.waitForFunction(()=>!document.querySelector('.approval'));assert.equal(posts.length,count);};
  return {page,posts,emit,shot,answered,fail:value=>{fail=value;}};
}
for(const theme of ['light','dark']){
  test(`MCP tool card offers exact session choices and sends action metadata (${theme})`,async t=>{
    const f=await fixture(t,theme),{page}=f;
    const params={serverName:'elpis_browser',mode:'form',message:'Open the fixture site',requestedSchema:{type:'object',properties:{}},_meta:{codex_approval_kind:'mcp_tool_call',tool_name:'browser_open',tool_params:{url:'https://example.test'},persist:['session']}};
    f.emit('mcpServer/elicitation/request',params);await page.getByText('browser_open',{exact:true}).waitFor();await page.getByText('https://example.test',{exact:false}).waitFor();
    assert.equal(await page.getByRole('button',{name:'Always allow',exact:true}).count(),0);assert.equal(await page.getByRole('button',{name:'Deny',exact:true}).count(),0);
    await f.shot('mcp-tool');await page.getByRole('button',{name:'Allow for this session',exact:true}).click();await f.answered(1);assert.deepEqual(f.posts[0],{action:'accept',content:null,_meta:{persist:'session'}});
    f.emit('mcpServer/elicitation/request',{...params,_meta:{...params._meta,persist:undefined}});await page.getByRole('button',{name:'Cancel',exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'Allow for this session',exact:true}).count(),0);await page.getByRole('button',{name:'Cancel',exact:true}).press('Escape');await f.answered(2);assert.deepEqual(f.posts[1],{action:'cancel',content:null,_meta:null});
  });
  test(`MCP form validates fields and sends typed values, retaining failed drafts (${theme})`,async t=>{
    const f=await fixture(t,theme),{page}=f;
    f.emit('mcpServer/elicitation/request',{serverName:'survey',mode:'form',message:'Choose fixture settings',requestedSchema:{type:'object',properties:{email:{type:'string',title:'Email',format:'email'},count:{type:'integer',title:'Count',minimum:1,maximum:4},enabled:{type:'boolean',title:'Enabled',default:false},color:{type:'string',title:'Color',oneOf:[{const:'blue',title:'Blue'},{const:'red',title:'Red'}]},tags:{type:'array',title:'Tags',items:{type:'string',enum:['a','b']},minItems:1}},required:['email','count','enabled','color','tags']}});
    await page.getByLabel('Email', {exact:true}).fill('bad');await page.getByRole('button',{name:'Send answers',exact:true}).click();assert.equal(f.posts.length,0);
    await page.getByLabel('Email',{exact:true}).fill('fixture@example.test');await page.getByLabel('Count',{exact:true}).fill('2');await chooseOption(page.getByRole('combobox',{name:'Color',exact:true}),'blue');await page.getByRole('checkbox',{name:'a',exact:true}).check();await page.locator('.approval').getByRole('alert').waitFor({state:'hidden'});await f.shot('mcp-form');
    f.fail(true);await page.getByRole('button',{name:'Send answers',exact:true}).click();await page.getByRole('alert').getByText(/Fixture engine unavailable/).waitFor();assert.equal(await page.getByLabel('Email',{exact:true}).inputValue(),'fixture@example.test');
    f.fail(false);await page.getByRole('button',{name:'Send answers',exact:true}).click();await f.answered(2);assert.deepEqual(f.posts[1],{action:'accept',content:{email:'fixture@example.test',count:2,enabled:false,color:'blue',tags:['a']},_meta:null});
  });
  test(`permission card grants exact requested scope or denies (${theme})`,async t=>{
    const f=await fixture(t,theme),{page}=f,permissions={network:{enabled:true},fileSystem:{read:['/fixture'],write:['/fixture/output']}};
    const params={permissions,reason:'Read fixture inputs and write results',cwd:'/fixture'};
    f.emit('item/permissions/requestApproval',params);await page.getByText(params.reason,{exact:true}).waitFor();await page.getByText('/fixture/output',{exact:false}).waitFor();await f.shot('permissions');
    await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await f.shot('permissions-narrow');
    await page.getByRole('button',{name:'Yes, grant these permissions for this session',exact:true}).click();await f.answered(1);assert.deepEqual(f.posts[0],{permissions,scope:'session'});
    f.emit('item/permissions/requestApproval',params);await page.getByRole('button',{name:'No, continue without permissions',exact:true}).press('Escape');await f.answered(2);assert.deepEqual(f.posts[1],{permissions:{},scope:'turn'});
  });
}
