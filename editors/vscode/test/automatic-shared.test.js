'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {once}=require('node:events');
const {Session}=require('../src/session');
const {listHistory}=require('../src/history');
const {Provider,message,call}=require('./runtime-eval');

async function until(predicate){
  const deadline=Date.now()+20000;
  while(!await predicate()){
    if(Date.now()>deadline)throw Error('Automatic shared startup timed out');
    await new Promise(resolve=>setTimeout(resolve,25));
  }
}

test('ordinary CLI startup creates one shared runtime and IDE attaches tools to its live chat',{
  skip:!process.env.ELPIS_EDITOR_TEST_CLI||process.env.ELPIS_EDITOR_TEST_AUTO_SHARED!=='1',
},async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'elpis-auto-shared-')),home=path.join(root,'home');
  await fs.mkdir(home);
  const provider=new Provider();await provider.start();
  await fs.writeFile(path.join(home,'config.toml'),`model="gpt-5.6-luna"\nmodel_provider="automatic_eval"\n[model_providers.automatic_eval]\nname="Automatic eval"\nbase_url=${JSON.stringify(provider.url)}\nwire_api="responses"\nrequires_openai_auth=false\n`);
  const cli=require('./shared-cli')({executable:process.env.ELPIS_EDITOR_TEST_CLI,root,home});
  let ide,observer;
  try {
    await until(()=>cli.text().includes('gpt-5.6-luna'));
    provider.actions.push(message('AUTOMATIC_CLI_REPLY'));
    await cli.send('AUTOMATIC_CLI_USER');
    await until(()=>cli.text().includes('AUTOMATIC_CLI_REPLY'));
    const options={home,executable:process.env.ELPIS_EDITOR_TEST_RUNTIME};
    const history=await listHistory(root,options);
    assert.equal(history.threads.length,1);
    let reads=0;
    ide=new Session(root,{cancel(){},async execute(){reads++;return {text:'AUTOMATIC_EDITOR_SENTINEL'};}},{...options,resumeThreadId:history.threads[0].id});
    await ide.connect();
    observer=new Session(root,{cancel(){},async execute(){throw Error('Observer must not execute tools');}},{...options,resumeThreadId:ide.threadId});
    await observer.connect();
    provider.actions.push(call('added_live','editor_documents',{}),request=>{
      assert(JSON.stringify(request.input).includes('AUTOMATIC_EDITOR_SENTINEL'));
      return message('AUTOMATIC_IDE_REPLY');
    });
    await Promise.all([once(ide,'completed',{signal:AbortSignal.timeout(10000)}),ide.send('IDE joins the still-open CLI')]);
    await until(()=>cli.text().includes('AUTOMATIC_IDE_REPLY'));
    assert.equal(reads,1);
    assert.equal((await listHistory(root,options)).threads.length,1);
    assert.equal(provider.requests.length,3);
    for(const [mode,sandbox,policy] of [['full','dangerFullAccess','never'],['auto','workspaceWrite','on-request'],['ask','readOnly','on-request']]){
      await ide.setApprovalMode(mode);
      await until(()=>observer.options.approvalMode===mode);
      const resumed=await observer.rpc.request('thread/resume',{threadId:ide.threadId});
      assert.equal(resumed.sandbox.type,sandbox);
      assert.equal(resumed.approvalPolicy,policy);
    }
  } finally {
    if(process.env.ELPIS_SHARED_CLI_LOG)await fs.writeFile(process.env.ELPIS_SHARED_CLI_LOG+'.json',JSON.stringify({providerError:provider.error?.message,requests:provider.requests},null,2));
    ide?.dispose();observer?.dispose();await cli.dispose();await provider.close();await fs.rm(root,{recursive:true,force:true});
  }
});
