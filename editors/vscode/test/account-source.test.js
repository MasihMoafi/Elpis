'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {connectAccount,refreshAccount}=require('../src/account-source');
test('Codex account is opt-in, transient, refreshable, and never silently switches accounts',async()=>{
  const home=await fs.mkdtemp(path.join(os.tmpdir(),'elpis-account-'));
  const options={accountSource:'codex',codexLoginHome:home};
  const calls=[];const rpc={request:async(method,params)=>calls.push({method,params}),respond:(id,result)=>calls.push({id,result}),send:message=>calls.push(message)};
  try {
    await connectAccount(rpc,{});assert.equal(calls.length,0);
    await assert.rejects(connectAccount(rpc,options),/Sign in/);assert.equal(calls.length,0);
    const auth={tokens:{access_token:'first-token',account_id:'account-a'}};
    await fs.writeFile(path.join(home,'auth.json'),JSON.stringify(auth));
    await connectAccount(rpc,options);
    assert.deepEqual(calls.pop(),{method:'account/login/start',params:{type:'chatgptAuthTokens',accessToken:'first-token',chatgptAccountId:'account-a'}});
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(home,'auth.json'),'utf8')),auth);
    auth.tokens.access_token='refreshed-token';await fs.writeFile(path.join(home,'auth.json'),JSON.stringify(auth));
    assert.equal(await refreshAccount(rpc,{id:1,method:'account/chatgptAuthTokens/refresh',params:{previousAccountId:'account-a'}},options),true);
    assert.equal(calls.pop().result.accessToken,'refreshed-token');
    await refreshAccount(rpc,{id:2,method:'account/chatgptAuthTokens/refresh',params:{previousAccountId:'account-b'}},options);
    assert.match(calls.pop().error.message,/account changed/);
    await connectAccount(rpc,{...options,env:{OPENAI_API_KEY:'explicit-key'}});assert.equal(calls.length,0);
  }finally{await fs.rm(home,{recursive:true,force:true});}
});
