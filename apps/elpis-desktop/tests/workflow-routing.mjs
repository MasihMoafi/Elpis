import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {DesktopClient} from '../bridge/client.mjs';

function fixture({unsupported=false}={}) {
  const socket=new EventEmitter();socket.sent=[];socket.close=()=>{};
  socket.send=wire=>{const request=JSON.parse(wire);socket.sent.push(request);queueMicrotask(()=>{
    let result={};
    if(request.method==='thread/read'||request.method==='thread/resume')result={thread:{id:'00000000-0000-0000-0000-000000000001',source:'appServer',status:{type:'idle'},model:'root-model',modelProvider:'openai'}};
    if(request.method==='workGraph/runWithProviders'&&unsupported){socket.emit('message',JSON.stringify({id:request.id,error:{code:-32601,message:'Unknown method workGraph/runWithProviders'}}));return;}
    if(request.method.startsWith('workGraph/run'))result={graphId:'graph',threadId:'00000000-0000-0000-0000-000000000001',turnId:'workflow-turn'};
    socket.emit('message',JSON.stringify({id:request.id,result}));
  });};
  return {socket,client:new DesktopClient(socket)};
}
const task={id:'inspect',title:'Inspect',instruction:'Report evidence',kind:'explore',dependsOn:[],writeScopes:[],acceptanceCriteria:['Evidence reported']};
const graph={rootThreadId:'00000000-0000-0000-0000-000000000001',name:'Provider routing',tasks:[task]};

test('workflow inheritance uses legacy method; explicit routing is preserved and uses new native method',async()=>{
  const {client,socket}=fixture();try {
    await client.runWorkflow(graph);
    assert.deepEqual(socket.sent.find(row=>row.method==='workGraph/run').params,graph);
    const explicit={...graph,tasks:[{...task,provider:'local_one',model:'custom/one'},{...task,id:'second',provider:'local_two',model:'custom/two',dependsOn:['inspect']}]};
    await client.runWorkflow(explicit);
    assert.deepEqual(socket.sent.find(row=>row.method==='workGraph/runWithProviders').params,explicit);
    await client.runWorkflow({...graph,tasks:[{...task,model:'other/native-model'}]});
    assert.deepEqual(socket.sent.filter(row=>row.method==='workGraph/runWithProviders')[1].params.tasks,[{...task,model:'other/native-model'}]);
  }finally{client.close();}
});

test('old runtimes fail closed for task routing without a legacy retry',async()=>{
  const {client,socket}=fixture({unsupported:true});try {
    await assert.rejects(client.runWorkflow({...graph,tasks:[{...task,provider:'local',model:'custom/native'}]}),error=>error.status===503&&/Update and restart Elpis/.test(error.message));
    assert.equal(socket.sent.filter(row=>row.method==='workGraph/runWithProviders').length,1);
    assert.equal(socket.sent.some(row=>row.method==='workGraph/run'),false);
  }finally{client.close();}
});

test('missing model, subscription routes, and invalid model IDs never reach native execution',async()=>{
  const {client,socket}=fixture();try {
    for(const override of [{provider:'local'},{provider:'claude',model:'native'},{provider:'agy',model:'native'},{model:'claude/opus'},{model:'agy/gemini'},{model:'bad model'},{model:''}]) {
      await assert.rejects(client.runWorkflow({...graph,tasks:[{...task,...override}]}),/explicit model|native provider|native model|task model/);
    }
    assert.equal(socket.sent.some(row=>row.method.startsWith('workGraph/run')),false);
  }finally{client.close();}
});
