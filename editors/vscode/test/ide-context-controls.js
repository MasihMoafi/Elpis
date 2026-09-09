const assert=require('node:assert/strict');const path=require('node:path');const fs=require('node:fs/promises');
const {requestContext}=require('../src/ide-context');
module.exports=async({vscode,root,document,sentinel,home,eventually,evidence,provider,data})=>{
 const editor=await vscode.window.showTextDocument(document);const previous=editor.selections;
 const offset=document.getText().indexOf(sentinel);assert(offset>=0);
 editor.selection=new vscode.Selection(document.positionAt(offset),document.positionAt(offset+sentinel.length));
 const config=vscode.workspace.getConfiguration('elpis',root);const socket=path.join(home,'ipc','ipc.sock');
 try{
  let response;await eventually(async()=>{try{response=await requestContext(socket,root.fsPath);return response.resultType==='success';}catch{return false;}},'CLI context service ready');
  assert.equal(response.result.ideContext.activeFile.activeSelectionContent,sentinel);
  assert(response.result.ideContext.openTabs.some(tab=>tab.fsPath===document.uri.fsPath));
  assert(!(await fs.readFile(document.uri.fsPath,'utf8')).includes(sentinel));
  assert.equal((await requestContext(socket,path.dirname(root.fsPath))).resultType,'error');
  await config.update('editorAccess',false,vscode.ConfigurationTarget.WorkspaceFolder);
  assert.equal((await requestContext(socket,root.fsPath)).resultType,'error');
  await config.update('editorAccess',true,vscode.ConfigurationTarget.WorkspaceFolder);
  assert.equal((await requestContext(socket,root.fsPath)).result.ideContext.activeFile.activeSelectionContent,sentinel);
  await require('./ide-context-cli')({root,home,provider,sentinel,eventually,evidence,data});
  evidence.results.push({name:'CLI /ide wire protocol receives actual unsaved selection and open tabs; disabled/foreign workspace do not',passed:true});
 }finally{editor.selections=previous;await config.update('editorAccess',true,vscode.ConfigurationTarget.WorkspaceFolder);}
};
