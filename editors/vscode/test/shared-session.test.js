'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {spawn}=require('node:child_process');
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
const {once}=require('node:events');
const {Session}=require('../src/session');
const {AppServer}=require('../src/rpc');
const {Provider,message,call}=require('./runtime-eval');

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
  let ownerReads=0,observerReads=0,disconnectOwner=false;
  const owner=new Session(root,{cancel(){},async execute(){
    ownerReads++;
    if(disconnectOwner){owner.dispose();return new Promise(()=>{});}
    return {text:'OWNER_ONLY_SENTINEL'};
  }},options);let observer,lateObserver,unrelated,terminal;
  try {
    await until(()=>require('node:fs').existsSync(socket));
    const missing=new Session(root,{cancel(){}},{...options,transport:{args:['--connect',path.join(home,'missing.sock')],env}});
    try {await assert.rejects(missing.connect(),/disconnected/);}finally{missing.dispose();}
    assert.equal(require('node:fs').existsSync(path.join(home,'missing.sock')),false);
    await owner.connect();
    provider.actions.push(message('INITIAL_REPLY'));
    await Promise.all([once(owner,'completed',{signal:AbortSignal.timeout(10000)}),owner.send('Initialize shared history')]);
    observer=new Session(root,{cancel(){},async execute(){observerReads++;return {text:'OBSERVER_SENTINEL'};}},{...options,resumeThreadId:owner.threadId});
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
    provider.actions.push(call('owner_only','editor_documents',{}),message('SHARED_REPLY_SENTINEL'));
    const ownMessages=[];observer.on('user',text=>ownMessages.push(text));
    await Promise.all([once(observer,'completed',{signal:AbortSignal.timeout(10000)}),observer.send('IDE follow-up')]);
    assert.deepEqual(ownMessages,['IDE follow-up'],'local send must not echo twice');
    assert.equal(ownerReads,1);
    assert.equal(observerReads,0,'watching a conversation must not execute its editor tool twice');
    assert(JSON.stringify(provider.requests.at(-1).body.input).includes('OWNER_ONLY_SENTINEL'));
    assert.equal(provider.requests.length,4);
    disconnectOwner=true;
    provider.actions.push(call('owner_disconnect','editor_documents',{}),message('DISCONNECT_HANDLED'));
    await Promise.all([once(observer,'completed',{signal:AbortSignal.timeout(10000)}),observer.send('Handle owner disconnect')]);
    assert.equal(ownerReads,2);
    assert.equal(observerReads,0,'do not replay a possibly executed tool after its owner disconnects');
    assert(JSON.stringify(provider.requests.at(-1).body.input).includes('dynamic tool request failed'));
    provider.actions.push(call('new_owner','editor_documents',{}),message('HANDOFF_REPLY'));
    await Promise.all([once(observer,'completed',{signal:AbortSignal.timeout(10000)}),observer.send('Use remaining editor')]);
    assert.equal(observerReads,1,'the remaining registered editor should own subsequent calls');
    assert(JSON.stringify(provider.requests.at(-1).body.input).includes('OBSERVER_SENTINEL'));
    unrelated=new Session(root,{cancel(){}},options);
    provider.actions.push(message('OTHER_THREAD_REPLY'));
    await Promise.all([once(unrelated,'completed',{signal:AbortSignal.timeout(10000)}),unrelated.send('Other conversation')]);
    assert.deepEqual(ownMessages,['IDE follow-up','Handle owner disconnect','Use remaining editor'],'unrelated conversations must not leak into the observer');
    assert.equal(observer.busy,false);
    terminal=new AppServer(executable,root,options.transport);
    await terminal.request('initialize',{clientInfo:{name:'terminal_observer',version:'1'},capabilities:{experimentalApi:true}});
    terminal.send({method:'initialized'});
    await terminal.request('thread/resume',{threadId:observer.threadId});
    for(const editor of [observer,lateObserver])await editor.rpc.request('thread/unsubscribe',{threadId:editor.threadId});
    let terminalCompleted=false;
    terminal.on('notification',event=>{if(event.method==='turn/completed')terminalCompleted=true;});
    provider.actions.push(call('no_owner','editor_documents',{}),message('NO_OWNER_HANDLED'));
    await terminal.request('turn/start',{threadId:observer.threadId,input:[{type:'text',text:'Handle absent editor'}]});
    await until(()=>terminalCompleted);
    assert(JSON.stringify(provider.requests.at(-1).body.input).includes('No connected client owns'));
    assert.equal(observerReads,1,'a detached editor must not execute new tool calls');
  } finally {
    owner.dispose();observer?.dispose();lateObserver?.dispose();unrelated?.dispose();terminal?.dispose();
    if(server.exitCode===null&&server.signalCode===null){const exited=once(server,'exit');server.kill('SIGKILL');await exited;}
    await provider.close();
    await fs.rm(root,{recursive:true,force:true});
  }
});
