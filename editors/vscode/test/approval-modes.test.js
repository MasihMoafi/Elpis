'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {Session}=require('../src/session');
const {Provider,message}=require('./runtime-eval');
test('real runtime changes sandbox and reviewer on the same resumed conversation',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'elpis-permissions-'));
  let threadId;
  const provider=new Provider();await provider.start();
  const home=path.join(root,'home');await fs.mkdir(home);
  await fs.writeFile(path.join(home,'config.toml'),`model="gpt-5.4"\nmodel_provider="mode_eval"\n[model_providers.mode_eval]\nname="Mode eval"\nbase_url=${JSON.stringify(provider.url)}\nwire_api="responses"\nrequires_openai_auth=false\n`);
  try {
    for(const [mode,sandbox,policy,reviewer] of [['ask','readOnly','on-request','user'],['auto','workspaceWrite','on-request','auto_review'],['full','dangerFullAccess','never','user'],['ask','readOnly','on-request','user']]){
      const session=new Session(root,{cancel(){}},{home,executable:process.env.ELPIS_EDITOR_TEST_RUNTIME || path.join(__dirname,'../bin/elpis-app-server'),approvalMode:mode,...(threadId?{resumeThreadId:threadId}:{})});
      try {
        const result=await session.connect();
        assert.equal(result.sandbox.type,sandbox);assert.equal(result.approvalPolicy,policy);assert.equal(result.approvalsReviewer,reviewer);
        if(threadId)assert.equal(session.threadId,threadId);
        else {
          assert.equal(session.hasTurns,false);
          provider.actions.push(message('MODE_CONTINUITY_SENTINEL'));
          const done=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Mode fixture timed out')),15000);session.once('completed',turn=>{clearTimeout(timer);turn.status==='failed'?reject(new Error(JSON.stringify(turn.error))):resolve();});});
          await Promise.all([done,session.send('Create the mode continuity fixture.')]);
          assert.equal(session.hasTurns,true);threadId=session.threadId;
        }
      }finally{session.dispose();}
    }
  }finally{await provider.close();await fs.rm(root,{recursive:true,force:true});}
});
