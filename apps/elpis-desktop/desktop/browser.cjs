'use strict';
const {randomUUID}=require('node:crypto');
const {browserUrl,trustedBrowserSender,nativeBounds}=require('./browser-policy.cjs');

function createBrowser({host,origin,WebContentsView,session,ipcMain,openExternal}) {
  const tabs=new Map();let activeId=null,visible=false,bounds=null,obscured=false,focusAddress=0,disposed=false,popups=[];
  const browserSession=session.fromPartition('persist:elpis-browser');
  browserSession.setPermissionRequestHandler((_contents,_permission,callback)=>callback(false));
  browserSession.setPermissionCheckHandler(()=>false);
  const snapshot=()=>({visible,activeId,focusAddress,tabs:[...tabs.values()].map(tab=>({id:tab.id,url:tab.url,title:tab.title,loading:tab.loading,error:tab.error,canGoBack:tab.view.webContents.navigationHistory.canGoBack(),canGoForward:tab.view.webContents.navigationHistory.canGoForward()}))});
  const emit=()=>{if(!disposed&&!host.webContents.isDestroyed())host.webContents.send('elpis:browser:state',snapshot());};
  function place(){
    if(disposed||host.isDestroyed())return;
    const size=host.getContentBounds();
    const rectangle=bounds?nativeBounds(bounds,host.webContents.getZoomFactor(),size):null;
    for(const tab of tabs.values()){
      const show=visible&&!obscured&&tab.id===activeId&&!!rectangle;
      if(show)tab.view.setBounds(rectangle);
      tab.view.setVisible(show);
    }
  }
  function focusInput(){focusAddress++;host.webContents.focus();emit();}
  function select(id,focus=true){
    if(!tabs.has(id))throw Error('This browser tab is closed.');
    activeId=id;visible=true;place();emit();
    const tab=tabs.get(id);if(focus&&tab.url!=='about:blank')tab.view.webContents.focus();else if(tab.url==='about:blank')focusInput();
  }
  function close(id){
    const tab=tabs.get(id);if(!tab)return;
    const order=[...tabs.keys()],index=order.indexOf(id);tabs.delete(id);
    host.contentView.removeChildView(tab.view);
    if(!tab.view.webContents.isDestroyed())tab.view.webContents.close({waitForBeforeUnload:false});
    if(activeId===id)activeId=order[index+1]??order[index-1]??null;
    if(!tabs.size)visible=false;
    place();emit();
  }
  function navigate(tab,url){
    tab.url=browserUrl(url,origin);tab.error=null;tab.title=tab.url==='about:blank'?'New tab':new URL(tab.url).hostname;emit();
    // did-fail-load owns page errors; Stop and replaced navigations also reject loadURL.
    void tab.view.webContents.loadURL(tab.url).catch(()=>{});
  }
  function open(url='about:blank'){
    const target=browserUrl(url,origin);if(tabs.size>=20)throw Error('Close a browser tab before opening another (20 tab limit).');
    const view=new WebContentsView({webPreferences:{partition:'persist:elpis-browser',nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true,webviewTag:false}});
    view.setVisible(false);host.contentView.addChildView(view);
    const tab={id:randomUUID(),url:'about:blank',title:'New tab',loading:false,error:null,view};tabs.set(tab.id,tab);
    const wc=view.webContents;
    wc.on('will-attach-webview',event=>event.preventDefault());
    const guard=(event,url)=>{try{browserUrl(url,origin);}catch{event.preventDefault();tab.error='This address cannot be opened in the browser.';emit();}};
    wc.on('will-navigate',guard);wc.on('will-redirect',guard);
    wc.setWindowOpenHandler(({url})=>{
      const now=Date.now();popups=popups.filter(time=>now-time<10000);
      if(popups.length<5){try{open(url);popups.push(now);}catch{}}
      return {action:'deny'};
    });
    wc.on('did-start-loading',()=>{tab.loading=true;tab.error=null;emit();});
    wc.on('did-stop-loading',()=>{tab.loading=false;emit();});
    const navigated=(_event,url)=>{tab.url=url;tab.error=null;emit();};
    wc.on('did-navigate',navigated);wc.on('did-navigate-in-page',(event,url,isMainFrame)=>{if(isMainFrame)navigated(event,url);});
    wc.on('page-title-updated',(_event,title)=>{tab.title=String(title).slice(0,200)||'New tab';emit();});
    wc.on('did-fail-load',(_event,code,description,_url,isMainFrame)=>{if(isMainFrame&&code!==-3){tab.loading=false;tab.error=description;emit();}});
    wc.on('render-process-gone',()=>{tab.loading=false;tab.error='This page stopped responding. Reload to try again.';emit();});
    wc.on('destroyed',()=>{if(!disposed)close(tab.id);});
    wc.on('before-input-event',(event,input)=>keyboard(event,input,true));
    select(tab.id,false);navigate(tab,target);return tab.id;
  }
  function keyboard(event,input,fromBrowser=false){
    if(input.type!=='keyDown'||!(input.control||input.meta)||input.alt||!visible)return;
    const key=input.key.toLowerCase();
    if(key==='l'){event.preventDefault();focusInput();}
    else if(key==='t'){event.preventDefault();try{open();}catch{}}
    else if(key==='w'){event.preventDefault();close(activeId);}
    else if(key==='r'&&fromBrowser){event.preventDefault();tabs.get(activeId)?.view.webContents.reload();}
    else if(key==='tab'&&tabs.size){event.preventDefault();const ids=[...tabs.keys()],index=ids.indexOf(activeId);select(ids[(index+(input.shift?ids.length-1:1))%ids.length]);}
  }
  const rootKeyboard=(event,input)=>keyboard(event,input);
  const resetLayout=(_event,_url,inPlace,isMainFrame)=>{if(isMainFrame&&!inPlace){bounds=null;place();}};
  host.webContents.on('before-input-event',rootKeyboard);
  host.webContents.on('did-start-navigation',resetLayout);
  host.on('resize',place);
  const trusted=event=>{if(!trustedBrowserSender(event,host.webContents,origin))throw Error('Browser controls are available only to Elpis.');};
  ipcMain.handle('elpis:browser',(event,input)=>{
    try {
    trusted(event);
    if(!input||typeof input!=='object'||Object.keys(input).some(key=>!['action','id','url'].includes(key)))throw Error('Invalid browser command.');
    const tab=tabs.get(input.id??activeId);
    switch(input.action){
      case 'state':break;
      case 'toggle':if(!tabs.size)open();else{visible=!visible;place();emit();}break;
      case 'hide':visible=false;place();emit();break;
      case 'new':open(input.url);break;
      case 'select':select(input.id);break;
      case 'close':close(input.id);break;
      case 'navigate':if(!tab)throw Error('Open a browser tab first.');navigate(tab,input.url);break;
      case 'back':if(tab?.view.webContents.navigationHistory.canGoBack())tab.view.webContents.navigationHistory.goBack();break;
      case 'forward':if(tab?.view.webContents.navigationHistory.canGoForward())tab.view.webContents.navigationHistory.goForward();break;
      case 'reload':tab?.view.webContents.reload();break;
      case 'stop':tab?.view.webContents.stop();break;
      case 'external':if(tab&&/^https?:/.test(tab.url)&&openExternal)void openExternal(tab.url);break;
      default:throw Error('Unknown browser command.');
    }
    return snapshot();
    } catch(error) { return {error:error.message||'The browser is unavailable. Try opening it again.'}; }
  });
  const layout=(event,input)=>{
    try{
      trusted(event);if(!input||typeof input.obscured!=='boolean')return;
      nativeBounds(input.bounds,1,host.getContentBounds());bounds=input.bounds;obscured=input.obscured;place();
    }catch{ /* Ignore malformed or untrusted layout messages. */ }
  };
  ipcMain.on('elpis:browser:layout',layout);
  return {open,dispose(){
    disposed=true;ipcMain.removeHandler('elpis:browser');ipcMain.removeListener('elpis:browser:layout',layout);
    host.webContents.removeListener('before-input-event',rootKeyboard);host.webContents.removeListener('did-start-navigation',resetLayout);host.removeListener('resize',place);
    for(const tab of tabs.values())tab.view.webContents.close({waitForBeforeUnload:false});tabs.clear();
  }};
}
module.exports={createBrowser};
