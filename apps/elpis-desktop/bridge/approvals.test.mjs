import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { DesktopClient } from './client.mjs';
import { browserMcpConfig } from './browser-mcp.mjs';

const threadId = '00000000-0000-0000-0000-000000000001';
const schema = {type:'object',properties:{count:{type:'integer',minimum:1,maximum:4},email:{type:'string',format:'email'},enabled:{type:'boolean'},tags:{type:'array',items:{type:'string',enum:['a','b']},minItems:1,maxItems:2}},required:['count','email','enabled']};
async function fixture(t) {
  const socket = new EventEmitter(); socket.sent=[]; socket.close=()=>{};
  socket.send=raw=>{const request=JSON.parse(raw);socket.sent.push(request);if(request.method)queueMicrotask(()=>socket.emit('message',JSON.stringify({id:request.id,result:request.method==='thread/list'?{data:[{id:threadId,status:{type:'active'}}],nextCursor:null}:{thread:{id:threadId}}})));};
  const client=new DesktopClient(socket);t.after(()=>client.close());await client.listThreads();
  let next=100;
  const request=(method,params)=>{const wireId=++next;socket.emit('message',JSON.stringify({id:wireId,method,params:{threadId,...params}}));const approval=client.pendingApprovals.at(-1);assert.ok(approval,`${method} must reach the card`);return {id:approval.id,wireId};};
  const answer=(pending,body,result)=>{client.answerApproval(pending.id,body);assert.deepEqual(socket.sent.at(-1),{id:pending.wireId,result});assert.throws(()=>client.answerApproval(pending.id,body),/no longer pending/);};
  return {client,socket,request,answer};
}
test('MCP tool approvals round-trip only advertised persistence and TUI actions',async t=>{
  const f=await fixture(t);const params={serverName:'fixture',mode:'form',message:'Run browser_open?',requestedSchema:{type:'object',properties:{}},_meta:{codex_approval_kind:'mcp_tool_call',tool_name:'browser_open',tool_params:{url:'https://example.test'},persist:['session','always']}};
  for(const [action,persist] of [['accept',null],['accept','session'],['accept','always'],['cancel',null]]){const p=f.request('mcpServer/elicitation/request',params);const body={action,content:null,_meta:persist?{persist}:null};f.answer(p,body,body);}
  const p=f.request('mcpServer/elicitation/request',{...params,_meta:{...params._meta,persist:undefined}});
  assert.throws(()=>f.client.answerApproval(p.id,{action:'accept',content:null,_meta:{persist:'session'}}),/offered/);
  assert.throws(()=>f.client.answerApproval(p.id,{action:'decline',content:null,_meta:null}),/offered/);
  assert.equal(f.client.pendingApprovals.length,1);
  f.answer(p,{action:'accept',content:null,_meta:null},{action:'accept',content:null,_meta:null});
});
test('MCP forms validate typed content and keep invalid answers pending',async t=>{
  const f=await fixture(t);const params={serverName:'survey',mode:'form',message:'Details',requestedSchema:schema};
  const p=f.request('mcpServer/elicitation/request',params);
  for(const content of [{count:'2'},{count:0,email:'bad',enabled:false},{count:2,email:'a@b.test',enabled:'false'},{count:2,email:'a@b.test',enabled:false,tags:['c']},{count:2,email:'a@b.test',enabled:false,extra:'no'}])assert.throws(()=>f.client.answerApproval(p.id,{action:'accept',content,_meta:null}));
  assert.equal(f.client.pendingApprovals.length,1);
  const body={action:'accept',content:{count:2,email:'a@b.test',enabled:false,tags:['a']},_meta:null};f.answer(p,body,body);
  for(const action of ['decline','cancel']){const p=f.request('mcpServer/elicitation/request',params);f.answer(p,{action,content:null,_meta:null},{action,content:null,_meta:null});}
});
test('permissions grant turn/session/strict review or deny without granting extra scope',async t=>{
  const f=await fixture(t);const permissions={network:{enabled:true},fileSystem:{read:['/fixture'],write:null}};
  for(const response of [{permissions,scope:'turn'},{permissions,scope:'session'},{permissions,scope:'turn',strictAutoReview:true},{permissions:{},scope:'turn'}]){const p=f.request('item/permissions/requestApproval',{permissions,reason:'Need fixture access',cwd:'/fixture'});f.answer(p,response,response);}
  const p=f.request('item/permissions/requestApproval',{permissions});
  for(const body of [{permissions,scope:'forever'},{permissions,scope:['turn']},{permissions:{fileSystem:{write:['/other']}},scope:'session'},{permissions,scope:'session',strictAutoReview:true}])assert.throws(()=>f.client.answerApproval(p.id,body));
  assert.equal(f.client.pendingApprovals.length,1);
});
test('unknown future approval still reports its method',async t=>{
  const f=await fixture(t);const events=[];f.client.on('event',e=>events.push(e));f.socket.emit('message',JSON.stringify({id:500,method:'future/requestApproval',params:{threadId}}));assert.equal(f.socket.sent.at(-1).error.code,-32601);assert.equal(events.at(-1).data.method,'future/requestApproval');
});
test('browser config gates opening once per chat and approves interactions in the engine',()=>{
  const config=browserMcpConfig('/tmp/fixture.sock')['mcp_servers.elpis_browser'];
  assert.equal(config.default_tools_approval_mode,'approve');assert.deepEqual(config.tools,{browser_open:{approval_mode:'auto'}});
});
