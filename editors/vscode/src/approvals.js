const {randomUUID}=require('node:crypto');
class ApprovalQueue {
  constructor(post){this.post=post;this.pending=new Map();}
  request(details){const id=randomUUID();return new Promise(resolve=>{this.pending.set(id,resolve);this.post({type:'approvalRequest',id,...details});});}
  respond({id,allow}){const resolve=this.pending.get(id);if(!resolve||typeof allow!=='boolean')return false;this.pending.delete(id);this.post({type:'approvalResolved',id,allowed:allow});resolve(allow);return true;}
  cancel(){for(const id of [...this.pending.keys()])this.respond({id,allow:false});}
}
async function reviewApproval(vscode, request, review) {
  const p = request.params;
  let detail;
  if (request.method === 'item/commandExecution/requestApproval') {
    if (!p.command) return false;
    detail = `Command: ${p.command}\nWorking directory: ${p.cwd || 'Not supplied'}\n${p.reason || ''}`;
  } else if (request.method === 'item/fileChange/requestApproval') {
    const changes = request.item?.changes;
    if (!Array.isArray(changes) || !changes.length) return false;
    detail = `${changes.map(change=>`File: ${change.path}\n${change.diff}`).join('\n\n')}\n${p.reason || ''}\nThese native changes write to disk.`;
  } else if (request.method === 'item/permissions/requestApproval') {
    if (!p.permissions) return false;
    detail = `Requested permissions for this turn:\n${JSON.stringify(p.permissions,null,2)}\n${p.reason || ''}`;
  } else return false;
  return typeof review==='function' && await review({title:'Allow this runtime action?',detail})===true;
}
module.exports = {reviewApproval,ApprovalQueue};
