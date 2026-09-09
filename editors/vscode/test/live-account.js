'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
async function liveAccountEvaluation({vscode,root,evidence,eventually,EditorBridge,Session}) {
  const uri=vscode.Uri.joinPath(root,'live-account.ts');
  const disk='export function liveValue(): string { return "disk_value"; }\nconst liveResult: number = liveValue();\n';
  await fs.writeFile(uri.fsPath,disk);
  const document=await vscode.workspace.openTextDocument(uri),editor=await vscode.window.showTextDocument(document);
  const sentinel='LIVE_UNSAVED_'+crypto.randomUUID();
  await editor.edit(edit=>edit.replace(new vscode.Range(document.positionAt(0),document.positionAt(disk.length)),disk.replace('disk_value',sentinel)));
  await eventually(()=>vscode.languages.getDiagnostics(uri).some(d=>d.code===2322),'live fixture has a real type error');
  const bridge=new EditorBridge(vscode,root,{approvalMode:()=>'auto'});
  const session=new Session(root.fsPath,bridge,{executable:process.env.ELPIS_EDITOR_TEST_RUNTIME,home:path.join(process.env.ELPIS_EDITOR_TEST_DATA,'live-account-home'),accountSource:'codex',model:'gpt-5.6-luna',reasoningEffort:'low',approvalMode:'auto'});
  let reply='',timer;const calls=[];session.on('delta',text=>reply+=text);session.on('toolResult',result=>calls.push(result.tool));
  try {
    const done=new Promise((resolve,reject)=>{timer=setTimeout(()=>reject(new Error('Live IDE turn timed out')),90000);session.once('completed',turn=>turn.status==='failed'?reject(new Error(turn.error?.message || 'Live turn failed')):resolve());});
    await Promise.all([done,session.send(`Use only the editor tools on ${uri.toString()}. Read its current unsaved text and diagnostics. Fix the type mismatch with editor_propose_edit and editor_apply_edit, then check editor_diagnostics again. Preserve the function's string value exactly. Do not save the file. In your final answer include the exact string value you found and the final diagnostic result.`)]);
    assert(calls.includes('editor_read'));assert(calls.includes('editor_apply_edit'));assert(calls.filter(name=>name==='editor_diagnostics').length>=2);
    assert(reply.includes(sentinel),'live model must report the value only present in the unsaved buffer');
    assert(document.getText().includes(sentinel));assert.equal(await fs.readFile(uri.fsPath,'utf8'),disk,'live edit must not save');
    await eventually(()=>!vscode.languages.getDiagnostics(uri).some(d=>d.code===2322),'live model fix clears actual diagnostic');
    evidence.results.push({name:'Live Codex-account Luna reads unsaved value, edits through IDE tools and verifies diagnostics without saving',passed:true,tools:calls});
  }finally{clearTimeout(timer);session.dispose();bridge.dispose();}
}
module.exports={liveAccountEvaluation};
