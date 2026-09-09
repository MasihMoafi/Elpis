'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {Session}=require('../src/session');const {Provider,message,call}=require('./runtime-eval');
async function fixture(run) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'elpis-followup-')),home=path.join(root,'home');await fs.mkdir(home);
  const provider=new Provider();await provider.start();
  await fs.writeFile(path.join(home,'config.toml'),`model="gpt-5.4"\nmodel_context_window=128000\nmodel_provider="followup_eval"\n[model_providers.followup_eval]\nname="Followup eval"\nbase_url=${JSON.stringify(provider.url)}\nwire_api="responses"\nrequires_openai_auth=false\n`);
  let release,started;const gate=new Promise(r=>release=r),reading=new Promise(r=>started=r);
  const bridge={epoch:0,cancel(){this.epoch++;release();},async execute(){started();await gate;return {text:'TOOL_GATE_SENTINEL'};}};
  const session=new Session(root,bridge,{home,executable:process.env.ELPIS_EDITOR_TEST_RUNTIME || path.join(__dirname,'../bin/elpis-app-server')});
  let timer;const deadline=new Promise((_,reject)=>timer=setTimeout(()=>reject(new Error('Follow-up fixture timed out')),20000));
  try{await Promise.race([run({session,provider,reading,release,root}),deadline]);}
  finally{clearTimeout(timer);session.dispose();await provider.close();await fs.rm(root,{recursive:true,force:true});}
}
test('queued follow-up waits, then reaches a new real runtime turn',()=>fixture(async({session,provider,reading,release,root})=>{
  provider.actions.push(call('gate','editor_read',{uri:'file://'+root+'/fixture.txt'}),message('FIRST_TURN_COMPLETE'),request=>{assert(JSON.stringify(request.input).includes('QUEUED_SENTINEL'));return message('QUEUED_TURN_COMPLETE');});
  let completed=0;const done=new Promise(resolve=>session.on('completed',()=>{if(++completed===2)resolve();}));
  await session.send('Read the fixture.');await reading;
  session.enqueue('QUEUED_SENTINEL');assert.equal(provider.requests.length,1,'queue must not send during the active turn');
  release();await done;assert.equal(provider.requests.length,3);assert.equal(session.queued.length,0);
}));
test('steer reaches the active turn and rejects an idle steer',()=>fixture(async({session,provider,reading,release,root})=>{
  provider.actions.push(call('gate','editor_read',{uri:'file://'+root+'/fixture.txt'}),request=>{assert(JSON.stringify(request.input).includes('STEER_SENTINEL'));return message('STEER_COMPLETE');});
  const done=new Promise(resolve=>session.once('completed',resolve));
  await session.send('Read the fixture.');await reading;
  await session.steer('STEER_SENTINEL');release();await done;
  await assert.rejects(session.steer('DO_NOT_SEND'),/active turn/);assert.equal(provider.requests.length,2);
}));
test('Stop pauses queued work without discarding it; explicit resume sends it',()=>fixture(async({session,provider,reading,root})=>{
  provider.actions.push(call('gate','editor_read',{uri:'file://'+root+'/fixture.txt'}),message('FIRST_FINISHED'));
  await session.send('Read the fixture.');await reading;session.enqueue('PAUSED_QUEUE_SENTINEL');
  const stopped=new Promise(resolve=>session.once('completed',resolve));await session.cancel();await stopped;
  assert.equal(session.queuePaused,true);assert.equal(session.queued.length,1);
  assert(!provider.requests.some(request=>JSON.stringify(request.body.input).includes('PAUSED_QUEUE_SENTINEL')));
  provider.actions.length=0;provider.actions.push(request=>{assert(JSON.stringify(request.input).includes('PAUSED_QUEUE_SENTINEL'));return message('RESUMED_QUEUE');});
  const resumed=new Promise(resolve=>session.once('completed',resolve));await session.resumeQueue();await resumed;assert.equal(session.queued.length,0);
}));
