const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {call,message}=require('./runtime-eval');
module.exports=async({vscode,frame,page,provider,eventually,evidence,data,root})=>{
  const api=require('node:module').createRequire(path.join(vscode.extensions.getExtension('elpis-local.elpis-editor').extensionPath,'src/extension.js'))('vscode');
  const original=api.window.showWarningMessage;let modals=0;
  api.window.showWarningMessage=async()=>{modals++;throw Error('Runtime approval must stay inside Elpis');};
  try{
    for(const decision of ['reject','allow','stop']){
      const marker=path.join(root.fsPath,`inline-approval-${decision}`);
      provider.actions.push(request=>{
        const name=request.tools.some(tool=>tool.name==='exec_command')?'exec_command':'shell_command';
        const command=`printf INLINE_APPROVED > '${marker.replace(/'/g,"'\\''")}'`;
        return call(`inline_${decision}`,name,{...(name==='exec_command'?{cmd:command}:{command}),sandbox_permissions:'require_escalated',justification:'Exercise inline approval'});
      });
      if(decision!=='stop')provider.actions.push(()=>message(`INLINE_${decision}_COMPLETE`));
      await frame.locator('#prompt').fill(`Run the inline ${decision} approval test.`);await frame.locator('#send').click();
      await eventually(async()=>await frame.locator('[data-approval] button[data-allow="true"]').count(),'actual native command approval card');
      assert.equal(modals,0);assert(await frame.evaluate('d.querySelector("[data-approval] pre").textContent.includes("INLINE_APPROVED")'));
      await assert.rejects(fs.readFile(marker));
      if(decision==='allow')await page.screenshot({path:path.join(data,'inline-runtime-approval.png'),animations:'disabled'});
      if(decision==='stop')await frame.locator('#send').click();
      else await frame.locator(`[data-approval] button[data-allow="${decision==='allow'}"]`).click();
      await eventually(async()=>await frame.evaluate('d.getElementById("send").getAttribute("aria-label")==="Send message"'),'approval turn finished');
      if(decision==='allow')assert.equal(await fs.readFile(marker,'utf8'),'INLINE_APPROVED');else await assert.rejects(fs.readFile(marker));
      assert.equal(await frame.locator('[data-approval] button').count(),0,'resolved approval cannot be clicked again');
      await frame.locator('#reconnect').click();await eventually(async()=>await frame.evaluate('d.getElementById("messages").textContent.trim()===""'),'new chat after approval test');
    }
    evidence.results.push({name:'Inline native command approvals: Allow writes sentinel, Reject and Stop do not; no modal',passed:true});
  }finally{api.window.showWarningMessage=original;}
};
