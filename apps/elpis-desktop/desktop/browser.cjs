'use strict';
const {randomUUID}=require('node:crypto');
const path=require('node:path');
const {browserUrl,trustedBrowserSender,nativeBounds,loadFailure,pageSecurity,zoomStep}=require('./browser-policy.cjs');
const {cleanPick,commentLabel,commentsPrompt}=require('./browser-annotations.cjs');
const {contextMenuTemplate}=require('./context-menu.cjs');
const {createBrowserAgent}=require('./browser-agent.cjs');

const PRELOAD=path.join(__dirname,'browser-page-preload.cjs');
const COMMANDS=['action','id','url','body','text','value'];
// One screenshot sheet holds twelve panels; send these before adding more.
const MAX_COMMENTS=12;

function createBrowser({host,origin,WebContentsView,session,ipcMain,openExternal,Menu,clipboard}) {
  const tabs=new Map();let activeId=null,visible=false,bounds=null,obscured=false,focusAddress=0,fullView=0,disposed=false,popups=[];
  // Annotation mode (the ChatGPT app's "Annotate") follows the active tab; comments belong to their tab.
  let annotating=false,markersVisible=true;const painted=new Map();
  const browserSession=session.fromPartition('persist:elpis-browser');
  browserSession.setPermissionRequestHandler((_contents,_permission,callback)=>callback(false));
  browserSession.setPermissionCheckHandler(()=>false);
  const active=()=>tabs.get(activeId);
  const commentView=(tab,item)=>({id:item.id,number:item.number,kind:item.kind,label:commentLabel(item),body:item.body});
  const snapshot=()=>{
    const tab=active();
    return {visible,activeId,focusAddress,fullView,annotating,markersVisible,agent:agent.state(),
      annotations:tab?tab.comments.map(item=>commentView(tab,item)):[],
      draft:tab?.draft?{...commentView(tab,tab.draft),editing:!!tab.draft.editing}:null,
      find:tab?{open:tab.find.open,text:tab.find.text,matches:tab.find.matches,active:tab.find.active,focus:tab.find.focus}:{open:false,text:'',matches:0,active:0,focus:0},
      tabs:[...tabs.values()].map(item=>({id:item.id,url:item.url,title:item.title,loading:item.loading,error:item.error,failure:item.failure,security:pageSecurity(item.url),zoom:Math.round(item.view.webContents.getZoomFactor()*100),comments:item.comments.length,canGoBack:item.view.webContents.navigationHistory.canGoBack(),canGoForward:item.view.webContents.navigationHistory.canGoForward()}))};
  };
  const emit=()=>{if(!disposed&&!host.webContents.isDestroyed())host.webContents.send('elpis:browser:state',snapshot());};
  const agent=createBrowserAgent({tabs,open,select,origin,emit,prepare(){if(annotating)setAnnotating(false);}});
  // What the page layer draws: markers for saved comments and the outline of the one being written.
  function syncPage(tab){
    if(!tab||tab.view.webContents.isDestroyed())return;
    const anchor=item=>({id:item.id,number:item.number,kind:item.kind,pageUrl:item.pageUrl,anchor:{selector:item.anchor.selector,rect:item.anchor.rect,isFixed:item.anchor.isFixed}});
    tab.view.webContents.send('elpis:annotate',{type:'state',mode:annotating&&tab.id===activeId,markersVisible,comments:tab.comments.map(anchor),draft:tab.draft?{...anchor(tab.draft),editing:tab.draft.editing||null}:null});
  }
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
    const previous=active();activeId=id;visible=true;place();
    if(previous&&previous.id!==id)syncPage(previous);
    syncPage(tabs.get(id));emit();
    const tab=tabs.get(id);if(focus&&tab.url!=='about:blank')tab.view.webContents.focus();else if(tab.url==='about:blank')focusInput();
  }
  function close(id){
    const tab=tabs.get(id);if(!tab)return;
    const order=[...tabs.keys()],index=order.indexOf(id);tabs.delete(id);
    host.contentView.removeChildView(tab.view);
    if(!tab.view.webContents.isDestroyed())tab.view.webContents.close({waitForBeforeUnload:false});
    if(activeId===id){activeId=order[index+1]??order[index-1]??null;syncPage(active());}
    if(!tabs.size){visible=false;annotating=false;}
    place();emit();
  }
  function navigate(tab,url){
    tab.url=browserUrl(url,origin);tab.error=null;tab.failure=null;tab.title=tab.url==='about:blank'?'New tab':new URL(tab.url).hostname;emit();
    // did-fail-load owns page errors; Stop and replaced navigations also reject loadURL.
    void tab.view.webContents.loadURL(tab.url).catch(()=>{});
  }
  function open(url='about:blank',{focus=false,after=null}={}){
    const target=browserUrl(url,origin);if(tabs.size>=20)throw Error('Close a browser tab before opening another (20 tab limit).');
    const view=new WebContentsView({webPreferences:{partition:'persist:elpis-browser',preload:PRELOAD,nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true,webviewTag:false}});
    view.setVisible(false);host.contentView.addChildView(view);
    const tab={id:randomUUID(),url:'about:blank',title:'New tab',loading:false,error:null,failure:null,view,comments:[],draft:null,find:{open:false,text:'',matches:0,active:0,focus:0}};tabs.set(tab.id,tab);
    if(after&&tabs.has(after)){const order=[...tabs.entries()].filter(([id])=>id!==tab.id),at=order.findIndex(([id])=>id===after)+1;order.splice(at,0,[tab.id,tab]);tabs.clear();for(const [id,item] of order)tabs.set(id,item);}
    const wc=view.webContents;
    agent.observe(tab);
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
    wc.on('did-start-navigation',(_event,_url,inPlace,isMainFrame)=>{if(isMainFrame&&!inPlace&&tab.failure){tab.failure=null;emit();}});
    const navigated=(_event,url)=>{tab.url=url;tab.error=null;tab.failure=null;emit();};
    wc.on('did-navigate',navigated);wc.on('did-navigate-in-page',(event,url,isMainFrame)=>{if(isMainFrame)navigated(event,url);});
    wc.on('page-title-updated',(_event,title)=>{tab.title=String(title).slice(0,200)||'New tab';emit();});
    wc.on('did-fail-load',(_event,code,description,url,isMainFrame)=>{if(isMainFrame&&code!==-3){tab.loading=false;tab.error=description;tab.failure=loadFailure(code,description,url||tab.url);emit();}});
    wc.on('render-process-gone',()=>{tab.loading=false;tab.error='This page stopped responding. Reload to try again.';emit();});
    wc.on('found-in-page',(_event,result)=>{if(result?.finalUpdate){tab.find.matches=result.matches;tab.find.active=result.activeMatchOrdinal;emit();}});
    wc.on('context-menu',(_event,params)=>pageMenu(tab,params));
    wc.on('destroyed',()=>{if(!disposed)close(tab.id);});
    wc.on('before-input-event',(event,input)=>keyboard(event,input,tab));
    select(tab.id,focus);navigate(tab,target);return tab.id;
  }

  // --- Annotation ---
  async function capture(tab){
    const image=await tab.view.webContents.capturePage();
    if(!image||image.isEmpty?.())return null;
    const scaled=image.getSize().width>1280?image.resize({width:1280,quality:'good'}):image;
    return `data:image/jpeg;base64,${scaled.toJPEG(82).toString('base64')}`;
  }
  function paint(tab,id){
    return new Promise(resolve=>{
      const timer=setTimeout(()=>{painted.delete(id);resolve();},700);
      painted.set(id,()=>{clearTimeout(timer);painted.delete(id);resolve();});
      tab.view.webContents.send('elpis:annotate',{type:'paint',id});
    });
  }
  async function picked(tab,raw){
    if(!annotating||tab.id!==activeId||tab.comments.length>=MAX_COMMENTS&&!tab.draft?.editing)return;
    let pick;try{pick=cleanPick(raw);}catch{return;}
    const keep=tab.draft&&!tab.draft.editing?tab.draft.number:tab.comments.length+1;
    tab.draft={id:pick.id,number:keep,kind:pick.kind,pageUrl:tab.view.webContents.getURL()||tab.url,anchor:pick,body:'',screenshot:null,editing:null};
    syncPage(tab);emit();host.webContents.focus();
    await paint(tab,pick.id);
    // Two animation frames commit the outline; the compositor can still present the frame after that.
    await new Promise(resolve=>setTimeout(resolve,120));
    const screenshot=await capture(tab).catch(()=>null);
    const owner=tab.draft?.id===pick.id?tab.draft:tab.comments.find(item=>item.id===pick.id);
    if(owner)owner.screenshot=screenshot;
  }
  function editComment(tab,id){
    const item=tab.comments.find(comment=>comment.id===id);if(!item)throw Error('This comment was removed.');
    tab.draft={...item,editing:item.id};syncPage(tab);emit();host.webContents.focus();
  }
  function renumber(tab){tab.comments.forEach((item,index)=>{item.number=index+1;});if(tab.draft&&!tab.draft.editing)tab.draft.number=tab.comments.length+1;}
  function setAnnotating(value){
    if(value&&!active()?.url.startsWith('http'))throw Error('Open a web page to annotate it.');
    annotating=value;const tab=active();
    if(!value&&tab?.draft)tab.draft=null;
    if(tab){syncPage(tab);if(value)tab.view.webContents.focus();}
    emit();
  }
  function collect(tab,images){
    const comments=tab.comments.filter(item=>item.body.trim());
    // Comments stay until the message that carries them is accepted ("annotationsSent").
    return {count:comments.length,text:comments.length?commentsPrompt(comments,{images}):'',images:images?comments.filter(item=>item.screenshot).map(item=>({number:item.number,dataUrl:item.screenshot})):[]};
  }
  function pageMessage(event,message){
    const tab=[...tabs.values()].find(item=>item.view.webContents===event.sender);
    if(!tab||event.senderFrame!==event.sender.mainFrame||!message||typeof message!=='object')return;
    switch(message.type){
      case 'ready':syncPage(tab);break;
      case 'pick':void picked(tab,message.pick);break;
      case 'painted':painted.get(message.id)?.();break;
      case 'edit':if(annotating&&tab.id===activeId&&typeof message.id==='string')try{editComment(tab,message.id);}catch{}break;
      case 'cancel':if(tab.draft){tab.draft=null;syncPage(tab);emit();}break;
      case 'exit':if(annotating&&tab.id===activeId)setAnnotating(false);break;
    }
  }

  // --- Page menu (right-click on a page), as in the ChatGPT app's browser ---
  function pageMenu(tab,params){
    if(!Menu)return;
    const wc=tab.view.webContents,zoom=wc.getZoomFactor()||1,x=Math.round(params.x/zoom),y=Math.round(params.y/zoom),groups=[];
    // Text, spelling, image and link items are the app's own (desktop/context-menu.cjs); a link opens in a new tab.
    const shared=contextMenuTemplate(params,{contents:wc,clipboard,origin,openLink:url=>{try{open(url);}catch{}}});
    if(/^https?:/i.test(params.linkURL||'')&&openExternal)shared.push({label:'Open link in external browser',click:()=>void openExternal(params.linkURL)});
    if(shared.length)groups.push(shared);
    groups.push([
      {label:'Back',enabled:wc.navigationHistory.canGoBack(),click:()=>wc.navigationHistory.goBack()},
      {label:'Forward',enabled:wc.navigationHistory.canGoForward(),click:()=>wc.navigationHistory.goForward()},
      {label:'Reload',click:()=>wc.reload()},
    ]);
    groups.push([
      {label:'Comment',enabled:/^https?:/.test(tab.url),click:()=>{try{if(tab.id!==activeId)select(tab.id);if(!annotating)setAnnotating(true);wc.send('elpis:annotate',{type:'pickAt',x,y});}catch{}}},
      {label:'Inspect',click:()=>{if(!wc.isDevToolsOpened?.())wc.openDevTools({mode:'detach'});wc.inspectElement(params.x,params.y);}},
    ]);
    Menu.buildFromTemplate(groups.flatMap((group,index)=>index?[{type:'separator'},...group]:group)).popup({window:host});
  }

  function zoom(tab,direction){const wc=tab.view.webContents;wc.setZoomFactor(zoomStep(wc.getZoomFactor(),direction));emit();}
  function openFind(tab){tab.find.open=true;tab.find.focus++;emit();host.webContents.focus();}
  function keyboard(event,input,tab=null){
    if(input.type!=='keyDown'||!visible)return;
    const key=input.key.toLowerCase(),primary=(input.control||input.meta)&&!input.alt;
    const page=tab??null,act=fn=>{event.preventDefault();fn();};
    if(page&&input.alt&&!input.control&&!input.meta&&(key==='arrowleft'||key==='arrowright'))return act(()=>{const history=page.view.webContents.navigationHistory;if(key==='arrowleft'&&history.canGoBack())history.goBack();else if(key==='arrowright'&&history.canGoForward())history.goForward();});
    if(page&&key==='f5')return act(()=>input.shift?page.view.webContents.reloadIgnoringCache():page.view.webContents.reload());
    if(!primary)return;
    if(key==='l')act(focusInput);
    // In Elpis's own window Ctrl+T, Ctrl+W and Ctrl+Tab belong to the chat tabs (the renderer); a page that has the focus keeps them for the side panel's page tabs.
    else if(!page)return;
    else if(key==='t')act(()=>{try{open();}catch{}});
    else if(key==='w')act(()=>close(activeId));
    else if(key==='tab'&&tabs.size)act(()=>{const ids=[...tabs.keys()],index=ids.indexOf(activeId);select(ids[(index+(input.shift?ids.length-1:1))%ids.length]);});
    else if(key==='r')act(()=>input.shift?page.view.webContents.reloadIgnoringCache():page.view.webContents.reload());
    // Ctrl+Shift+F is full view (the window toggles it when the count changes), not find.
    else if(key==='f'&&input.shift)act(()=>{fullView++;emit();});
    else if(key==='f')act(()=>openFind(page));
    else if(key==='='||key==='+')act(()=>zoom(page,'in'));
    else if(key==='-')act(()=>zoom(page,'out'));
    else if(key==='0')act(()=>zoom(page,'reset'));
    else if(key==='p')act(()=>page.view.webContents.print({}));
  }
  const rootKeyboard=(event,input)=>keyboard(event,input);
  const resetLayout=(_event,_url,inPlace,isMainFrame)=>{if(isMainFrame&&!inPlace){bounds=null;place();}};
  host.webContents.on('before-input-event',rootKeyboard);
  host.webContents.on('did-start-navigation',resetLayout);
  host.on('resize',place);
  const trusted=event=>{if(!trustedBrowserSender(event,host.webContents,origin))throw Error('Browser controls are available only to Elpis.');};
  const text=(value,limit,label)=>{if(typeof value!=='string'||value.length>limit)throw Error(`Invalid ${label}.`);return value;};
  async function run(input){
    const tab=tabs.get(input.id??activeId),current=active();
    const need=()=>{if(!current)throw Error('Open a browser tab first.');return current;};
    switch(input.action){
      case 'state':break;
      case 'agentStop':agent.stop();break;
      case 'agentAllow':agent.allow();break;
      case 'toggle':if(!tabs.size)open();else{visible=!visible;place();emit();}break;
      case 'hide':visible=false;place();emit();break;
      case 'new':open(input.url);break;
      case 'select':select(input.id);break;
      case 'close':close(input.id);break;
      case 'navigate':if(!tab)throw Error('Open a browser tab first.');navigate(tab,input.url);break;
      case 'back':if(tab?.view.webContents.navigationHistory.canGoBack())tab.view.webContents.navigationHistory.goBack();break;
      case 'forward':if(tab?.view.webContents.navigationHistory.canGoForward())tab.view.webContents.navigationHistory.goForward();break;
      case 'reload':tab?.view.webContents.reload();break;
      case 'hardReload':tab?.view.webContents.reloadIgnoringCache();break;
      case 'stop':tab?.view.webContents.stop();break;
      case 'external':if(tab&&/^https?:/.test(tab.url)&&openExternal)void openExternal(tab.url);break;
      case 'duplicate':if(tab&&/^https?:/.test(tab.url))open(tab.url,{after:tab.id});break;
      case 'copyUrl':if(tab&&/^https?:/.test(tab.url))clipboard?.writeText(tab.url);break;
      case 'annotate':setAnnotating(input.value===undefined?!annotating:input.value===true);break;
      case 'comment':{
        const page=need(),body=text(input.body,8000,'comment').trim();
        if(!page.draft)throw Error('Select something on the page first.');
        if(!body)throw Error('Write a comment first.');
        if(page.draft.editing){const item=page.comments.find(comment=>comment.id===page.draft.editing);if(item)item.body=body;}
        else page.comments.push({...page.draft,number:page.comments.length+1,body,editing:null});
        page.draft=null;syncPage(page);emit();break;
      }
      case 'commentEdit':editComment(need(),text(input.id,100,'comment'));break;
      case 'commentDelete':{const page=need();page.comments=page.comments.filter(item=>item.id!==input.id);if(page.draft?.editing===input.id)page.draft=null;renumber(page);syncPage(page);emit();break;}
      case 'commentCancel':{const page=need();page.draft=null;syncPage(page);emit();break;}
      case 'markers':markersVisible=!markersVisible;syncPage(current);emit();break;
      case 'annotationsDiscard':{const page=need();page.comments=[];page.draft=null;syncPage(page);emit();break;}
      case 'annotationsCollect':return {...snapshot(),result:collect(need(),input.value==='images')};
      case 'annotationsSent':{const page=need();page.comments=[];page.draft=null;annotating=false;syncPage(page);emit();break;}
      case 'zoom':if(!['in','out','reset'].includes(input.value))throw Error('Invalid zoom.');zoom(need(),input.value);break;
      case 'findOpen':openFind(need());break;
      case 'find':{
        const page=need(),query=text(input.text,500,'search');
        const again=page.find.text===query;page.find={...page.find,open:true,text:query};
        // Electron's findNext starts a new search session: true for new text, false to step through matches.
        if(query)page.view.webContents.findInPage(query,{forward:input.value!=='previous',findNext:!again});
        else{page.view.webContents.stopFindInPage('clearSelection');page.find.matches=0;page.find.active=0;}
        emit();break;
      }
      case 'findClose':{const page=need();page.view.webContents.stopFindInPage('keepSelection');page.find={...page.find,open:false,matches:0,active:0};emit();break;}
      case 'print':need().view.webContents.print({});break;
      case 'devtools':{const wc=need().view.webContents;if(wc.isDevToolsOpened?.())wc.closeDevTools?.();else wc.openDevTools({mode:'detach'});break;}
      case 'screenshot':{
        const page=need(),image=await page.view.webContents.capturePage();
        if(input.value==='copy'){clipboard?.writeImage(image);return {...snapshot(),result:{copied:true}};}
        return {...snapshot(),result:{image:await capture(page)}};
      }
      case 'clearData':
        if(input.value==='cookies')await browserSession.clearStorageData({storages:['cookies']});
        else if(input.value==='cache')await browserSession.clearCache();
        else throw Error('Choose cookies or cache.');
        break;
      default:throw Error('Unknown browser command.');
    }
    return snapshot();
  }
  ipcMain.handle('elpis:browser',async(event,input)=>{
    try {
      trusted(event);
      if(!input||typeof input!=='object'||Object.keys(input).some(key=>!COMMANDS.includes(key)))throw Error('Invalid browser command.');
      return await run(input);
    } catch(error) { return {error:error.message||'The browser is unavailable. Try opening it again.'}; }
  });
  const layout=(event,input)=>{
    try{
      trusted(event);if(!input||typeof input.obscured!=='boolean')return;
      nativeBounds(input.bounds,1,host.getContentBounds());bounds=input.bounds;obscured=input.obscured;place();
    }catch{ /* Ignore malformed or untrusted layout messages. */ }
  };
  ipcMain.on('elpis:browser:layout',layout);
  ipcMain.on('elpis:browser:page',pageMessage);
  return {open,agent,dispose(){
    agent.dispose();
    disposed=true;ipcMain.removeHandler('elpis:browser');ipcMain.removeListener('elpis:browser:layout',layout);ipcMain.removeListener('elpis:browser:page',pageMessage);
    host.webContents.removeListener('before-input-event',rootKeyboard);host.webContents.removeListener('did-start-navigation',resetLayout);host.removeListener('resize',place);
    for(const tab of tabs.values())tab.view.webContents.close({waitForBeforeUnload:false});tabs.clear();
  }};
}
module.exports={createBrowser};
