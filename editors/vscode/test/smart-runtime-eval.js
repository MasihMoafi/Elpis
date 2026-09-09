'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {Session}=require('../src/session');
const {Provider,message,call}=require('./runtime-eval');
async function run(executable){
 const results=[];
 for(const mode of ['off','on','malformed']){
  const home=await fs.mkdtemp(path.join(os.tmpdir(),'elpis-smart-eval-'));
  const provider=new Provider();await provider.start();
  const sentinel='SMART_IDE_FACT_739: src/shipping.ts:17 dispatch cutoff is 17:45';
  const raw=sentinel+'\n'+'ordinary repeated padding\n'.repeat(800);
  const config=`model="gpt-5.6-luna"\nmodel_provider="editor_eval"\n[features]\nautomatic_context_pruning=${mode!=='off'}\n[model_providers.editor_eval]\nname="Local Smart Pruning acceptance"\nbase_url=${JSON.stringify(provider.url)}\nwire_api="responses"\nrequires_openai_auth=false\n`;
  await fs.writeFile(path.join(home,'config.toml'),config);await fs.writeFile(path.join(home,'hooks.json'),'{"hooks":{}}');
  const bridge={epoch:0,cancel(){},execute:async()=>({text:raw,version:1})};
  const session=new Session(home,bridge,{executable,transport:{env:{...process.env,CODEX_HOME:home,ELPIS_HOME:home}}});
  const send=async text=>{
   const done=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Smart Pruning turn timed out')),90000);session.once('completed',turn=>{clearTimeout(timer);turn.status==='failed'?reject(Error(JSON.stringify(turn.error))):resolve(turn);});});
   await Promise.all([done,session.send(text)]);
  };
  try{
   provider.actions.push(message('Established context must survive.'));
   await send('Keep the original instruction and context exactly.');
   provider.actions.push(call('smart_read','editor_read',{uri:'file:///fixture/shipping.ts'}));
   if(mode!=='off')provider.actions.push(request=>{
    assert.match(JSON.stringify(request),/Elpis Smart Prune/);assert.ok(JSON.stringify(request).includes(sentinel));
    return message(mode==='malformed'?'invalid optimizer manifest':JSON.stringify({items:[{call_id:'smart_read',decision:'compact',content:sentinel}]}));
   });
   provider.actions.push(request=>{
    const before=provider.requests[1].body;
    assert.deepEqual(request.input.slice(0,before.input.length),before.input,'previous model-visible prefix changed');
    assert.equal(request.instructions,before.instructions);
    assert.deepEqual(request.tools,before.tools,'tool definitions changed in cached prefix');
    assert.equal(request.model,before.model,'model changed during admission');
    const output=request.input.find(item=>item.call_id==='smart_read'&&item.type==='function_call_output');assert.ok(output,'editor output reaches inference');
    const text=JSON.stringify(output);assert.ok(text.includes(sentinel),'required fact survives');
    assert.equal(text.includes('ordinary repeated padding'),mode!=='on','only successful enabled optimizer may replace originals');
    return message('SMART_IDE_FACT_739 preserved.');
   });
   await send('Read the editor result and preserve the cutoff fact.');
   if(provider.error)throw provider.error;
   assert.equal(provider.actions.length,0,'all intended runtime calls occurred');
   const snapshot=session.ledger();
   assert.equal(snapshot.enabled,mode!=='off');
   if(mode==='on'){assert.equal(snapshot.admitted,1);assert.ok(snapshot.saved>0);assert.ok(snapshot.optimizerTokens>0);}
   if(mode==='malformed'){assert.equal(snapshot.admitted,0);assert.equal(snapshot.failures,1);}
   results.push({mode,passed:true,home,snapshot});
  }finally{session.dispose();provider.close();await fs.writeFile(path.join(home,'provider-requests.json'),JSON.stringify(provider.requests,null,2));}
 }
 return results;
}
if(require.main===module)run(process.env.ELPIS_EDITOR_TEST_RUNTIME).then(results=>console.log(JSON.stringify(results,null,2))).catch(error=>{console.error(error);process.exitCode=1;});
module.exports={run};
