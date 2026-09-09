const test=require('node:test');
const assert=require('node:assert/strict');
const {ApprovalQueue,reviewApproval}=require('../src/approvals');
test('inline approval requires a matching explicit choice; cancellation denies pending requests',async()=>{
  const events=[];const queue=new ApprovalQueue(event=>events.push(event));
  const pending=reviewApproval({}, {method:'item/commandExecution/requestApproval',params:{command:'echo INLINE_ONLY_SENTINEL',cwd:'/workspace'}},details=>queue.request(details));
  assert.match(events[0].detail,/INLINE_ONLY_SENTINEL/);
  assert.equal(queue.respond({id:'foreign',allow:true}),false);
  assert.equal(queue.respond({id:events[0].id,allow:true}),true);
  assert.equal(await pending,true);
  assert.equal(queue.respond({id:events[0].id,allow:true}),false);
  const denied=queue.request({detail:'second'});queue.cancel();assert.equal(await denied,false);
  assert.equal(queue.respond({id:events.at(-1).id,allow:true}),false);
});
