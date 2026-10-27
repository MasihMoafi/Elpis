import { createTestTempDir, removeTestTempDir } from './temp-root.cjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {EventEmitter} from 'node:events';
import {DesktopClient} from '../bridge/client.mjs';

const rootId='00000000-0000-0000-0000-000000000001';
const fake=fileURLToPath(new URL('../../../tools/elpis-claude/test/fake-acp-agent.mjs',import.meta.url));
function fixture(t) {
  const cache=path.join(os.homedir(),'.cache/elpis-tests');fs.mkdirSync(cache,{recursive:true});
  const dir=createTestTempDir(path.join(cache,'elpis-workflow-routing-')), specs=[];
  const socket=new EventEmitter();socket.sent=[];socket.close=()=>{};
  socket.send=wire=>{const request=JSON.parse(wire);socket.sent.push(request);queueMicrotask(()=>{
    const result=request.method==='thread/read'||request.method==='thread/resume'
      ? {thread:{id:rootId,cwd:dir,source:'appServer',status:{type:'idle'},model:'root-model',modelProvider:'openai'}}
      : request.method==='workGraph/list'?{data:[]}:{};
    socket.emit('message',JSON.stringify({id:request.id,result}));
  });};
  const client=new DesktopClient(socket,{workflowOptions:{stateDir:path.join(dir,'state'),nodeSpec:node=>{
    specs.push(node);
    return {name:node.name,instructions:node.prompt,command:node.provider==='unavailable'?path.join(dir,'missing-agent'):process.execPath,args:[fake],env:{FAKE_ACP_MODELS:node.model},model:node.model};
  }}});
  t.after(()=>{client.close();removeTestTempDir(dir);});
  const finished=async id=>{
    for(let n=0;n<300;n++) {
      const found=(await client.workflows(rootId)).data.find(row=>row.id===id);
      if(found?.status!=='running')return found;
      await new Promise(resolve=>setTimeout(resolve,10));
    }
    throw Error('ACP run did not finish');
  };
  return {socket,client,specs,finished};
}
const task={id:'inspect',title:'Inspect',instruction:'Report evidence',kind:'explore',dependsOn:[],writeScopes:[],acceptanceCriteria:['Evidence reported']};
const graph={rootThreadId:rootId,name:'Provider routing',tasks:[task]};

test('workflow ACP nodes inherit root routing and preserve explicit models and providers',async t=>{
  const f=fixture(t);
  for(const [override,provider,model] of [[{},'openai','root-model'],[{provider:'local_one',model:'custom/one'},'local_one','custom/one'],[{model:'other/model'},'openai','other/model'],[{provider:'claude',model:'claude/opus'},'claude','claude/opus']]) {
    const run=await f.client.runWorkflow({...graph,tasks:[{...task,...override}]});
    assert.equal((await f.finished(run.graphId)).status,'succeeded');
    assert.deepEqual([f.specs.at(-1).provider,f.specs.at(-1).model],[provider,model]);
  }
  assert.equal(f.socket.sent.some(row=>row.method.startsWith('workGraph/run')),false);
});

test('an unavailable ACP agent fails closed without a native fallback',async t=>{
  const f=fixture(t);
  const run=await f.client.runWorkflow({...graph,tasks:[{...task,provider:'unavailable',model:'custom/model'}]});
  const result=await f.finished(run.graphId);
  assert.equal(result.status,'failed');assert.match(result.tasks[0].failureReason,/ENOENT/);
  // Only Mother's read-only supervision of the failure follows (superviseNode); nothing retries the node natively.
  assert.deepEqual(f.specs.map(spec=>spec.name),['Inspect','Mother']);assert.equal(f.socket.sent.some(row=>row.method.startsWith('workGraph/run')),false);
});

test('invalid routing is refused before starting any ACP or native execution',async t=>{
  const f=fixture(t);
  for(const override of [{provider:'local'},{provider:'bad provider',model:'valid'},{model:'bad model'},{model:''}]) {
    await assert.rejects(f.client.runWorkflow({...graph,tasks:[{...task,...override}]}),/explicit model|ACP provider|ACP model|task model/);
  }
  assert.equal(f.specs.length,0);assert.equal(f.socket.sent.some(row=>row.method.startsWith('workGraph/run')),false);
});

// 27 Oct, a real sandbox run: the agent wrote elpis-check.txt in its own folder, the only place it may write, and the
// check failed because it looked only at the workspace root. A check is told where the agents it checks could write.
test('a check is told the folders the agents it checks could write in',async t=>{
  const f=fixture(t);
  const make={...task,id:'make',title:'Make the file',instruction:'Create elpis-check.txt',kind:'implement',writeScopes:['agents/make'],acceptanceCriteria:['elpis-check.txt says hello']};
  const check={...task,id:'check',title:'Check the file',instruction:'Check the file',kind:'verify',dependsOn:['make'],writeScopes:['agents/make/check'],acceptanceCriteria:['elpis-check.txt says hello']};
  const run=await f.client.runWorkflow({...graph,tasks:[make,check]});
  await f.finished(run.graphId);
  const prompt=f.specs.find(spec=>spec.name==='Check the file')?.prompt??'';
  assert.match(prompt,/agents you check could write only in: agents\/make\b/);
  assert.doesNotMatch(f.specs.find(spec=>spec.name==='Make the file').prompt,/agents you check/,'only a check gets this');
});
