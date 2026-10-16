'use strict';

const SEARCH='https://www.google.com/search?q=';

function browserUrl(input, appOrigin) {
  if(typeof input!=='string'||!input.trim()||input.length>4096)throw Error('Enter a web address.');
  let value=input.trim();
  if(value==='about:blank')return value;
  // As in the ChatGPT app's address bar, words that are not an address become a search.
  const local=/^(localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d+)?(?:[/?#]|$)/i.test(value);
  const address=local||/^[a-z][a-z0-9+.-]*:/i.test(value)||/^\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?(?:[/?#]|$)/.test(value)||/^[^\s/?#]+\.[a-z]{2,}(?::\d+)?(?:[/?#]|$)/i.test(value);
  if(!address)return SEARCH+encodeURIComponent(value);
  if(local)value=`http://${value}`;
  else if(!/^[a-z][a-z0-9+.-]*:/i.test(value))value=`https://${value}`;
  let url;try{url=new URL(value);}catch{throw Error('Enter a valid web address.');}
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password||/\s/.test(url.hostname)||url.origin===appOrigin)throw Error('Use an HTTP or HTTPS web address.');
  return url.href;
}

function trustedBrowserSender(event, owner, origin) {
  if(event.sender!==owner||event.senderFrame!==owner.mainFrame)return false;
  try{return new URL(event.senderFrame.url).origin===origin;}catch{return false;}
}

function nativeBounds(value,zoom,size) {
  if(!value||typeof value!=='object'||Object.keys(value).some(key=>!['x','y','width','height'].includes(key))||['x','y','width','height'].some(key=>!Number.isFinite(value[key])||value[key]<0||value[key]>100000))throw Error('Invalid browser bounds.');
  const x=Math.min(size.width,Math.round(value.x*zoom)),y=Math.min(size.height,Math.round(value.y*zoom));
  const width=Math.max(0,Math.min(size.width-x,Math.round(value.width*zoom))),height=Math.max(0,Math.min(size.height-y,Math.round(value.height*zoom)));
  return width&&height?{x,y,width,height}:null;
}

const LOCAL_HOST=/^(localhost|127(?:\.\d{1,3}){3}|\[::1\]|[^/]+\.localhost)$/i;
const hostOf=url=>{try{return new URL(url).hostname||null;}catch{return null;}};

/** The ChatGPT app's "This site can't be reached" screen, from Chromium's network error code. */
function loadFailure(code,description,url) {
  const host=hostOf(url),name=host??'This page',local=!!host&&LOCAL_HOST.test(host);
  const connection='Checking the connection',network='Checking the proxy, firewall, and DNS configuration';
  let summary=`${name} could not be loaded`,tips=[connection,network];
  if(code===-105||code===-137)summary=`${name}'s server IP address could not be found`;
  else if(code===-102||code===-100||code===-101){summary=`${name} refused to connect`;if(local)tips=['Checking that the development server is running on this port',connection];}
  else if(code===-118||code===-7)summary=`${name} took too long to respond`;
  else if(code===-106){summary=`${name} could not be loaded because the computer is offline`;tips=['Checking your Internet connection'];}
  else if(code<=-200&&code>-300){summary=`${name}'s certificate could not be verified`;tips=['Checking that the address is correct','Checking the computer date and time'];}
  else if(code===-130||code===-111||code===-115)tips=['Checking the proxy settings for the active network',connection];
  return {heading:"This site can't be reached",summary,tips,code:/^ERR_[A-Z_]+$/.test(String(description))?description:`Error ${code}`};
}

/** "secure", "insecure" (plain HTTP on the network) or "local" (a development server on this computer). */
function pageSecurity(url) {
  let parsed;try{parsed=new URL(url);}catch{return null;}
  if(parsed.protocol==='https:')return 'secure';
  if(parsed.protocol!=='http:')return null;
  return LOCAL_HOST.test(parsed.hostname)?'local':'insecure';
}

const ZOOM_STEPS=[0.25,0.33,0.5,0.67,0.75,0.8,0.9,1,1.1,1.25,1.5,1.75,2,2.5,3,4,5];
/** Chromium's zoom ladder: "in" and "out" move to the next step from any factor; "reset" is 100%. */
function zoomStep(factor,direction) {
  if(direction==='reset')return 1;
  if(direction==='in')return ZOOM_STEPS.find(step=>step>factor+0.001)??ZOOM_STEPS.at(-1);
  return [...ZOOM_STEPS].reverse().find(step=>step<factor-0.001)??ZOOM_STEPS[0];
}
module.exports={browserUrl,trustedBrowserSender,nativeBounds,loadFailure,pageSecurity,zoomStep};
