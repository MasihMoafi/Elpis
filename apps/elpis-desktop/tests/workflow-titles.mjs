import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {DesktopClient} from '../bridge/client.mjs';
const uuid = n => `00000000-0000-0000-0000-${String(n).padStart(12,'0')}`;
const ROOT=uuid(1), GRAPH=uuid(20);
function fixture({unsupported=false}={}) {
  const threads=[
    {id:uuid(2),parentThreadId:ROOT,source:{subAgent:{other:`work_graph:${GRAPH}:inspect`}}},
    {id:uuid(3),name:'Chosen conversation name',parentThreadId:ROOT,source:{subAgent:{other:`work_graph:${GRAPH}:review`}}},
    {id:uuid(4),parentThreadId:ROOT,source:{subAgent:{other:`work_graph:${uuid(21)}:wrong_graph`}}},
    {id:uuid(5),parentThreadId:ROOT,source:{subAgent:{other:`work_graph:${GRAPH}:wrong_task`}}},
    {id:uuid(6),parentThreadId:ROOT,source:{subAgent:{other:`work_graph:${GRAPH}:wrong_assigned`}}},
    {id:uuid(7),parentThreadId:ROOT,source:{subAgent:{thread_spawn:{agent_path:'/root/unrelated'}}}},
  ].map(thread=>({...thread,preview:'You are a bounded worker in this workspace.',model:'shared-model',cwd:'/same/workspace',status:{type:'idle'}}));
  const records={data:[{id:GRAPH,tasks:[
    {id:'inspect',title:'Inspect endpoint A',assignedThreadId:uuid(2)},
    {id:'review',title:'Review endpoint B',assignedThreadId:uuid(3)},
    {id:'wrong_graph',title:'Wrong graph title',assignedThreadId:uuid(4)},
    {id:'another_task',title:'Wrong task title',assignedThreadId:uuid(5)},
    {id:'wrong_assigned',title:'Wrong assigned title',assignedThreadId:uuid(7)},
  ]}]};
  const calls=[];
  class Socket extends EventEmitter { send(raw){const request=JSON.parse(raw);if(!request.id)return;calls.push(request);queueMicrotask(()=>{const result=request.method==='thread/list'?{data:threads}:request.method==='thread/read'?{thread:threads.find(thread=>thread.id===request.params.threadId)}:request.method==='thread/items/list'?{data:[]}:request.method==='workGraph/list'?records:{};this.emit('message',JSON.stringify(request.method==='workGraph/list'&&unsupported?{id:request.id,error:{code:-32601,message:'Unknown method'}}:{id:request.id,result}));});} close(){} }
  return {client:new DesktopClient(new Socket()),calls};
}
test('workflow titles require exact graph, task and assigned thread; explicit names are preserved',async()=>{
  const {client,calls}=fixture();try{
    await client.initialize();const rows=(await client.listThreads()).data;
    assert.equal(rows[0].workflowTaskTitle,'Inspect endpoint A');
    assert.equal(rows[1].workflowTaskTitle,'Review endpoint B');assert.equal(rows[1].name,'Chosen conversation name');
    for(const row of rows.slice(2))assert.equal(row.workflowTaskTitle,undefined,'An unrelated graph, task or thread must not receive a recorded title');
    assert.deepEqual(calls.filter(call=>call.method==='workGraph/list').map(call=>call.params),[{rootThreadId:ROOT}]);
    assert.equal((await client.readThread(uuid(2))).thread.workflowTaskTitle,'Inspect endpoint A');
  }finally{client.close();}
});
test('unavailable authoritative graph records preserve safe thread fallbacks',async()=>{
  const {client}=fixture({unsupported:true});try{await client.initialize();const rows=(await client.listThreads()).data;assert.ok(rows.length);assert.ok(rows.every(thread=>thread.workflowTaskTitle===undefined));}finally{client.close();}
});
