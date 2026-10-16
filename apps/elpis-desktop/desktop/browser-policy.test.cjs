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
test('a page that fails to load explains the cause, as the ChatGPT app does, and names a stopped dev server',()=>{
  const {loadFailure}=require('./browser-policy.cjs');
  const refused=loadFailure(-102,'ERR_CONNECTION_REFUSED','http://localhost:3000/');
  assert.equal(refused.heading,"This site can't be reached");
  assert.equal(refused.summary,'localhost refused to connect');
  assert.equal(refused.code,'ERR_CONNECTION_REFUSED');
  assert.match(refused.tips.join('\n'),/development server/,'local addresses suggest starting the dev server');
  assert.equal(loadFailure(-105,'ERR_NAME_NOT_RESOLVED','https://nowhere.invalid/x').summary,"nowhere.invalid's server IP address could not be found");
  assert.equal(loadFailure(-118,'ERR_CONNECTION_TIMED_OUT','https://slow.example/').summary,'slow.example took too long to respond');
  assert.equal(loadFailure(-106,'ERR_INTERNET_DISCONNECTED','https://a.example/').summary,'a.example could not be loaded because the computer is offline');
  assert.equal(loadFailure(-202,'ERR_CERT_AUTHORITY_INVALID','https://self.example/').summary,"self.example's certificate could not be verified");
  assert.equal(loadFailure(-130,'ERR_PROXY_CONNECTION_FAILED','https://a.example/').tips.some(tip=>/proxy/i.test(tip)),true);
  assert.equal(loadFailure(-999,'ERR_SOMETHING','https://a.example/').summary,'a.example could not be loaded');
  assert.equal(loadFailure(-102,'ERR_CONNECTION_REFUSED','not a url').summary,'This page refused to connect');
});
test('the address bar marks plain HTTP sites as not secure, but not local development servers',()=>{
  const {pageSecurity}=require('./browser-policy.cjs');
  assert.equal(pageSecurity('https://example.com/'),'secure');
  assert.equal(pageSecurity('http://example.com/'),'insecure');
  assert.equal(pageSecurity('http://192.168.1.4:8080/'),'insecure');
  for(const local of ['http://localhost:3000/','http://127.0.0.1:5173/','http://[::1]:8000/','http://app.localhost/'])assert.equal(pageSecurity(local),'local');
  assert.equal(pageSecurity('about:blank'),null);
});
test('zoom steps match Chromium: 25% to 500%, and reset returns to 100%',()=>{
  const {zoomStep}=require('./browser-policy.cjs');
  assert.equal(zoomStep(1,'in'),1.1);assert.equal(zoomStep(1,'out'),0.9);assert.equal(zoomStep(1.1,'in'),1.25);
  assert.equal(zoomStep(5,'in'),5);assert.equal(zoomStep(0.25,'out'),0.25);assert.equal(zoomStep(1.75,'reset'),1);
  assert.equal(zoomStep(1.18,'in'),1.25,'an off-step zoom moves to the next step');assert.equal(zoomStep(1.18,'out'),1.1);
});
