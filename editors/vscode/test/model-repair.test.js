const test=require('node:test');
const assert=require('node:assert/strict');
const {transcript}=require('../src/history');
const {errorText}=require('../src/error-text');
const {effortForModel}=require('../src/model-catalog');
const {toolView}=require('../src/tool-view');
test('tool history retains actual results and thinking exposes summaries only',()=>{
  const tool={type:'dynamicToolCall',tool:'editor_read',success:true,status:'completed',contentItems:[{type:'inputText',text:'{"text":"UNSAVED_HISTORY_SENTINEL"}'}]};
  const saved=transcript({turns:[{items:[tool],status:'completed'}]});
  assert.equal(saved[0].role,'Tool');assert(saved[0].detail.includes('UNSAVED_HISTORY_SENTINEL'));
  assert.deepEqual(transcript({turns:[{items:[],status:'completed'}]}),[]);
  assert.equal(toolView({type:'reasoning',summary:['Visible summary'],content:['PRIVATE_RAW_SENTINEL']}).detail,'Visible summary');
  assert.equal(toolView({type:'reasoning',summary:[],content:['PRIVATE_RAW_SENTINEL']}),null);
});
test('adapted model selection keeps supported effort and uses the advertised fallback',()=>{
  const preset={efforts:['low','high'],defaultEffort:'low'};
  assert.equal(effortForModel(preset,'high'),'high');
  assert.equal(effortForModel(preset,'unsupported'),'low');
  assert.equal(effortForModel(undefined,'high'),'high');
});
test('provider JSON errors show their message and plain errors stay intact',()=>{
  assert.equal(errorText('{"error":{"message":"Usage limit reached","type":"quota"}}'),'Usage limit reached');
  assert.equal(errorText('Usage limit reached'),'Usage limit reached');
  assert.equal(errorText('{"unexpected":true}'),'{"unexpected":true}');
});
test('reopened failed chats retain their error instead of looking unanswered',()=>{
  const items=[{type:'userMessage',content:[{type:'text',text:'hello'}]}];
  const failed=transcript({turns:[{items,status:'failed',error:{message:'Usage limit sentinel'}}]});
  assert.deepEqual(failed,[{role:'You',text:'hello'},{role:'Could not complete the request',text:'Usage limit sentinel'}]);
  assert.deepEqual(transcript({turns:[{items,status:'completed'}]}),[{role:'You',text:'hello'}]);
});
