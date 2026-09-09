'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {Session}=require('../src/session');
const {Provider,message}=require('./runtime-eval');
const {listHistory,readHistory,changeHistory}=require('../src/history');
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
