const test=require('node:test');
const assert=require('node:assert/strict');
const {setSmartPruning,ledgerSnapshot}=require('../src/smart-pruning');
test('chat includes a reachable Context Ledger and Smart Pruning controls',()=>{
  const {panelHtml}=require('../src/panel');
  const html=panelHtml({Uri:{joinPath:(_root,file)=>file}},{asWebviewUri:p=>p,cspSource:'test'},'/extension');
  for(const id of ['ledger-open','context-ledger','smart-pruning-toggle','ledger-attribution','ledger-goal'])assert.ok(html.includes(`id="${id}"`),id);
});

test('Smart Pruning enable and disable use versioned runtime configuration, never history pruning',async()=>{
  for(const enabled of [true,false]){
    const calls=[];
    const rpc={request:async(method,params)=>{calls.push({method,params});return method==='config/read'?{layers:[{name:{type:'user'},version:'v1'}]}:{};}};
    await setSmartPruning(rpc,'/project',enabled);
    assert.deepEqual(calls.map(c=>c.method),['config/read','config/batchWrite']);
    assert.deepEqual(calls[1].params,{edits:[{keyPath:'features.automatic_context_pruning',value:enabled,mergeStrategy:'replace'}],expectedVersion:'v1',reloadUserConfig:true});
  }
});
test('missing configuration version cannot silently enable Smart Pruning',async()=>{
  const calls=[];const rpc={request:async m=>{calls.push(m);return {layers:[]};}};
  await assert.rejects(setSmartPruning(rpc,'/project',true),/version/i);
  assert.deepEqual(calls,['config/read']);
});
test('old runtime cannot enable legacy history pruning through the Smart Pruning action',async()=>{
 const {Session}=require('../src/session');const session=new Session('/project',{},{});session.connect=async()=>{};
 let writes=0;session.rpc={request:async()=>{writes++;return {};}};
 await assert.rejects(session.setSmartPruning(true),/runtime.*Smart Pruning/i);assert.equal(writes,0);
});
test('closing a session clears ledger evidence rather than showing it for another conversation',()=>{
 const {Session}=require('../src/session');const session=new Session('/project',{cancel(){}},{});
 session.contextUsage={last:{totalTokens:123}};session.smartPrune={enabled:true,approxSavedTokens:456};
 assert.equal(session.ledger().used,123);session.dispose();assert.equal(session.ledger().used,null);assert.equal(session.ledger().enabled,null);
});
test('ledger uses last request context and distinguishes optimizer cost from estimated reduction',()=>{
  const state=ledgerSnapshot({last:{totalTokens:1200},total:{totalTokens:9000},modelContextWindow:10000},{enabled:true,approxSavedTokens:400,optimizerUsage:{totalTokens:700},admittedOutputs:1,failedBatches:2});
  assert.equal(state.used,1200);assert.equal(state.percent,12);assert.equal(state.saved,400);assert.equal(state.optimizerTokens,700);assert.equal(state.failures,2);
  const unknown=ledgerSnapshot();assert.equal(unknown.used,null);assert.equal(unknown.enabled,null);assert.equal(unknown.saved,null);
});
