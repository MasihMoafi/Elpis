const crypto=require('node:crypto');
const {readSettings,writeSetting}=require('./settings-data');
const views=new Map();
const sections=[['general','General'],['configuration','Configuration'],['personalization','Personalization'],['usage','Usage & billing'],['mcp','MCP servers'],['hooks','Hooks'],['plugins','Plugins'],['account','Account']];
function showSettings(vscode,context,{root,connectionOptions,action,section}) {
  if(section!==undefined&&!sections.some(([id])=>id===section))throw Error('Unknown settings section.');
  const key=root.toString();
  if(views.has(key)){const panel=views.get(key);panel.reveal();if(section)panel.webview.postMessage({type:'navigate',section});return;}
  const panel=vscode.window.createWebviewPanel('elpis.settings','Elpis settings',vscode.ViewColumn.Active,{enableScripts:true,localResourceRoots:[vscode.Uri.joinPath(context.extensionUri,'assets')]});
  views.set(key,panel);
  const uri=file=>panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri,'assets',file));
  const nonce=crypto.randomBytes(18).toString('base64');
  panel.webview.html=`<!doctype html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${panel.webview.cspSource}; script-src 'nonce-${nonce}';"><link rel="stylesheet" href="${uri('style.css')}"><title>Elpis settings</title></head><body>
<main class="flex h-screen bg-base-100 text-base-content"><aside class="w-44 shrink-0 border-r border-base-300 p-3"><h1 class="text-lg font-semibold px-3 py-4">Settings</h1><nav aria-label="Settings sections"><ul class="menu menu-sm w-full">${sections.map(([id,label])=>`<li><button type="button" data-section="${id}">${label}</button></li>`).join('')}</ul></nav></aside><section class="flex-1 min-w-0 overflow-y-auto p-6"><div class="max-w-3xl mx-auto"><div class="flex items-center justify-between"><h2 id="title" class="text-xl font-semibold">General</h2><button id="refresh" class="btn btn-sm btn-ghost" type="button">Refresh</button></div><p id="notice" class="py-3 text-sm break-all" role="status" aria-live="polite"></p><div id="content" class="flex flex-col gap-4"></div></div></section></main><script nonce="${nonce}" src="${uri('settings.js')}"></script></body></html>`;
  const listener=panel.webview.onDidReceiveMessage(async message=>{
    try {
      if(message.type==='ready'){panel.webview.postMessage({type:'navigate',section:section||'general'});return;}
      if(message.type==='load') {
        if(!sections.some(([id])=>id===message.section))throw new Error('Unknown settings section.');
        const data=await readSettings(root.fsPath,await connectionOptions(),message.section);
        const config=vscode.workspace.getConfiguration('elpis',root);
        panel.webview.postMessage({type:'data',requestId:message.requestId,section:message.section,data,preferences:{sendShortcut:config.get('sendShortcut','Enter'),editorAccess:config.get('editorAccess',true),accountSource:config.get('accountSource','elpis'),followupBehavior:config.get('followupBehavior','queue'),showContextUsage:config.get('showContextUsage',false)}});
      } else if(message.type==='save') {
        await writeSetting(root.fsPath,await connectionOptions(),message.key,message.value,message.version);
        panel.webview.postMessage({type:'saved',text:'Saved. Applies to new conversations.'});
      } else if(message.type==='preference') {
        const config=vscode.workspace.getConfiguration('elpis',root);
        if(message.key==='accountSource' && ['elpis','codex'].includes(message.value))await action({type:'accountSource',value:message.value});
        else if(message.key==='sendShortcut' && ['Enter','Ctrl+Enter'].includes(message.value)) await config.update('sendShortcut',message.value,vscode.ConfigurationTarget.WorkspaceFolder);
        else if(message.key==='followupBehavior' && ['queue','steer'].includes(message.value))await config.update('followupBehavior',message.value,vscode.ConfigurationTarget.WorkspaceFolder);
        else if(message.key==='showContextUsage' && typeof message.value==='boolean')await config.update('showContextUsage',message.value,vscode.ConfigurationTarget.WorkspaceFolder);
        else if(message.key==='editorAccess' && typeof message.value==='boolean') {if(config.get('editorAccess',true)!==message.value) await action({type:'access'});}
        else throw new Error('Invalid editor preference.');
        panel.webview.postMessage({type:'saved',text:'Saved.'});
      } else if(message.type==='action') {
        if(!['config','provider','key','runtime','thinking'].includes(message.action))throw new Error('Unknown settings action.');
        await action({type:message.action});
        panel.webview.postMessage({type:'refresh'});
      }
    } catch(error){panel.webview.postMessage({type:'error',requestId:message.requestId,text:error.message});}
  });
  panel.onDidDispose(()=>{listener.dispose();views.delete(key);});
}
module.exports={showSettings};
