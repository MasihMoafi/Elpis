'use strict';
const assert=require('node:assert/strict'),path=require('node:path');
const {message}=require('./runtime-eval');
async function followupControls({vscode,root,frame,page,provider,eventually,evidence,data}) {
  const config=vscode.workspace.getConfiguration('elpis',root);
  try {
    await config.update('followupBehavior','steer',vscode.ConfigurationTarget.WorkspaceFolder);
    await eventually(async()=>await frame.evaluate('!d.getElementById("send").disabled'),'connection ready for follow-up controls');
    provider.actions.push({hang:true});await frame.locator('#prompt').fill('Follow-up controls gate');await frame.locator('#send').click();
    await eventually(()=>provider.hanging.size>0,'follow-up turn active');
    await frame.locator('#prompt').fill('UI_STEER_SENTINEL');await frame.pointerClick('#prompt');await page.keyboard.press('Enter');
    await eventually(async()=>(await frame.locator('#messages').textContent()).includes('UI_STEER_SENTINEL'),'Enter steers when selected');
    await frame.locator('#prompt').fill('UI_QUEUED_SENTINEL');await frame.pointerClick('#prompt');await page.keyboard.press('Control+Enter');
    await eventually(async()=>(await frame.locator('#queued-list').textContent()).includes('UI_QUEUED_SENTINEL'),'opposite shortcut queues');
    const waitingRequests=provider.requests.length;
    await frame.locator('#prompt').fill('UI_REMOVE_SENTINEL');await frame.pointerClick('#prompt');await page.keyboard.press('Control+Enter');
    await eventually(async()=>await frame.evaluate('d.querySelectorAll("[data-queued]").length')===2,'second follow-up queued');
    const removeId=await frame.evaluate('[...d.querySelectorAll("[data-queued]")].find(e=>e.textContent.includes("UI_REMOVE_SENTINEL")).dataset.queued');
    await frame.locator(`[data-queued="${removeId}"] button`).click();
    await eventually(async()=>await frame.evaluate('d.querySelectorAll("[data-queued]").length')===1,'queued item removed');
    assert.equal(provider.requests.length,waitingRequests,'queue does not start a parallel turn');
    await frame.locator('#prompt').fill('Draft preserved with paused queue');await frame.locator('#send').click();
    await eventually(async()=>/interrupted|cancelled/i.test(await frame.locator('#status').textContent()),'Stop interrupts current turn');
    assert((await frame.locator('#queue-status').textContent()).includes('paused'));
    assert.equal(await frame.evaluate('d.getElementById("prompt").value'),'Draft preserved with paused queue');
    provider.actions.push(request=>{const input=JSON.stringify(request.input);assert(input.includes('UI_QUEUED_SENTINEL'));assert(!input.includes('UI_REMOVE_SENTINEL'));return message('FOLLOWUP_RESUMED');});
    await frame.locator('#resume-queue').click();
    await eventually(async()=>(await frame.locator('#messages').textContent()).includes('FOLLOWUP_RESUMED'),'visible Resume queue sends pending turn');
    await eventually(async()=>await frame.evaluate('d.getElementById("send").getAttribute("aria-label")==="Send message"'),'resumed turn completes');
    assert.equal(await frame.evaluate('d.getElementById("prompt").value'),'Draft preserved with paused queue');await frame.locator('#prompt').fill('');
    await config.update('showContextUsage',true,vscode.ConfigurationTarget.WorkspaceFolder);
    await eventually(async()=>await frame.evaluate('!d.getElementById("context-usage").classList.contains("hidden") && d.getElementById("context-usage").title.includes("520")'),'context toggle shows actual last-request usage');
    await page.screenshot({path:path.join(data,'followup-context-controls.png'),animations:'disabled'});
    await config.update('showContextUsage',false,vscode.ConfigurationTarget.WorkspaceFolder);
    await eventually(async()=>await frame.evaluate('d.getElementById("context-usage").classList.contains("hidden")'),'context toggle hides meter');
    await frame.evaluate('(()=>{api.postMessage({type:"followup",mode:"steer",text:"REJECTED_FOLLOWUP"});d.getElementById("prompt").value="NEW_DRAFT";return true;})()');
    await eventually(async()=>await frame.evaluate('d.getElementById("prompt").value.includes("REJECTED_FOLLOWUP") && d.getElementById("prompt").value.includes("NEW_DRAFT")'),'rejected follow-up preserves both drafts');await frame.locator('#prompt').fill('');
    evidence.results.push({name:'Visible Queue/Steer shortcuts, removal, Stop/pause/resume, draft recovery and context meter work against the real runtime',passed:true});
  }finally{await config.update('followupBehavior','queue',vscode.ConfigurationTarget.WorkspaceFolder);await config.update('showContextUsage',false,vscode.ConfigurationTarget.WorkspaceFolder);}
}
module.exports={followupControls};
