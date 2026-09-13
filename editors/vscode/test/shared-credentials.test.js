'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {spawn}=require('node:child_process');
const {once}=require('node:events');
const {Session}=require('../src/session');
const {runtimeOptions}=require('../src/providers');
const {Provider,message}=require('./runtime-eval');

test('IDE credentials reach an existing shared server without changing conversation or persisting keys',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'elpis-shared-keys-')),home=path.join(root,'home');
  await fs.mkdir(home);
  const provider=new Provider();await provider.start();
  const config=`model="gpt-5.6-luna"\nmodel_provider="openai_eval"\n[model_providers.key_eval]\nname="Key eval"\nbase_url=${JSON.stringify(provider.url)}\nwire_api="responses"\nenv_key="OPENROUTER_API_KEY"\nrequires_openai_auth=false\n[model_providers.openai_eval]\nname="OpenAI auth eval"\nbase_url=${JSON.stringify(provider.url)}\nwire_api="responses"\nrequires_openai_auth=true\n`;
  const storedAuth=JSON.stringify({auth_mode:'apikey',OPENAI_API_KEY:'fixture-underlying-key'});
  await fs.writeFile(path.join(home,'auth.json'),storedAuth);
  await fs.writeFile(path.join(home,'config.toml'),config);
  const executable=process.env.ELPIS_EDITOR_TEST_RUNTIME || path.join(__dirname,'../bin/elpis-app-server');
  const server=spawn(executable,['--serve-local'],{cwd:root,env:{...process.env,CODEX_API_KEY:'',OPENAI_API_KEY:'',OPENROUTER_API_KEY:'',CODEX_HOME:home,ELPIS_HOME:home},stdio:'ignore'});
  const sessions=[];
  try {
    const deadline=Date.now()+10000;
    while(!require('node:fs').existsSync(path.join(home,'app-server-control','app-server-control.sock'))){
      if(Date.now()>deadline)throw Error('Fixture server failed to start');
      await new Promise(resolve=>setTimeout(resolve,25));
    }
    const original=new Session(root,{cancel(){}},{home,executable,provider:'key_eval'});sessions.push(original);
    await original.connect();
    provider.actions.push(message('INITIAL_KEY_FIXTURE'));
    await Promise.all([once(original,'completed',{signal:AbortSignal.timeout(10000)}),original.send('Create the shared conversation.')]);
    for(const key of ['fixture-key-first','fixture-key-replaced']){
      const editor=new Session(root,{cancel(){}},{...runtimeOptions({home,executable,provider:'openrouter',resumeThreadId:original.threadId},key),provider:'key_eval',model:'gpt-5.6-luna'});
      sessions.push(editor);await editor.connect();
      let observed;
      provider.actions.push((request,headers)=>{
        observed={request,headers};
        return message('KEY_HANDOFF_OK');
      });
      await Promise.all([once(original,'completed',{signal:AbortSignal.timeout(10000)}),original.send('Check the shared credential handoff.')]);
      assert.equal(provider.error,undefined);
      assert.equal(observed?.headers.authorization,`Bearer ${key}`);
      assert(!JSON.stringify(observed.request).includes(key),'credentials must not enter inference content');
      editor.dispose();
    }
    await assert.rejects(original.rpc.request('account/provider/credentials/set',{provider:'not-a-provider',apiKey:'fixture-key-rejected'}),/Unknown model provider/);
    await assert.rejects(original.rpc.request('account/provider/credentials/set',{provider:'openrouter',apiKey:'bad\nkey'}),/visible ASCII/);
    await original.rpc.request('account/provider/credentials/set',{provider:'openrouter',apiKey:null});
    let cleared;
    provider.actions.push((request,headers)=>{cleared=headers.authorization;return message('KEY_CLEARED');});
    await Promise.all([once(original,'completed',{signal:AbortSignal.timeout(10000)}),original.send('Use runtime authentication again.')]);
    assert.equal(cleared,undefined,'removing a saved key must clear the shared override');
    const openai=new Session(root,{cancel(){}},{home,executable,provider:'openai_eval'});sessions.push(openai);
    await openai.connect();
    for(const key of ['fixture-key-openai',null]){
      await original.rpc.request('account/provider/credentials/set',{provider:'openai',apiKey:key});
      const account=await original.rpc.request('account/read',{refreshToken:false});
      assert.equal(account.account.type,'apiKey');
      let header;
      provider.actions.push((request,headers)=>{header=headers.authorization;return message('OPENAI_AUTH_OK');});
      await Promise.all([once(openai,'completed',{signal:AbortSignal.timeout(10000)}),openai.send('Check temporary OpenAI authentication.')]);
      assert.equal(header,`Bearer ${key || 'fixture-underlying-key'}`);
      assert.equal(await fs.readFile(path.join(home,'auth.json'),'utf8'),storedAuth,'temporary keys must preserve the saved login');
    }
    assert.equal(await fs.readFile(path.join(home,'config.toml'),'utf8'),config);
    for(const entry of await fs.readdir(home,{recursive:true,withFileTypes:true})){
      if(!entry.isFile())continue;
      const content=await fs.readFile(path.join(entry.parentPath,entry.name));
      assert(!content.includes(Buffer.from('fixture-key-')),'provider credentials must not be written to runtime files');
    }
    assert.equal(sessions.filter(session=>session!==openai).every(session=>!session.threadId||session.threadId===original.threadId),true);
  }finally{
    for(const session of sessions)session.dispose();
    server.kill('SIGTERM');await provider.close();await fs.rm(root,{recursive:true,force:true});
  }
});
