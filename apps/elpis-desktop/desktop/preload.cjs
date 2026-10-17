'use strict';
const {contextBridge,ipcRenderer}=require('electron');
const saved = ipcRenderer.sendSync('elpis:state:read');
const values = Object.assign(Object.create(null), saved.error ? {} : saved);
const errors = new Set();
const failed = error => { for (const callback of errors) callback(String(error.message || error)); };
contextBridge.exposeInMainWorld('elpisDesktop',{
  storage: {
    getItem:key=>values[key] ?? null,
    setItem:(key,value)=>{ values[key]=String(value); ipcRenderer.invoke('elpis:state:write',key,String(value)).catch(failed); },
    removeItem:key=>{ delete values[key]; ipcRenderer.invoke('elpis:state:write',key,null).catch(failed); },
    saveItem:async(key,value)=>{ await ipcRenderer.invoke('elpis:state:write',key,String(value)); values[key]=String(value); },
    onError:callback=>{ errors.add(callback); if(saved.error)callback(saved.error); return()=>errors.delete(callback); },
  },
  chooseFolder:()=>ipcRenderer.invoke('elpis:folder'),
  setTheme:dark=>ipcRenderer.send('elpis:theme',dark===true),
  resolveFolder:folder=>ipcRenderer.invoke('elpis:folder:resolve',folder),
  openFile:target=>ipcRenderer.invoke('elpis:file:open',target).then(result=>{
    if(typeof result?.error==='string')throw Error(result.error);
    if(result?.opened!==true)throw Error('Could not open this file.');
  }),
  openFolder:target=>ipcRenderer.invoke('elpis:folder:open',target).then(result=>{
    if(typeof result?.error==='string')throw Error(result.error);
    if(result?.opened!==true)throw Error('Could not open this folder.');
  }),
  browser:{
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
  onOpenThread:callback=>{
    const take=()=>ipcRenderer.invoke('elpis:open-thread:take').then(id=>{if(typeof id==='string')callback(id);}).catch(()=>{});
    ipcRenderer.on('elpis:open-thread',take);take();
    return()=>ipcRenderer.removeListener('elpis:open-thread',take);
  },
});
function checked(result){if(typeof result?.error==='string')throw Error(result.error);return result;}
