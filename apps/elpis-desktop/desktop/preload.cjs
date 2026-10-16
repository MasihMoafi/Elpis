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
  resolveFolder:folder=>ipcRenderer.invoke('elpis:folder:resolve',folder),
  openFile:target=>ipcRenderer.invoke('elpis:file:open',target).then(result=>{
    if(typeof result?.error==='string')throw Error(result.error);
    if(result?.opened!==true)throw Error('Could not open this file.');
  }),
  browser:{
    command:(action,data={})=>ipcRenderer.invoke('elpis:browser',{action,...data}).then(result=>{if(typeof result?.error==='string')throw Error(result.error);return result;}),
    layout:value=>ipcRenderer.send('elpis:browser:layout',value),
    subscribe:callback=>{const listener=(_event,state)=>callback(state);ipcRenderer.on('elpis:browser:state',listener);return()=>ipcRenderer.removeListener('elpis:browser:state',listener);},
  },
});
