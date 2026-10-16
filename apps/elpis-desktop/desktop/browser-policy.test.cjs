const {test}=require('node:test');
const assert=require('node:assert/strict');
const {browserUrl,trustedBrowserSender,nativeBounds}=require('./browser-policy.cjs');

test('browser accepts web addresses and local development URLs but not executable or private app URLs',()=>{
  assert.equal(browserUrl('example.com/docs'),'https://example.com/docs');
  assert.equal(browserUrl('localhost:3000/review'),'http://localhost:3000/review');
  assert.equal(browserUrl('127.0.0.1:43155/test'),'http://127.0.0.1:43155/test');
  assert.equal(browserUrl('about:blank'),'about:blank');
  for(const value of ['javascript:alert(1)','file:///etc/passwd','data:text/html,hello','https://user:secret@example.com'])assert.throws(()=>browserUrl(value));
  assert.equal(browserUrl('not an address'),'https://www.google.com/search?q=not%20an%20address');
  assert.equal(browserUrl('rust'),'https://www.google.com/search?q=rust');
  assert.equal(browserUrl('192.168.1.10:8080/x'),'https://192.168.1.10:8080/x');
  assert.throws(()=>browserUrl('http://127.0.0.1:43147/api/session','http://127.0.0.1:43147'));
});
test('only the app main frame can control its native browser',()=>{
  const frame={url:'http://127.0.0.1:43147/'},owner={mainFrame:frame};
  assert.equal(trustedBrowserSender({sender:owner,senderFrame:frame},owner,'http://127.0.0.1:43147'),true);
  assert.equal(trustedBrowserSender({sender:owner,senderFrame:{url:frame.url}},owner,'http://127.0.0.1:43147'),false);
  assert.equal(trustedBrowserSender({sender:{},senderFrame:frame},owner,'http://127.0.0.1:43147'),false);
  frame.url='https://example.com';assert.equal(trustedBrowserSender({sender:owner,senderFrame:frame},owner,'http://127.0.0.1:43147'),false);
});
test('browser bounds follow app zoom and cannot extend outside the native content area',()=>{
  assert.deepEqual(nativeBounds({x:400,y:90,width:500,height:600},1.25,{width:1100,height:800}),{x:500,y:113,width:600,height:687});
  assert.equal(nativeBounds({x:0,y:0,width:0,height:0},1,{width:100,height:100}),null);
  for(const bounds of [{x:-1,y:0,width:10,height:10},{x:0,y:NaN,width:10,height:10},{x:0,y:0,width:10,height:10,extra:true}])assert.throws(()=>nativeBounds(bounds,1,{width:100,height:100}));
});
