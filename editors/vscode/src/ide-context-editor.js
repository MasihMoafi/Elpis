'use strict';
const fs=require('node:fs/promises');const path=require('node:path');
const {EditorBridge}=require('./editor');const {runtimeHome}=require('./runtime-query');
async function readEditorContext(vscode,workspaceRoot,home){
 if(!vscode.workspace.isTrusted)return null;
 const requested=await fs.realpath(workspaceRoot).catch(()=>null);if(!requested)return null;
 const folder=(vscode.workspace.workspaceFolders||[]).find(folder=>folder.uri.scheme==='file'&&vscode.workspace.getWorkspaceFolder(vscode.Uri.file(requested))?.uri.toString()===folder.uri.toString());
 if(!folder)return null;
 const config=vscode.workspace.getConfiguration('elpis',folder.uri);
 if(!config.get('editorAccess',true)||runtimeHome({home:config.get('home','')})!==home)return null;
 const bridge=new EditorBridge(vscode,vscode.Uri.file(requested));
 async function descriptor(uri){if(!uri||uri.scheme!=='file')return null;try{await bridge.uri(uri.toString());return {label:path.basename(uri.fsPath),path:path.relative(requested,uri.fsPath),fsPath:uri.fsPath};}catch{return null;}}
 const tabs=vscode.window.tabGroups.all.flatMap(group=>group.tabs).map(tab=>tab.input?.uri).filter(Boolean);
 const openTabs=(await Promise.all(tabs.slice(0,100).map(descriptor))).filter(Boolean);
 const editor=vscode.window.activeTextEditor;let activeFile=null;
 const range=selection=>({start:{line:selection.start.line,character:selection.start.character},end:{line:selection.end.line,character:selection.end.character}});
 if(editor){const file=await descriptor(editor.document.uri);if(file){const text=editor.document.getText(editor.selection);activeFile={...file,selection:range(editor.selection),selections:editor.selections.map(range),activeSelectionContent:text.length>65536?text.slice(0,65536)+'\n[Selection truncated at 65536 characters]':text};}}
 // Permission/trust may have changed while resolving real file paths.
 if(!vscode.workspace.isTrusted||!config.get('editorAccess',true))return null;
 return {ideContext:{activeFile,openTabs},focused:vscode.window.state.focused};
}
module.exports={readEditorContext};
