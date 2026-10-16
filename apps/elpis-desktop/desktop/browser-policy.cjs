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
module.exports={browserUrl,trustedBrowserSender,nativeBounds};
