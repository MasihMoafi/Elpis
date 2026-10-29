'use strict';
// The in-app browser presents itself as stock Google Chrome of its own Chromium version.
// Google sign-in refuses Electron's default identity ("The browser you're using doesn't support JavaScript"):
// its user agent names the app and Electron, and its client hints list only "Chromium".
const GREASE_CHARACTERS=[' ','(',':','-','.','/',')',';','=','?','_'];
const GREASE_VERSIONS=['8','99','24'];
const ORDERS=[[0,1,2],[0,2,1],[1,0,2],[1,2,0],[2,0,1],[2,1,0]];
const PLATFORMS={
  linux:{token:'X11; Linux x86_64',name:'Linux'},
  win32:{token:'Windows NT 10.0; Win64; x64',name:'Windows'},
  darwin:{token:'Macintosh; Intel Mac OS X 10_15_7',name:'macOS'},
};

// Chromium's GenerateBrandVersionList (components/embedder_support/user_agent_utils.cc) for a Google Chrome build:
// the GREASE brand and the order of the three brands are seeded by the major version.
function chromeBrands(chromeVersion,full=false){
  const major=Number.parseInt(chromeVersion,10);
  if(!Number.isInteger(major)||major<1)throw Error(`Not a Chrome version: ${chromeVersion}`);
  const version=full?chromeVersion:String(major),order=ORDERS[major%ORDERS.length],list=[];
  const grease=GREASE_VERSIONS[major%GREASE_VERSIONS.length];
  list[order[0]]={brand:`Not${GREASE_CHARACTERS[major%GREASE_CHARACTERS.length]}A${GREASE_CHARACTERS[(major+1)%GREASE_CHARACTERS.length]}Brand`,version:full?`${grease}.0.0.0`:grease};
  list[order[1]]={brand:'Chromium',version};
  list[order[2]]={brand:'Google Chrome',version};
  return list;
}

// What Chrome reports for this version on this platform: the reduced user agent string and its client-hint metadata.
function chromeIdentity(chromeVersion=process.versions.chrome,platform=process.platform,arch=process.arch){
  const major=Number.parseInt(chromeVersion,10),system=PLATFORMS[platform]??PLATFORMS.linux;
  return {
    userAgent:`Mozilla/5.0 (${system.token}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`,
    metadata:{brands:chromeBrands(chromeVersion),fullVersionList:chromeBrands(chromeVersion,true),fullVersion:chromeVersion,
      platform:system.name,platformVersion:'',architecture:arch.startsWith('arm')?'arm':'x86',model:'',mobile:false,bitness:arch.endsWith('64')?'64':'32',wow64:false,formFactors:['Desktop']},
  };
}

// Stock Chrome sends client hints to secure origins: the low-entropy three on every request, the others to an
// origin whose page asked with Accept-CH. Electron sends none, so the session adds them.
const quote=list=>list.map(({brand,version})=>`"${brand}";v="${version}"`).join(', ');
function hintHeaders({metadata:m}){
  return {low:{'sec-ch-ua':quote(m.brands),'sec-ch-ua-mobile':'?0','sec-ch-ua-platform':`"${m.platform}"`},
    high:{'sec-ch-ua-arch':`"${m.architecture}"`,'sec-ch-ua-bitness':`"${m.bitness}"`,'sec-ch-ua-full-version':`"${m.fullVersion}"`,'sec-ch-ua-full-version-list':quote(m.fullVersionList),
      'sec-ch-ua-model':`"${m.model}"`,'sec-ch-ua-platform-version':`"${m.platformVersion}"`,'sec-ch-ua-wow64':'?0','sec-ch-ua-form-factors':'"Desktop"'}};
}
const LOOPBACK=new Set(['localhost','127.0.0.1','[::1]']);
const secure=url=>{try{const {protocol,hostname}=new URL(url);return protocol==='https:'||protocol==='wss:'||(protocol==='http:'||protocol==='ws:')&&LOOPBACK.has(hostname);}catch{return false;}};
const presented=new WeakSet();

// The whole browser session sends Chrome's user agent string and client hints (frames, workers and service workers
// included). Electron has no API for the page's navigator.userAgentData; presentPageAsChrome sets it per page.
function presentAsChrome(browserSession){
  if(presented.has(browserSession))return;presented.add(browserSession);
  const identity=chromeIdentity(),hints=hintHeaders(identity),asked=new Map();
  browserSession.setUserAgent(identity.userAgent);
  browserSession.webRequest.onHeadersReceived((details,callback)=>{
    const name=Object.keys(details.responseHeaders??{}).find(key=>key.toLowerCase()==='accept-ch');
    if(name&&details.resourceType==='mainFrame'&&secure(details.url))
      asked.set(new URL(details.url).origin,details.responseHeaders[name].join(',').split(',').map(item=>item.trim().toLowerCase()).filter(item=>item in hints.high));
    callback({});
  });
  browserSession.webRequest.onBeforeSendHeaders((details,callback)=>{
    if(!secure(details.url))return callback({});
    const headers={...details.requestHeaders,...hints.low};
    for(const item of asked.get(new URL(details.url).origin)??[])headers[item]=hints.high[item];
    callback({requestHeaders:headers});
  });
}
function presentPageAsChrome(webContents,identity=chromeIdentity()){
  const override={userAgent:identity.userAgent,userAgentMetadata:identity.metadata},dbg=webContents.debugger;
  const send=(method,params,sessionId)=>dbg.sendCommand(method,params,sessionId).catch(()=>{});
  try{if(!dbg.isAttached())dbg.attach('1.3');}catch{return;}
  dbg.on('message',(_event,method,params)=>{
    if(method!=='Target.attachedToTarget')return;
    const {sessionId,targetInfo,waitingForDebugger}=params;
    // A frame waits for the override, then always runs, so a failed command can never leave it paused.
    void (targetInfo.type==='iframe'?Promise.all([send('Emulation.setUserAgentOverride',override,sessionId),send('Target.setAutoAttach',{autoAttach:true,waitForDebuggerOnStart:true,flatten:true},sessionId)]):Promise.resolve())
      .then(()=>{if(waitingForDebugger)return send('Runtime.runIfWaitingForDebugger',undefined,sessionId);});
  });
  void send('Emulation.setUserAgentOverride',override);
  void send('Target.setAutoAttach',{autoAttach:true,waitForDebuggerOnStart:true,flatten:true});
}

module.exports={chromeBrands,chromeIdentity,presentAsChrome,presentPageAsChrome};
