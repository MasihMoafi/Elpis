const { chooseOption, controlValue, leaveSettings, sidebar } = require('./controls.cjs');
const {test}=require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http');
const fs=require('node:fs/promises');
const path=require('node:path');
const {chromium}=require(process.env.ELPIS_PLAYWRIGHT_PACKAGE||'playwright');

test('provider setup preserves edits on conflict, refreshes choices and never redisplays stored secrets',async()=>{
 const clients=new Set(),writes=[];
 let conflict=true;
 let config={version:'v1',configPath:'/tmp/config.toml',write:{available:true},managed:{modelProvider:null},providers:[]};
 const subscription={state:'notConnected',models:[],usage:[]};
 const accounts={openai:{auth:{state:'signedOut'},usage:[],usageError:null},claude:subscription,gemini:subscription,openrouter:[],local:[]};
 const server=http.createServer(async(req,res)=>{
  const route=new URL(req.url,'http://local').pathname;
  const json=(body,status=200)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(body));};
  if(route==='/api/events'){res.writeHead(200,{'content-type':'text/event-stream'});res.write('event: connection\ndata: {"connected":true}\n\n');clients.add(res);req.on('close',()=>clients.delete(res));return;}
  if(route==='/api/health')return json({connected:true});
  if(route==='/api/settings')return json({main:{model:'native-model',provider:'openai'},providers:[{id:'openai',displayName:'OpenAI'},...config.providers.map(p=>({id:p.id,displayName:p.name}))]});
  if(route==='/api/models')return json({data:[{id:'native-model',model:'native-model',displayName:'Native model'}]});
  if(route==='/api/threads')return json({data:[],nextCursor:null});
  if(route==='/api/providers')return json(accounts);
  if(route==='/api/providers/settings'){
   if(req.method==='GET')return json(config);
   let raw='';for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw);writes.push(body);
   if(conflict){conflict=false;config={...config,version:'v2'};return json({error:'Configuration changed elsewhere. Review your edits.'},409);}
   if(body.version!==config.version)return json({error:'Stale configuration'},409);
   config={...config,version:`v${writes.length+1}`,providers:[{id:body.id,name:body.name,baseUrl:body.baseUrl,wireApi:'responses',editable:true,auth:{source:body.credential.action==='clear'?'none':'stored',keySet:body.credential.action!=='clear',envKey:null}}]};
   return json(config);
  }
  try{const file=path.join(__dirname,'../out',route==='/'?'index.html':route);res.setHeader('content-type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':file.endsWith('.svg')?'image/svg+xml':'text/html');res.end(await fs.readFile(file));}catch{res.statusCode=404;res.end();}
 });await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const browser=await chromium.launch({executablePath:process.env.ELPIS_CHROMIUM||undefined,headless:true});
 const page=await browser.newPage({viewport:{width:1440,height:1000}});page.setDefaultTimeout(7000);
 try{
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await (await sidebar(page)).getByRole('button',{name:'Settings',exact:true}).click();
  // Settings opens on General, as in the ChatGPT app; connections live under Models & accounts.
  if(await page.getByRole('tab',{name:'Models & accounts',exact:true}).count())await page.getByRole('tab',{name:'Models & accounts',exact:true}).click();
  await page.getByText('Advanced API connections',{exact:true}).click();
  await page.getByRole('button',{name:'Add API provider',exact:true}).click();
  assert.equal(await page.getByLabel('Provider ID',{exact:true}).count(),0,'internal connection keys are generated for the user');
  await page.getByLabel('Provider display name',{exact:true}).fill('My API');
  await page.getByLabel('API endpoint',{exact:true}).fill('https://example.test/v1');
  await chooseOption(page.getByLabel('API key action',{exact:true}), 'replace');
  await page.getByLabel('Provider API key',{exact:true}).fill('fixture-only-secret');
  await page.getByRole('button',{name:'Save provider',exact:true}).click();
  await page.getByRole('alert').filter({hasText:'changed elsewhere'}).waitFor();
  assert.equal(await controlValue(page.getByLabel('Provider API key',{exact:true})),'fixture-only-secret');
  assert.equal(await controlValue(page.getByLabel('Provider display name',{exact:true})),'My API');
  await page.getByRole('button',{name:'Save provider',exact:true}).click();
  await page.getByRole('status').filter({hasText:'Saved for new conversations'}).waitFor();
  assert.equal(writes[1].version,'v2');assert.deepEqual(writes[1].credential,{action:'replace',value:'fixture-only-secret'});
  assert.equal(writes[1].id,'api-my-api');
  assert(!(await page.content()).includes('fixture-only-secret'));
  await (await sidebar(page)).getByRole('button',{name:'New chat',exact:true}).click();
  await page.getByLabel('Model',{exact:true}).click();
  await page.getByText('Advanced: use an unlisted model',{exact:true}).click();
  await chooseOption(page.getByLabel('Provider',{exact:true}), 'api-my-api');
  await page.getByLabel('Model ID',{exact:true}).fill('custom/native-model');
  await page.getByRole('button',{name:'Use model',exact:true}).click();
  assert.equal(await controlValue(page.getByLabel('Model',{exact:true})),'custom/native-model');
  await (await sidebar(page)).getByRole('button',{name:'Settings',exact:true}).click();
  await page.getByRole('tab',{name:'Models & accounts',exact:true}).click();
  await page.getByRole('button',{name:'Edit My API',exact:true}).click();
  assert.equal(await page.getByLabel('Provider API key',{exact:true}).count(),0);
  await chooseOption(page.getByLabel('API key action',{exact:true}), 'clear');
  await page.getByRole('button',{name:'Save provider',exact:true}).click();
  await page.getByRole('status').filter({hasText:'Saved for new conversations'}).waitFor();
  assert.deepEqual(writes.at(-1).credential,{action:'clear'});assert.equal(config.providers[0].auth.keySet,false);
 }finally{await browser.close();for(const client of clients)client.end();await new Promise(resolve=>server.close(resolve));}
});
