'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {spawn}=require('node:child_process');
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
const {once}=require('node:events');
const {Session}=require('../src/session');
const {Provider,message}=require('./runtime-eval');

test('local connection rejects an incompatible socket and conflicting server options',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'elpis-connect-'));
  const socket=path.join(root,'incompatible.sock');
  const server=require('node:net').createServer(peer=>{peer.resume();peer.end('not a WebSocket server\n');});
  const executable=process.env.ELPIS_EDITOR_TEST_RUNTIME || path.join(__dirname,'../bin/elpis-app-server');
  try {
    server.listen(socket);await once(server,'listening');
    await assert.rejects(promisify(execFile)(executable,['--connect',socket],{timeout:10000}),/could not connect to the local app-server/);
    await assert.rejects(promisify(execFile)(executable,['--connect',socket,'--listen','off'],{timeout:10000}),/cannot be used with/);
  }finally{await new Promise(resolve=>server.close(resolve));await fs.rm(root,{recursive:true,force:true});}
});

async function until(predicate) {
  const deadline=Date.now()+10000;
  while(!predicate()) {
    if(Date.now()>deadline)throw Error('Shared-runtime condition timed out');
    await new Promise(resolve=>setTimeout(resolve,20));
  }
}

test('two clients observe the same running turn and the observer can interrupt it',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'elpis-shared-')),home=path.join(root,'home');
  await fs.mkdir(home);
  const provider=new Provider();await provider.start();
  await fs.writeFile(path.join(home,'config.toml'),`model="gpt-5.4"\nmodel_provider="shared_eval"\n[model_providers.shared_eval]\nname="Shared eval"\nbase_url=${JSON.stringify(provider.url)}\nwire_api="responses"\nrequires_openai_auth=false\n`);
  const socket=path.join(home,'server.sock');
  const executable=process.env.ELPIS_EDITOR_TEST_RUNTIME || path.join(__dirname,'../bin/elpis-app-server');
  const env={...process.env,ELPIS_HOME:home,CODEX_HOME:home};
  const server=spawn(executable,['--listen',`unix://${socket}`,'--session-source','cli'],{cwd:root,env,stdio:'ignore'});
  const options={home,executable,transport:{args:['--connect',socket],env}};
  const owner=new Session(root,{cancel(){}},options);let observer,lateObserver,unrelated;
  try {
    await until(()=>require('node:fs').existsSync(socket));
    const missing=new Session(root,{cancel(){}},{...options,transport:{args:['--connect',path.join(home,'missing.sock')],env}});
    try {await assert.rejects(missing.connect(),/disconnected/);}finally{missing.dispose();}
    assert.equal(require('node:fs').existsSync(path.join(home,'missing.sock')),false);
    await owner.connect();
    provider.actions.push(message('INITIAL_REPLY'));
    await Promise.all([once(owner,'completed',{signal:AbortSignal.timeout(10000)}),owner.send('Initialize shared history')]);
    observer=new Session(root,{cancel(){}},{...options,resumeThreadId:owner.threadId});
    await observer.connect();
    const seen=[];observer.on('user',text=>seen.push(text));
    provider.actions.push({hang:true});
    await owner.send('EXTERNAL_USER_SENTINEL');
    await until(()=>observer.turnId!==null);
    assert.equal(observer.busy,true,'observer reports idle during another client’s turn');
    await until(()=>seen.length>0);
    assert.deepEqual(seen,['EXTERNAL_USER_SENTINEL']);
    await until(()=>provider.requests.length===2);
    lateObserver=new Session(root,{cancel(){}},{...options,resumeThreadId:owner.threadId});
    const attached=await lateObserver.connect();
    assert.equal(attached.thread.turns.at(-1).status,'inProgress');
    assert.equal(lateObserver.busy,true,'attaching during a response must retain its active state');
    assert.equal(lateObserver.turnId,owner.turnId);
    await observer.cancel();
    await until(()=>!owner.busy&&!observer.busy);
    assert.equal(owner.threadId,observer.threadId);
    provider.actions.push(message('SHARED_REPLY_SENTINEL'));
    const ownMessages=[];observer.on('user',text=>ownMessages.push(text));
    await Promise.all([once(observer,'completed',{signal:AbortSignal.timeout(10000)}),observer.send('IDE follow-up')]);
    assert.deepEqual(ownMessages,['IDE follow-up'],'local send must not echo twice');
    assert.equal(provider.requests.length,3);
    owner.dispose();
    unrelated=new Session(root,{cancel(){}},options);
    provider.actions.push(message('OTHER_THREAD_REPLY'));
    await Promise.all([once(unrelated,'completed',{signal:AbortSignal.timeout(10000)}),unrelated.send('Other conversation')]);
    assert.deepEqual(ownMessages,['IDE follow-up'],'unrelated conversations must not leak into the observer');
    assert.equal(observer.busy,false);
  } finally {
    owner.dispose();observer?.dispose();lateObserver?.dispose();unrelated?.dispose();
    if(server.exitCode===null&&server.signalCode===null){const exited=once(server,'exit');server.kill('SIGKILL');await exited;}
    await provider.close();
    await fs.rm(root,{recursive:true,force:true});
  }
});
