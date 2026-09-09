'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { AppServer } = require('../src/rpc');
const { Session } = require('../src/session');
const { providers, runtimeOptions } = require('../src/providers');

test('history only lists and reads chats from this workspace', async () => {
  const {listHistory,readHistory,transcript}=require('../src/history');
  const root=process.cwd();
  const options={executable:process.execPath,transport:{args:['-e', `require('readline').createInterface({input:process.stdin}).on('line',line=>{
    const m=JSON.parse(line);if(m.id===undefined)return;
    const own={id:'own',cwd:${JSON.stringify(root)},preview:'known history',turns:[{items:[{type:'userMessage',content:[{type:'text',text:'prompt'}]},{type:'agentMessage',text:'reply'}]}]};
    const foreign={...own,id:'foreign',cwd:'/outside-workspace'};
    console.log(JSON.stringify({id:m.id,result:m.method==='thread/list'?{data:[own,foreign],nextCursor:null}:m.method==='thread/read'?{thread:m.params.threadId==='own'?own:foreign}:{}}));
  });`]}};
  assert.deepEqual((await listHistory(root,options)).threads.map(t=>t.id),['own']);
  assert.deepEqual(transcript(await readHistory(root,options,'own')).map(m=>m.text),['prompt','reply']);
  await assert.rejects(readHistory(root,options,'foreign'), /different workspace/);
});

test('selected effort reaches turn/start while the default stays unspecified', async () => {
  for (const effort of ['', 'high']) {
    const bridge={cancel(){}};
    const session=new Session(process.cwd(), bridge, {executable:process.execPath, reasoningEffort:effort, transport:{args:['-e', `
      require('readline').createInterface({input:process.stdin}).on('line', line=>{
        const m=JSON.parse(line);if(m.id===undefined)return;
        if(m.method==='turn/start' && (m.params.effort || '') !== ${JSON.stringify(effort)}) return console.log(JSON.stringify({id:m.id,error:{message:'wrong effort'}}));
        console.log(JSON.stringify({id:m.id,result:m.method==='thread/start'?{thread:{id:'t'},model:'test'}:m.method==='turn/start'?{turn:{id:'turn'}}:{}}));
      });`]} });
    try { await session.send('test'); } finally { session.dispose(); }
  }
});

test('runtime-only models replace the static OpenAI list', () => {
  const { modelChoices } = require('../src/providers');
  const catalog = [{label:'Runtime-only model', model:'runtime-only-sentinel', description:'runtime-only-sentinel'}];
  for (const provider of ['', 'openai']) {
    assert(modelChoices(provider, '', catalog).some(x => x.model === 'runtime-only-sentinel'));
    assert(!modelChoices(provider, '', []).some(x => x.model === 'runtime-only-sentinel'));
    assert(!modelChoices(provider, '', catalog).some(x => x.model === 'gpt-5.4'));
  }
});

test('catalog loads every page without starting a chat; server errors stay errors', async () => {
  const { loadModels } = require('../src/model-catalog');
  const fixture = `require('readline').createInterface({input:process.stdin}).on('line', line => {
    const m=JSON.parse(line); if(m.id === undefined) return;
    if(m.method==='initialize') return console.log(JSON.stringify({id:m.id,result:{}}));
    if(m.method!=='model/list') return console.log(JSON.stringify({id:m.id,error:{message:'must not start a thread'}}));
    if(process.env.CATALOG_FAIL) return console.log(JSON.stringify({id:m.id,error:{message:'catalog unavailable'}}));
    const result=m.params.cursor ? {data:[{model:'second-only',displayName:'Second'}],nextCursor:null} : {data:[{model:'first-only',displayName:'First'},{model:'hidden-only',hidden:true}],nextCursor:'next'};
    console.log(JSON.stringify({id:m.id,result}));
  });`;
  const options = {executable:process.execPath, transport:{args:['-e',fixture]}};
  const models = await loadModels(process.cwd(), options);
  assert.deepEqual(models.map(m=>m.model), ['first-only','second-only']);
  await assert.rejects(loadModels(process.cwd(), {...options, transport:{...options.transport, env:{...process.env,CATALOG_FAIL:'1'}}}), /catalog unavailable/);
});

