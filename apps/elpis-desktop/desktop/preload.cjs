'use strict';
const {contextBridge,ipcRenderer}=require('electron');
const saved = ipcRenderer.sendSync('elpis:state:read');
const committed = Object.assign(Object.create(null), saved.values ?? {});
const values = Object.assign(Object.create(null), committed);
let revision = saved.revision ?? 0;
const errors = new Set(), listeners = new Set(), pending = [], versions = new Map();
const writes = new Set(), writeErrors = new Map();
const failed = error => { for (const callback of errors) callback(String(error.message || error)); };
function refresh(key) {
  let value = committed[key] ?? null;
  for (const patch of pending) if (patch.key === key) {
    if (patch.changes) {
      let current = {};
      try { const parsed = JSON.parse(value || '{}'); if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) current = parsed; } catch {}
      value = JSON.stringify({ ...current, ...patch.changes });
    } else value = patch.value;
  }
  if ((values[key] ?? null) === value) return;
  if (value === null) delete values[key]; else values[key] = value;
  for (const callback of listeners) callback(key);
}
function adopt(change) {
  revision = Math.max(revision, change.revision);
  if (change.revision < (versions.get(change.key) ?? -1)) return;
  versions.set(change.key, change.revision);
  if (change.value === null) delete committed[change.key]; else committed[change.key] = change.value;
  refresh(change.key);
}
ipcRenderer.on('elpis:state:changed', (_event, change) => adopt(change));
function write(key, update) {
  const patch = { key, baseRevision: revision, ...update };
  pending.push(patch); refresh(key);
  const operation = ipcRenderer.invoke('elpis:state:write', patch).then(result => {
    if (result.error) {
      const state = result.snapshot;
      if (state?.values && state.revision >= revision) {
        const keys = new Set([...Object.keys(committed), ...Object.keys(state.values)]);
        for (const key of keys) adopt({ key, value: state.values[key] ?? null, revision: state.revision });
      }
      throw Object.assign(Error(result.error), { code: result.code });
    }
    adopt(result);
    writeErrors.delete(key);
  }).catch(error => { writeErrors.set(key, error); throw error; })
    .finally(() => { pending.splice(pending.indexOf(patch), 1); refresh(key); writes.delete(operation); });
  writes.add(operation);
  return operation;
}
contextBridge.exposeInMainWorld('elpisDesktop',{
  menu:{
    command:command=>ipcRenderer.invoke('elpis:menu:command',command).then(checked),
    subscribe:callback=>{const listener=(_event,command)=>callback(command);ipcRenderer.on('elpis:menu:requested',listener);return()=>ipcRenderer.removeListener('elpis:menu:requested',listener);},
  },
  improve: {
    capture:bounds=>ipcRenderer.invoke('elpis:improve:capture',bounds).then(checked),
    onPoint:callback=>{const listener=(_event,point)=>callback(point);ipcRenderer.on('elpis:improve:point',listener);return()=>ipcRenderer.removeListener('elpis:improve:point',listener);},
  },
  storage: {
    getItem:key=>values[key] ?? null,
    setItem:(key,value)=>{ write(key,{value:String(value)}).catch(failed); },
    removeItem:key=>{ write(key,{value:null}).catch(failed); },
    saveItem:(key,value)=>write(key,{value:String(value)}),
    patchItem:(key,changes)=>{ write(key,{changes}).catch(failed); },
    onChange:callback=>{ listeners.add(callback); return()=>listeners.delete(callback); },
    onError:callback=>{ errors.add(callback); if(saved.error)callback(saved.error); return()=>errors.delete(callback); },
    flush:async()=>{
      while(writes.size)await Promise.allSettled([...writes]);
      if(saved.error)throw Error(saved.error);
      if(writeErrors.size)throw writeErrors.values().next().value;
    },
  },
  updates:{
    status:()=>ipcRenderer.invoke('elpis:updates:status').then(checked),
    restart:()=>ipcRenderer.invoke('elpis:updates:restart').then(checked),
    subscribe:callback=>{const listener=(_event,state)=>callback(state);ipcRenderer.on('elpis:updates:changed',listener);return()=>ipcRenderer.removeListener('elpis:updates:changed',listener);},
  },
  openSessionWindow:threadId=>ipcRenderer.invoke('elpis:session-window',threadId).then(checked),
  chooseFolder:()=>ipcRenderer.invoke('elpis:folder'),
  setTheme:(dark,details)=>ipcRenderer.send('elpis:theme',dark===true,{source:details?.source,background:details?.background}),
  resolveFolder:folder=>ipcRenderer.invoke('elpis:folder:resolve',folder),
  openFile:target=>ipcRenderer.invoke('elpis:file:open',target).then(result=>{
    if(typeof result?.error==='string')throw Error(result.error);
    if(result?.opened!==true)throw Error('Could not open this file.');
  }),
  onOpenFile:callback=>{
    const listener=(_event,target)=>callback(target);
    ipcRenderer.on('elpis:file:requested',listener);
    return()=>ipcRenderer.removeListener('elpis:file:requested',listener);
  },
  documents:{subscribe:callback=>{
    const listener=(_event,request)=>{
      void Promise.resolve().then(()=>callback(request)).then(
        result=>ipcRenderer.send('elpis:document:reply',{id:request.id,result}),
        error=>ipcRenderer.send('elpis:document:reply',{id:request.id,error:error instanceof Error?error.message:String(error)}),
      );
    };
    ipcRenderer.on('elpis:document:request',listener);
    return()=>ipcRenderer.removeListener('elpis:document:request',listener);
  }},
  openExternalFile:target=>ipcRenderer.invoke('elpis:file:external',target).then(result=>{
    if(typeof result?.error==='string')throw Error(result.error);
    if(result?.opened!==true)throw Error('Could not open this file.');
  }),
  editors:()=>ipcRenderer.invoke('elpis:editors:list').then(result=>{
    if(typeof result?.error==='string')throw Error(result.error);
    return Array.isArray(result?.editors)?result.editors:[];
  }),
  openInEditor:(target,editor,line)=>ipcRenderer.invoke('elpis:file:edit',{target,editor,line}).then(result=>{
    if(typeof result?.error==='string')throw Error(result.error);
    if(result?.opened!==true)throw Error('Could not start the editor.');
  }),
  openFolder:target=>ipcRenderer.invoke('elpis:folder:open',target).then(result=>{
    if(typeof result?.error==='string')throw Error(result.error);
    if(result?.opened!==true)throw Error('Could not open this folder.');
  }),
  browser:{
    sessionScoped:true,
    command:(action,data={})=>ipcRenderer.invoke('elpis:browser',{action,...data}).then(result=>{if(typeof result?.error==='string')throw Error(result.error);return result;}),
    layout:value=>ipcRenderer.send('elpis:browser:layout',value),
    subscribe:callback=>{const listener=(_event,state)=>callback(state);ipcRenderer.on('elpis:browser:state',listener);return()=>ipcRenderer.removeListener('elpis:browser:state',listener);},
  },
  // One shell per terminal tab (desktop/terminal.cjs); the key names the tab.
  terminal:{
    open:(key,cwd,cols,rows)=>ipcRenderer.invoke('elpis:terminal:open',{key,cwd,cols,rows}).then(checked),
    restart:(key,cwd,cols,rows)=>ipcRenderer.invoke('elpis:terminal:restart',{key,cwd,cols,rows}).then(checked),
    close:key=>ipcRenderer.invoke('elpis:terminal:close',{key}).then(checked),
    tui:(key,cwd,threadId,cols,rows)=>ipcRenderer.invoke('elpis:terminal:tui',{key,cwd,threadId,cols,rows}).then(checked),
    input:(key,data)=>ipcRenderer.send('elpis:terminal:input',key,data),
    resize:(key,cols,rows)=>ipcRenderer.send('elpis:terminal:resize',key,cols,rows),
    copy:text=>ipcRenderer.invoke('elpis:terminal:clipboard',String(text)).then(checked),
    paste:()=>ipcRenderer.invoke('elpis:terminal:clipboard').then(checked).then(result=>String(result.text??'')),
    subscribe:(onData,onExit)=>{
      const data=(_event,key,id,end,text)=>onData(key,id,end,text),exit=(_event,key,id,code)=>onExit(key,id,code);
      ipcRenderer.on('elpis:terminal:data',data);ipcRenderer.on('elpis:terminal:exit',exit);
      return()=>{ipcRenderer.removeListener('elpis:terminal:data',data);ipcRenderer.removeListener('elpis:terminal:exit',exit);};
    },
  },
  // A chat the Elpis TUI's /app (or a launch with --open-thread) asked this window to open.
  onOpenThread:callback=>handoff('elpis:open-thread',callback),
  // A new chat from Quick Entry, with the text to send, or from the tray's New chat, with none.
  onNewChat:callback=>handoff('elpis:new-chat',callback),
  // The screenshot thumbnail (desktop/screenshot-popup.cjs): ask for one, and hear which screenshot its click opens.
  screenshotPopup:{
    show:shot=>ipcRenderer.send('elpis:screenshot-popup:request',{id:String(shot?.id??''),name:String(shot?.name??''),dataURL:String(shot?.dataURL??'')}),
    onOpen:callback=>{const open=(_event,id)=>{if(typeof id==='string')callback(id);};ipcRenderer.on('elpis:screenshot-popup:open',open);return()=>ipcRenderer.removeListener('elpis:screenshot-popup:open',open);},
  },
  // Settings → General → Quick Entry keyboard shortcut (desktop/quick-entry.cjs).
  quickEntry:{
    status:()=>ipcRenderer.invoke('elpis:quick-entry:status'),
    setShortcut:accelerator=>ipcRenderer.invoke('elpis:quick-entry:shortcut',String(accelerator)).then(checked),
  },
});
function checked(result){if(typeof result?.error==='string')throw Error(result.error);return result;}
/** Takes what the main process holds for this page (desktop/open-thread.cjs) at once and on each ping. */
function handoff(channel,callback){
  const take=()=>ipcRenderer.invoke(`${channel}:take`).then(value=>{if(typeof value==='string')callback(value);}).catch(()=>{});
  ipcRenderer.on(channel,take);take();
  return()=>ipcRenderer.removeListener(channel,take);
}
