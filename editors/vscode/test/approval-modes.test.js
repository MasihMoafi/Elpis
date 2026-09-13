'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {Session}=require('../src/session');
const {Provider,message}=require('./runtime-eval');
const {EventEmitter}=require('node:events');
test('permission changes wait for application and reject a disconnected runtime',async()=>{
  const session=new Session('/fixture',{cancel(){}},{approvalMode:'ask'});
  const rpc=new EventEmitter();
  session.rpc=rpc;session.threadId='fixture';
  rpc.request=async()=>({});
  let applied=false;
  const change=session.setApprovalMode('full').then(()=>{applied=true;});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(applied,false,'queued acknowledgement must not announce success');
  assert.equal(session.options.approvalMode,'ask');
  rpc.emit('notification',{method:'thread/settings/updated',params:{threadId:'another',threadSettings:{sandboxPolicy:{type:'dangerFullAccess'},approvalPolicy:'never'}}});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(applied,false,'another conversation cannot confirm this change');
  rpc.emit('notification',{method:'thread/settings/updated',params:{threadId:'fixture',threadSettings:{sandboxPolicy:{type:'dangerFullAccess'},approvalPolicy:'never'}}});
  await change;
  assert.equal(rpc.listenerCount('notification'),0);
  const disconnected=assert.rejects(session.setApprovalMode('auto'),/lost connection/);
  await new Promise(resolve=>setImmediate(resolve));
  rpc.emit('disconnect',new Error('lost connection'));
  await disconnected;
  assert.equal(rpc.listenerCount('notification'),0);
  assert.equal(rpc.listenerCount('disconnect'),0);
});
test('real runtime changes sandbox and reviewer on the same resumed conversation',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'elpis-permissions-'));
  let threadId;
  const provider=new Provider();await provider.start();
  const home=path.join(root,'home');await fs.mkdir(home);
  await fs.writeFile(path.join(home,'config.toml'),`model="gpt-5.4"\nmodel_provider="mode_eval"\n[model_providers.mode_eval]\nname="Mode eval"\nbase_url=${JSON.stringify(provider.url)}\nwire_api="responses"\nrequires_openai_auth=false\n`);
  try {
    for(const [mode,sandbox,policy,reviewer] of [['ask','readOnly','on-request','user'],['auto','workspaceWrite','on-request','auto_review'],['full','dangerFullAccess','never','user'],['ask','readOnly','on-request','user']]){
      const session=new Session(root,{cancel(){}},{home,transport:{env:{...process.env,CODEX_HOME:home,ELPIS_HOME:home}},executable:process.env.ELPIS_EDITOR_TEST_RUNTIME || path.join(__dirname,'../bin/elpis-app-server'),approvalMode:mode,...(threadId?{resumeThreadId:threadId}:{})});
      try {
        let result=await session.connect();
        if(threadId){
          await session.setApprovalMode(mode);
          result=await session.rpc.request('thread/resume',{threadId});
        }
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
