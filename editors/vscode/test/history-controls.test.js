'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {Session}=require('../src/session');
const {Provider,message}=require('./runtime-eval');
const {listHistory,readHistory,changeHistory}=require('../src/history');
test('IDE discovers a CLI-origin thread and resumes its transcript under the same ID',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'elpis-cli-history-')),home=path.join(root,'home');await fs.mkdir(home);
  const provider=new Provider();await provider.start();
  await fs.writeFile(path.join(home,'config.toml'),`model="gpt-5.4"\nmodel_provider="cli_eval"\n[model_providers.cli_eval]\nname="CLI eval"\nbase_url=${JSON.stringify(provider.url)}\nwire_api="responses"\nrequires_openai_auth=false\n`);
  const options={home,executable:process.env.ELPIS_EDITOR_TEST_RUNTIME || path.join(__dirname,'../bin/elpis-app-server')};
  const cli=new Session(root,{cancel(){}},{...options,threadParams:{dynamicTools:[]},transport:{args:['--session-source','cli'],env:{...process.env,CODEX_HOME:home,ELPIS_HOME:home}}});
  let ide;
  const send=async(session,text,response)=>{
    provider.actions.push(message(response));
    let timer;
    try {await Promise.all([new Promise((resolve,reject)=>{timer=setTimeout(()=>reject(Error('Cross-client turn timed out')),15000);session.once('completed',turn=>turn.status==='failed'?reject(Error(JSON.stringify(turn.error))):resolve());}),session.send(text)]);}
    finally {clearTimeout(timer);}
  };
  try {
    await send(cli,'CLI prompt sentinel','CLI_RESPONSE_SENTINEL');
    const id=cli.threadId;cli.dispose();
    assert.equal((await readHistory(root,options,id)).source,'cli');
    assert((await listHistory(root,options)).threads.some(t=>t.id===id),'IDE hid the CLI conversation');
    ide=new Session(root,{cancel(){}},{...options,resumeThreadId:id});
    await ide.connect();assert.equal(ide.threadId,id);
    assert.equal(ide.hasTurns,true,'resumed history must survive connection-setting changes');
    await assert.rejects(ide.rpc.request('thread/resume',{threadId:id,dynamicTools:[{type:'unknown',name:'editor_read'}]}),/invalid/i);
    await assert.rejects(ide.rpc.request('thread/resume',{threadId:id,dynamicTools:[{name:'different_tool',description:'Different capability',inputSchema:{type:'object',properties:{}}}]}),/cannot replace dynamic tools/);
    await send(ide,'IDE continuation sentinel','IDE_RESPONSE_SENTINEL');
    assert(JSON.stringify(provider.requests.at(-1).body).includes('CLI_RESPONSE_SENTINEL'),'IDE continuation lost CLI history');
    assert(JSON.stringify(provider.requests.at(-1).body.tools).includes('editor_read'),'resumed CLI conversation has no live editor tools');
    ide.dispose();
    const thread=await readHistory(root,options,id);
    assert(JSON.stringify(thread).includes('CLI_RESPONSE_SENTINEL'));
    assert(JSON.stringify(thread).includes('IDE_RESPONSE_SENTINEL'));
    assert.equal(provider.requests.length,2);
  }finally{cli.dispose();ide?.dispose();await provider.close();await fs.rm(root,{recursive:true,force:true});}
});
test('real history renames, archives and restores; foreign-workspace changes are rejected',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'elpis-history-')),home=path.join(root,'home');await fs.mkdir(home);
  const provider=new Provider();await provider.start();
  await fs.writeFile(path.join(home,'config.toml'),`model="gpt-5.4"\nmodel_provider="history_eval"\n[model_providers.history_eval]\nname="History eval"\nbase_url=${JSON.stringify(provider.url)}\nwire_api="responses"\nrequires_openai_auth=false\n`);
  const options={home,executable:process.env.ELPIS_EDITOR_TEST_RUNTIME || path.join(__dirname,'../bin/elpis-app-server')};
  const session=new Session(root,{cancel(){}},options);let timer;
  try {
    provider.actions.push(message('HISTORY_BODY_SENTINEL'));
    const done=new Promise((resolve,reject)=>{timer=setTimeout(()=>reject(new Error('History fixture timed out')),15000);session.once('completed',turn=>turn.status==='failed'?reject(new Error(JSON.stringify(turn.error))):resolve());});
    await Promise.all([done,session.send('History fixture')]);
    const id=session.threadId;session.dispose();await fs.mkdir(path.join(root,'foreign'));
    await assert.rejects(changeHistory(path.join(root,'foreign'),options,id,'archive'),/different workspace/);
    assert((await listHistory(root,options)).threads.some(t=>t.id===id));
    await changeHistory(root,options,id,'rename','Renamed history sentinel');
    assert.equal((await readHistory(root,options,id)).name,'Renamed history sentinel');
    await changeHistory(root,options,id,'archive');
    assert(!(await listHistory(root,options)).threads.some(t=>t.id===id));
    assert((await listHistory(root,options,'',undefined,true)).threads.some(t=>t.id===id));
    await changeHistory(root,options,id,'restore');
    assert((await listHistory(root,options)).threads.some(t=>t.id===id));
    assert(JSON.stringify(await readHistory(root,options,id)).includes('HISTORY_BODY_SENTINEL'));
    await assert.rejects(changeHistory(root,options,id,'delete'),/Unknown/);
  }finally{clearTimeout(timer);session.dispose();await provider.close();await fs.rm(root,{recursive:true,force:true});}
});
