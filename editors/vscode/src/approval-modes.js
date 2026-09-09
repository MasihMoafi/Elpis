'use strict';
const modes = [
  {id:'ask',label:'Ask for approval',short:'Ask',reviewEdits:true,description:'Review editor edits and native permission requests.',runtime:{sandbox:'read-only',approvalPolicy:'on-request',approvalsReviewer:'user'}},
  {id:'auto',label:'Approve for me',short:'Auto',reviewEdits:false,description:'Allow workspace edits; Elpis reviews native permission escalations.',runtime:{sandbox:'workspace-write',approvalPolicy:'on-request',approvalsReviewer:'auto_review'}},
  {id:'full',label:'Full access',short:'Full',reviewEdits:false,description:'Allow editor edits and native commands without sandbox or approval prompts.',runtime:{sandbox:'danger-full-access',approvalPolicy:'never',approvalsReviewer:'user'}},
];
function approvalMode(id='ask') {
  const mode=modes.find(mode=>mode.id===id);
  if(!mode)throw new Error(`Unknown approval mode: ${id}`);
  return mode;
}
module.exports={modes,approvalMode};
