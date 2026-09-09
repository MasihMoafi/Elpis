const test = require('node:test');
const assert = require('node:assert/strict');
const {Session} = require('../src/session');
const {reviewApproval} = require('../src/approvals');

test('review UI shows actual commands and file diffs; dismissal and missing details deny', async () => {
  let detail, choice = true;
  const vscode={};const review=async options=>{detail=options.detail;return choice;};
  const command={method:'item/commandExecution/requestApproval',params:{command:'echo actual-sentinel',cwd:'/workspace',reason:'Test'}};
  assert.equal(await reviewApproval(vscode,command,review),true);
  assert(detail.includes('echo actual-sentinel') && detail.includes('/workspace'));
  choice=undefined;
  assert.equal(await reviewApproval(vscode,command,review),false);
  const file={method:'item/fileChange/requestApproval',params:{},item:{changes:[{path:'/workspace/a',diff:'-before\n+after'}]}};
  choice=true;
  assert.equal(await reviewApproval(vscode,file,review),true);
  assert(detail.includes('-before\n+after') && detail.includes('/workspace/a'));
  assert.equal(await reviewApproval(vscode,{...file,item:undefined}),false);
});

test('Cancel invalidates approval before the runtime finishes interrupting', async () => {
  let response;
  const rpc = {request:async()=>({}),respond:(_id,result)=>{response=result;}};
  const session = new Session('/workspace', {cancel(){}}, {approve:async()=>{await session.cancel();return true;}});
  session.rpc=rpc; session.threadId='thread'; session.turnId='turn'; session.busy=true;
  await session.handleRequest({id:1,method:'item/commandExecution/requestApproval',params:{threadId:'thread',turnId:'turn'}},rpc);
  assert.equal(session.busy,true);
  assert.deepEqual(response,{decision:'decline'});
});

test('permission approval grants exactly the requested profile for one turn', async () => {
  for (const approved of [true,false]) {
    let response;
    const session=new Session('/workspace',{}, {approve:async()=>approved});
    session.threadId='thread';session.turnId='turn';session.busy=true;
    const permissions={network:{enabled:true},fileSystem:null};
    await session.handleRequest({id:1,method:'item/permissions/requestApproval',params:{threadId:'thread',turnId:'turn',permissions}}, {respond:(_id,result)=>{response=result;}});
    assert.deepEqual(response,{permissions:approved?permissions:{},scope:'turn'});
  }
});

test('native command approvals reach the reviewer and respect its decision', async () => {
  for (const approved of [true, false]) {
    let reviewed = false, response;
    const session = new Session('/workspace', {}, {approve:async request=>{reviewed=true;assert.equal(request.params.command, 'echo sentinel');return approved;}});
    session.threadId = 'thread'; session.turnId = 'turn'; session.busy = true;
    await session.handleRequest({id:1,method:'item/commandExecution/requestApproval',params:{threadId:'thread',turnId:'turn',command:'echo sentinel'}}, {respond:(_id,result)=>{response=result;}});
    assert.equal(reviewed,true);
    assert.deepEqual(response,{decision:approved?'accept':'decline'});
  }
});

test('late approval after cancellation and foreign-thread requests stay declined', async () => {
  let response, reviewed = 0;
  const session = new Session('/workspace', {}, {approve:async()=>{reviewed++;session.busy=false;return true;}});
  session.threadId='thread'; session.turnId='turn'; session.busy=true;
  const rpc={respond:(_id,result)=>{response=result;}};
  await session.handleRequest({id:1,method:'item/commandExecution/requestApproval',params:{threadId:'thread',turnId:'turn'}},rpc);
  assert.deepEqual(response,{decision:'decline'});
  session.busy=true;
  await session.handleRequest({id:2,method:'item/commandExecution/requestApproval',params:{threadId:'foreign',turnId:'turn'}},rpc);
  assert.equal(reviewed,1);
  assert.deepEqual(response,{decision:'decline'});
});
