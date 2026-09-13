'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const net=require('node:net');
const {spawn}=require('node:child_process');
const {once}=require('node:events');
const {Session}=require('../src/session');
const {Provider,message}=require('./runtime-eval');

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
  const reservation=net.createServer();reservation.listen(0,'127.0.0.1');await once(reservation,'listening');
  const port=reservation.address().port;await new Promise(resolve=>reservation.close(resolve));
  const endpoint=`ws://127.0.0.1:${port}`;
  const server=spawn(process.env.ELPIS_EDITOR_TEST_RUNTIME || path.join(__dirname,'../bin/elpis-app-server'),['--listen',endpoint,'--session-source','cli'],{cwd:root,env:{...process.env,ELPIS_HOME:home,CODEX_HOME:home},stdio:'ignore'});
  const transport={args:['-e',`
    const socket=new WebSocket(${JSON.stringify(endpoint)});
    const lines=require('node:readline').createInterface({input:process.stdin});
    const pending=[];let ready=false;
    lines.on('line',line=>ready?socket.send(line):pending.push(line));
    socket.onopen=()=>{ready=true;for(const line of pending)socket.send(line);};
    socket.onmessage=event=>process.stdout.write(event.data+'\\n');
    socket.onerror=()=>process.exit(1);socket.onclose=()=>process.exit(0);
  `]};
  const options={home,executable:process.execPath,transport};
  const owner=new Session(root,{cancel(){}},options);let observer,lateObserver,unrelated;
  try {
    let ready=false;
    await until(()=>{if(!ready){const probe=net.connect(port,'127.0.0.1');probe.on('connect',()=>{ready=true;probe.destroy();});probe.on('error',()=>{});}return ready;});
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