test('model choices are provider-specific and retain custom IDs', () => {
  const { modelChoices } = require('../src/providers');
  for (const provider of providers.filter(p => p.id)) {
    const choices = modelChoices(provider.id, 'my-private-model');
    assert.equal(choices.filter(p => p.model && p.model !== 'my-private-model').length, 0);
    assert(choices.some(p => p.model === 'my-private-model'));
    assert(choices.some(p => p.custom));
    assert.equal(new Set(choices.filter(p => p.model).map(p => p.model)).size, choices.filter(p => p.model).length);
  }
  assert(modelChoices('').some(p => p.model === ''));
  assert(!modelChoices('anthropic').some(p => p.model?.startsWith('gpt-')));
  assert.throws(() => modelChoices('unsupported'), /Unsupported/);
});

test('provider selection reaches thread/start and final-only replies render once', async () => {
  for (const provider of providers.filter(p => p.id)) {
    const options = runtimeOptions({ provider: provider.id, model: 'chosen-model', executable: process.execPath }, 'test-secret');
    assert.deepEqual(options.env, { [provider.key]: 'test-secret' });
    const session = new Session(process.cwd(), { epoch: 0, cancel() {} }, { ...options, transport: { args: ['-e', `
      require('readline').createInterface({input:process.stdin}).on('line', line => {
        const m = JSON.parse(line); if (m.id === undefined) return;
        const result = m.method === 'initialize' ? {} : m.method === 'thread/start' ? {thread:{id:'t'}, model:m.params.model, modelProvider:m.params.modelProvider} : {turn:{id:'turn'}};
        console.log(JSON.stringify({id:m.id,result}));
        if (m.method === 'turn/start') {
          const completed = {method:'item/completed',params:{threadId:'t',item:{id:'reply',type:'agentMessage',text:'final reply'}}};
          console.log(JSON.stringify(completed)); console.log(JSON.stringify(completed));
          console.log(JSON.stringify({method:'turn/completed',params:{threadId:'t',turn:{id:'turn',status:'completed'}}}));
        }
      });`] } });
    let text = ''; session.on('delta', delta => text += delta);
    try {
      await session.connect(); assert(session.identity.includes(provider.id)); assert(session.identity.includes('chosen-model'));
      const done = new Promise(resolve => session.once('completed', resolve));
      await session.send('reply'); await done; assert.equal(text, 'final reply');
    } finally { session.dispose(); }
  }
  assert.throws(() => runtimeOptions({provider:'unknown'}), /Unsupported/);
  assert.deepEqual(runtimeOptions({provider:'anthropic'}).env, {});
});

test('RPC roundtrip and negative server error use distinct request IDs', async () => {
  const rpc = new AppServer(process.execPath, process.cwd(), { args: ['-e', `require('readline').createInterface({input:process.stdin}).on('line', l=>{const m=JSON.parse(l); console.log(JSON.stringify(m.method==='bad'?{id:m.id,error:{message:'rejected'}}:{id:m.id,result:{echo:m.params}}));})`] });
  try {
    const [a, b] = await Promise.all([rpc.request('echo', 'first'), rpc.request('echo', 'second')]);
    assert.equal(a.echo, 'first'); assert.equal(b.echo, 'second');
    await assert.rejects(rpc.request('bad', {}), /rejected/);
  } finally { rpc.dispose(); }
});
test('disconnect rejects outstanding calls and subsequent requests', async () => {
  const rpc = new AppServer(process.execPath, process.cwd(), { args: ['-e', 'process.stdin.once("data",()=>process.exit(7))'] });
  await assert.rejects(rpc.request('hang', {}), /disconnected/);
  await assert.rejects(rpc.request('again', {}), /disconnected/);
});
test('unresponsive runtime times out', async () => {
  const rpc = new AppServer(process.execPath, process.cwd(), { args: ['-e', 'process.stdin.resume()'] });
  try { await assert.rejects(rpc.request('hang', {}, 30), /timed out/); }
  finally { rpc.dispose(); }
});
test('simultaneous connection requests share one initialization and thread', async () => {
  const bridge = { epoch: 0, cancel() { this.epoch++; } };
  const session = new Session(process.cwd(), bridge, { executable: process.execPath, transport: { args: ['-e', `require('readline').createInterface({input:process.stdin}).on('line',l=>{const m=JSON.parse(l);if(m.id) setTimeout(()=>console.log(JSON.stringify({id:m.id,result:m.method==='initialize'?{userAgent:'test'}:{thread:{id:'one-thread'},model:'test'}})),10);})`] } });
  try {
    const [first, second] = await Promise.all([session.connect(), session.connect()]);
    assert.equal(first.thread.id, second.thread.id);
    assert.equal(session.rpc.nextId, 4, 'initialize, config/read and thread/start were sent exactly once');
  } finally { session.dispose(); }
});
