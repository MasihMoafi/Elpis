'use strict';
const vscode = require('vscode');
const fs = require('node:fs');
const path = require('node:path');
const { runtimeHome } = require('./runtime-query');
const { EditorBridge } = require('./editor');
const { Session } = require('./session');
const { panelHtml } = require('./panel');
const { providers, selectedProvider, runtimeOptions, modelChoices } = require('./providers');
const { loadModels, effortForModel, configuredModel } = require('./model-catalog');
const { loadProviderModels } = require('./provider-catalog');
const { reviewApproval, ApprovalQueue } = require('./approvals');
const {showSettings}=require('./settings-panel');
const {toolView}=require('./tool-view');
const {approvalMode}=require('./approval-modes');
const { listHistory, readHistory, transcript, changeHistory } = require('./history');

function activate(context) {
  const contextServices=new Map();let contextDisposed=false;
  async function refreshContextServices(){
    const homes=new Set((vscode.workspace.workspaceFolders||[]).filter(folder=>folder.uri.scheme==='file').map(folder=>runtimeHome({home:vscode.workspace.getConfiguration('elpis',folder.uri).get('home','')})));
    for(const [home,promise] of contextServices)if(!homes.has(home)){contextServices.delete(home);void promise.then(service=>service?.dispose());}
    for(const home of homes)if(!contextServices.has(home)&&process.platform!=='win32'){
      const promise=require('./ide-context').startContextService({home,readContext:root=>require('./ide-context-editor').readEditorContext(vscode,root,home)}).catch(error=>{console.error('Elpis IDE context unavailable:',error.message);return null;});
      contextServices.set(home,promise);if(contextDisposed)void promise.then(service=>service?.dispose());
    }
  }
  context.subscriptions.push({dispose(){contextDisposed=true;for(const promise of contextServices.values())void promise.then(service=>service?.dispose());}},vscode.workspace.onDidChangeWorkspaceFolders(()=>void refreshContextServices()),vscode.workspace.onDidChangeConfiguration(event=>{if(event.affectsConfiguration('elpis.home'))void refreshContextServices();}));
  void refreshContextServices();
  const panels = new Map();
  async function openChat(panel) {
    if (!vscode.workspace.isTrusted) { vscode.window.showWarningMessage('Trust the workspace before starting Elpis.'); return; }
    const roots = vscode.workspace.workspaceFolders || [];
    let root;
    if (roots.length) {
      root = roots.length === 1 ? roots[0] : (await vscode.window.showQuickPick(roots.map(root => ({ label: root.name, root })) ))?.root;
    } else {
      const document = vscode.window.activeTextEditor?.document.uri;
      if (document?.scheme === 'file') {
        const directory = path.dirname(document.fsPath);
        root = { name: path.basename(directory), uri: vscode.Uri.file(directory) };
      } else {
        const uri = vscode.Uri.joinPath(context.globalStorageUri, 'chat-workspace');
        await vscode.workspace.fs.createDirectory(uri);
        root = { name: 'New chat', uri: vscode.Uri.file(uri.fsPath) };
      }
    }
    if (!root) return;
    if (root.uri.scheme !== 'file') { vscode.window.showWarningMessage('Elpis currently supports local file workspaces.'); return; }
    const key = root.uri.toString();
    if (panels.has(key)) { panels.get(key).show(true); return; }
    panel.title = `Elpis · ${root.name}`;
    panel.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'assets')] };
    panels.set(key, panel);
    const config = () => vscode.workspace.getConfiguration('elpis', root.uri);
    const configTarget = roots.length ? vscode.ConfigurationTarget.WorkspaceFolder : vscode.ConfigurationTarget.Global;
    const modeKey=`elpis.approvalMode.${key}`;
    const currentMode=()=>approvalMode(context.workspaceState.get(modeKey,'ask'));
    const bridge = new EditorBridge(vscode, root.uri, {approvalMode:()=>session?.options.approvalMode || currentMode().id});
    let session;
    const post = data => panel.webview.postMessage(data);
    const approvals=new ApprovalQueue(post);
    const postPreferences=()=>post({type:'preferences',sendShortcut:config().get('sendShortcut','Enter'),followupBehavior:config().get('followupBehavior','queue'),showContextUsage:config().get('showContextUsage',false)});
    async function connectionOptions() {
      const provider = selectedProvider(config().get('provider', ''));
      const apiKey = provider.key ? await context.secrets.get(`elpis.apiKey.${provider.id}`) : undefined;
      let executable = config().get('executable', 'elpis-app-server');
      const bundled = vscode.Uri.joinPath(context.extensionUri, 'bin', 'elpis-app-server').fsPath;
      if (executable === 'elpis-app-server' && fs.existsSync(bundled)) executable = bundled;
      return runtimeOptions({ executable, home: config().get('home', ''), accountSource: config().get('accountSource', 'elpis'), provider: provider.id, model: config().get('model', ''), reasoningEffort:config().get('reasoningEffort', ''), approve:request=>reviewApproval(vscode,request,details=>approvals.request(details)) }, apiKey);
    }
    async function createSession(resumeThreadId,mode=currentMode().id) {
      const s = new Session(root.uri.fsPath, bridge, {...await connectionOptions(), approvalMode:mode, ...(resumeThreadId ? {resumeThreadId} : {})});
      for (const type of ['user', 'delta', 'status','failure']) s.on(type, text => { if (s !== session) return; post({ type, text }); if (s.identity) { post({ type: 'identity', text: s.identity }); selection(); } });
      s.on('busy', busy => { if (s === session) {if(!busy)approvals.cancel();post({ type: 'busy', busy });} });
      s.on('queue',queue=>{if(s===session)post({type:'queue',...queue});});
      s.on('notification',message=>{if(s===session && message.method==='thread/tokenUsage/updated')post({type:'contextUsage',usage:message.params.tokenUsage});});
      s.on('notification',message=>{
        if(s!==session)return;
        if(['thread/tokenUsage/updated','thread/smartPrune/updated'].includes(message.method))post({type:'ledger',state:s.ledger()});
        if(message.method==='thread/goal/updated')post({type:'goal',goal:message.params.goal});
        if(message.method==='thread/goal/cleared')post({type:'goal',goal:null});
      });
      s.on('toolResult', result => {
        if(s!==session)return;
        post({type:'tool',...toolView({type:'dynamicToolCall',tool:result.tool,...result.result})});
      });
      s.on('notification',message=>{
        if(s!==session || message.method!=='item/completed' || message.params?.item?.type==='dynamicToolCall')return;
        const view=message.params?.item && toolView(message.params.item);if(view)post({type:'tool',...view});
      });
      s.on('disconnected', () => { if (s === session) {approvals.cancel();post({type:'ledger',state:s.ledger()});post({ type: 'identity', text: 'No runtime connected. Use New conversation / reconnect.' });} });
      return s;
    }
    session = await createSession();
    let menuModels = [];
    let catalogRequest = 0;
    let resuming = false;
    const selection = () => {
      post({type:'approvalMode',mode:currentMode()});
      post({ type: 'selection', provider: selectedProvider(config().get('provider', '')).label, model: session.model || session.options.model || 'Configured model', effort:config().get('reasoningEffort', '') });
    };
    async function catalogFor(providerId) {
      if (['', 'openai'].includes(providerId)) return loadModels(root.uri.fsPath, {...await connectionOptions(), provider:providerId});
      const provider = selectedProvider(providerId);
      const key = await context.secrets.get(`elpis.apiKey.${providerId}`) || process.env[provider.key];
      return loadProviderModels(providerId, {[provider.key]:key});
    }
    async function resetSession() {
      approvals.cancel();
      session.dispose(); session = await createSession(); post({ type: 'reset' }); selection();
    }
    panel.webview.html = panelHtml(vscode, panel.webview, context.extensionUri);
    const handleMessage = async (message, propagateError=false) => {
      try {
        if(resuming && !['ready','history','models'].includes(message.type)) throw new Error('Wait for the conversation to finish opening.');
        if(session.queued.length && ['reconnect','resume','provider','key','runtime','approvalMode','accountSource'].includes(message.type))throw new Error('Send or remove queued messages before changing conversations or connections.');
        if (message.type === 'send' && typeof message.text === 'string' && message.text.trim()) await session.send(message.text);
        if (message.type === 'cancel') {approvals.cancel();await session.cancel();}
        if (message.type === 'approvalResponse') approvals.respond(message);
        if(message.type==='followup') {
          if(message.mode==='queue')session.enqueue(message.text);
          else if(message.mode==='steer')await session.steer(message.text);
          else throw new Error('Unknown follow-up behavior.');
          return;
        }
        if(message.type==='removeQueued'){session.removeQueued(message.id);return;}
        if(message.type==='resumeQueue'){await session.resumeQueue();return;}
        if(message.type==='copy' && typeof message.text==='string') {
          await vscode.env.clipboard.writeText(message.text);post({type:'copied',id:message.id});return;
        }
        if (message.type === 'approvalMode') {
          if(session.busy)throw new Error('Finish or stop the response before changing permissions.');
          const picked={mode:approvalMode(message.mode)};
          if(!picked || picked.mode.id===currentMode().id)return;
          if(picked.mode.id==='full' && await vscode.window.showWarningMessage('Allow full access? Elpis can run commands and change files outside this project without approval. This choice is saved locally for this project.',{modal:true},'Allow full access')!=='Allow full access')return;
          if(session.busy)throw new Error('Finish or stop the response before changing permissions.');
          const threadId=session.hasTurns ? session.threadId : undefined;
          resuming=true;
          try {
            session.dispose();session=await createSession(threadId,picked.mode.id);await session.connect();
            await context.workspaceState.update(modeKey,picked.mode.id);selection();
          }catch(error){session.dispose();session=await createSession(threadId);selection();throw error;}
          finally{resuming=false;}
          return;
        }
        if (message.type === 'settings') showSettings(vscode,context,{root:root.uri,connectionOptions,section:message.section,action:message=>handleMessage(message,true)});
        if (message.type === 'compact' || message.type === 'review') await session.runCommand(message.type);
        if (message.type === 'accountSource') {
          if(session.busy)throw new Error('Finish or stop the response before changing accounts.');
          if(!['elpis','codex'].includes(message.value))throw new Error('Unknown login source.');
          await config().update('accountSource',message.value,vscode.ConfigurationTarget.Global);
          const threadId=session.hasTurns ? session.threadId : undefined;
          session.dispose();session=await createSession(threadId);await session.connect();selection();
          panel.webview.postMessage({type:'status',text:'Login updated.'});return;
        }
        if (message.type === 'config') {
          const file = path.join(runtimeHome({home:config().get('home','')}), 'config.toml');
          if (!fs.existsSync(file)) throw new Error('No config.toml exists in the configured Elpis home yet.');
          await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.file(file)));
        }
        if (message.type === 'history') {
          try { post({type:'history',requestId:message.requestId,append:!!message.cursor,...await listHistory(root.uri.fsPath, await connectionOptions(), message.search, message.cursor,message.archived===true)}); }
          catch(error) { post({type:'history',requestId:message.requestId,threads:[],error:error.message}); }
        }
        if(message.type==='historyAction') {
          const choices=message.archived===true?[{label:'Restore chat',action:'restore'}]:[{label:'Rename chat',action:'rename'},{label:'Archive chat',action:'archive'}];
          const choice=await vscode.window.showQuickPick(choices,{title:'Elpis conversation'});if(!choice)return;
          let name;
          if(choice.action==='rename') {name=await vscode.window.showInputBox({title:'Conversation name',value:message.title,validateInput:value=>value.trim()?undefined:'Enter a name.'});if(name===undefined)return;}
          if(session.busy && session.threadId===message.threadId)throw new Error('Finish or stop this response before changing its history.');
          await changeHistory(root.uri.fsPath,await connectionOptions(),message.threadId,choice.action,name);
          if(choice.action==='archive' && session.threadId===message.threadId)await resetSession();
          post({type:'historyChanged'});return;
        }
        if (message.type === 'resume') {
          if(session.busy) throw new Error('Finish or cancel the current turn before switching chats.');
          resuming=true;post({type:'busy',busy:true});
          try {
          const thread = await readHistory(root.uri.fsPath, await connectionOptions(), message.threadId);
          const resumed = await createSession(thread.id);
          try { await resumed.connect(); } catch(error) { resumed.dispose(); throw error; }
          session.dispose(); session=resumed;
          post({type:'reset'});post({type:'transcript',messages:transcript(thread)});selection();
          post({type:'status',text:'Conversation resumed'});
          } finally { resuming=false;post({type:'busy',busy:session.busy}); }
        }
        if (message.type === 'prune') {
          await session.prune();
        }
        if(message.type==='smartPruning'){
          await session.setSmartPruning(message.enabled);post({type:'ledger',state:session.ledger()});
          post({type:'ledgerStatus',text:'Smart Pruning configuration saved.'});
        }
        if(message.type==='ledgerRefresh'){
          await session.connect();post({type:'ledger',state:session.ledger()});
          const result=await session.goal('get');post({type:'goal',goal:result.goal});
        }
        if(['goalSet','goalClear'].includes(message.type)){
          const result=await session.goal(message.type==='goalSet'?'set':'clear',message.objective);
          post({type:'goal',goal:result.goal??null});post({type:'ledgerStatus',text:'Goal updated.'});
        }
        if (['provider', 'key', 'runtime', 'chooseModel', 'customModel', 'effort','thinking'].includes(message.type) && session.busy) throw new Error('Cancel or finish the current turn before changing the connection.');
        if(message.type==='thinking') {
          panel.show(false);post({type:'openThinking'});
        }
        if (message.type === 'models') {
          const request = ++catalogRequest;
          try {
            const providerId = config().get('provider', '');
            const catalog = await catalogFor(providerId);
            if(request!==catalogRequest || providerId!==config().get('provider','')) return;
            menuModels = modelChoices(providerId, session.model || session.options.model || '', catalog).filter(m => !m.custom);
            post({type:'models', requestId:message.requestId, models:menuModels, current:session.model || session.options.model || '', effort:config().get('reasoningEffort','')});
          } catch (error) { post({type:'models', requestId:message.requestId, models:[], error:error.message}); }
        }
        if (message.type === 'chooseModel' || message.type === 'customModel') {
          let model = message.model;
          if (message.type === 'customModel') model = await vscode.window.showInputBox({title:'Elpis custom model', prompt:'Exact model ID', validateInput:v=>v.trim() ? undefined : 'Enter a model ID'});
          else if (!menuModels.some(m=>m.model === model)) throw new Error('Choose a model from the current catalog.');
          if (model === undefined) return;
          const effective=model.trim() || await configuredModel(root.uri.fsPath,await connectionOptions());
          await config().update('model', model.trim(), configTarget);
          const effort=effortForModel(menuModels.find(p=>p.model===effective),config().get('reasoningEffort',''));
          await config().update('reasoningEffort', effort, configTarget);
          session.selectModel(effective,effort);selection();
          post({type:'status',text:`Model selected: ${model.trim() || 'Elpis configuration'}`});
        }
        if (message.type === 'effort') {
          const model = menuModels.find(m=>m.model === (session.model || session.options.model)) || menuModels.find(m=>m.isDefault);
          if (message.effort && !model?.efforts?.includes(message.effort)) throw new Error('This model does not advertise that reasoning effort.');
          await config().update('reasoningEffort', message.effort, configTarget);
          session.options.reasoningEffort = message.effort || model?.defaultEffort || '';
          selection();
        }
        if (message.type === 'provider') {
          const provider = await vscode.window.showQuickPick(providers.map(p => ({ label: p.label, description: p.id || 'Use existing Elpis settings', provider: p })), { title: 'Elpis provider' });
          if (!provider) return;
          const current = provider.provider.id === session.options.provider ? session.options.model : '';
          let catalog = [];
          let catalogError;
          {
            try {
              catalog = await vscode.window.withProgress({location:vscode.ProgressLocation.Window, title:'Loading Elpis models'}, () => catalogFor(provider.provider.id));
            } catch (error) { catalogError = error.message; post({type:'status', text:`Cannot load Elpis models: ${error.message}`}); }
          }
          const choice = await vscode.window.showQuickPick(modelChoices(provider.provider.id, current, catalog), { title: `${provider.label} model`, placeHolder: catalogError ? 'Catalog unavailable. Keep the current model or enter a custom ID.' : 'Search available models or enter a custom ID', matchOnDescription: true });
          if (!choice) return;
          const model = choice.custom ? await vscode.window.showInputBox({ title: `${provider.label} custom model`, prompt: 'Exact model ID', value: current, validateInput: value => value.trim() ? undefined : 'Enter a model ID' }) : choice.model;
          if (model === undefined) return;
          if (provider.provider.id && !model.trim()) throw new Error('Enter a model ID for the selected provider.');
          await config().update('provider', provider.provider.id, configTarget);
          await config().update('model', model.trim(), configTarget);
          await config().update('reasoningEffort', '', configTarget);
          await resetSession();
        }
        if (message.type === 'key') {
          const provider = selectedProvider(config().get('provider', ''));
          if (!provider.key) throw new Error('Select an explicit provider first. Existing Elpis configuration uses its current authentication.');
          const value = await vscode.window.showInputBox({ title: `${provider.label} API key`, password: true, ignoreFocusOut: true, prompt: 'Stored in VS Code SecretStorage. Leave empty to remove the stored override and use runtime authentication.' });
          if (value === undefined) return;
          if (value.trim()) await context.secrets.store(`elpis.apiKey.${provider.id}`, value.trim());
          else await context.secrets.delete(`elpis.apiKey.${provider.id}`);
          await resetSession();
          post({ type: 'status', text: 'Authentication updated. Send a message to connect.' });
        }
        if (message.type === 'runtime') {
          const files = await vscode.window.showOpenDialog({ title: 'Select the Elpis-built app-server executable', canSelectFiles: true, canSelectFolders: false, canSelectMany: false });
          if (!files?.length) return;
          await config().update('executable', files[0].fsPath, vscode.ConfigurationTarget.Global);
          await resetSession();
        }
        if (message.type === 'reconnect') { await resetSession(); await session.connect(); }
        if (message.type === 'access') {
          await config().update('editorAccess', !config().get('editorAccess', true), configTarget);
          bridge.cancel();
          post({ type: 'status', text: 'Editor access changed. Start a new conversation to remove facts already seen.' });
        }
        if (message.type === 'ready' || message.type === 'access') post({ type: 'access', enabled: config().get('editorAccess', true) });
        if (message.type === 'ready') { selection();postPreferences();session.emitQueue(); }
      } catch (error) {
        post({ type: 'status', text: error.message });
        if(['ledgerRefresh','smartPruning','goalSet','goalClear'].includes(message.type))post({type:'ledgerStatus',text:error.message});
        if (message.type === 'resume' || message.type==='historyAction') post({type:'historyError',text:error.message});
        if (['send','followup','compact','review'].includes(message.type)) post({ type: 'restoreDraft', text: message.text });
        if(propagateError)throw error;
      } finally {
        if(['chooseModel','effort','thinking','approvalMode'].includes(message.type)) post({type:'connectionReady'});
      }
    };
    const listener=panel.webview.onDidReceiveMessage(handleMessage);
    const preferences = vscode.workspace.onDidChangeConfiguration(event=>{
      if(event.affectsConfiguration('elpis',root.uri))postPreferences();
    });
    panel.onDidDispose(() => { approvals.cancel();preferences.dispose(); listener.dispose(); session.dispose(); bridge.dispose(); panels.delete(key); });
  }
  let opening;
  context.subscriptions.push(vscode.window.registerWebviewViewProvider('elpis.chatView', {
    resolveWebviewView(view) { opening = openChat(view); return opening; },
  }, {webviewOptions:{retainContextWhenHidden:true}}));
  context.subscriptions.push(vscode.commands.registerCommand('elpis.chat', async () => {
    await vscode.commands.executeCommand('elpis.chatView.focus');
    await opening;
  }));
  return { EditorBridge, Session };
}
module.exports = { activate };
