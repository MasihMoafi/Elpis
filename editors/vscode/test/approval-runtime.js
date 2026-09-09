const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const {Session} = require(path.join(process.env.ELPIS_EDITOR_TEST_EXTENSION || path.join(__dirname,'..'), 'src/session'));
const {Provider, call, message} = require('./runtime-eval');

(async()=>{
  const base = await fs.mkdtemp(path.join(process.cwd(), '.test-data/approval-runtime-'));
  const provider = new Provider(); await provider.start();
  try {
    for (const allow of [false,true]) {
      const root=path.join(base,allow?'allow':'reject'); await fs.mkdir(root);
      const marker=path.join(root,'approval-sentinel.txt');
      const home=path.join(root,'home');await fs.mkdir(home);
      await fs.writeFile(path.join(home,'config.toml'), `model="gpt-5.4"\nmodel_provider="approval_eval"\n[model_providers.approval_eval]\nname="Approval evaluation"\nbase_url=${JSON.stringify(provider.url)}\nwire_api="responses"\nrequires_openai_auth=false\n`);
      let reviewed=0;
      const session=new Session(root,{cancel(){}},{executable:process.env.ELPIS_EDITOR_TEST_RUNTIME || path.join(process.cwd(),'bin/elpis-app-server'),home,approve:async request=>{assert.equal(request.method,'item/commandExecution/requestApproval');assert(request.params.command.includes('approval-sentinel'));reviewed++;return allow;}});
      provider.actions.push(request=>{
        const tool=request.tools.find(tool=>tool.name==='exec_command'||tool.name==='shell_command');
        assert(tool,'runtime must advertise a command tool');
        const command=`printf approved > '${marker}'`;
        return call('approval-probe',tool.name,{[tool.name==='exec_command'?'cmd':'command']:command,sandbox_permissions:'require_escalated',justification:'Write the isolated approval test sentinel.'});
      }, message('Approval probe finished.'));
      let timer;
      try {
        const completed=new Promise((resolve,reject)=>{
          timer=setTimeout(()=>reject(new Error('Approval runtime timed out')),45000);
          session.on('notification',n=>{if(n.method==='turn/completed') resolve();});
          session.on('disconnected',text=>reject(new Error(text)));
        });
        await session.send('Run the isolated approval probe.'); await completed;
        assert.equal(reviewed,1,'approval callback must be reached');
        const contents=await fs.readFile(marker,'utf8').catch(error=>{if(error.code==='ENOENT')return null;throw error;});
        assert.equal(contents,allow?'approved':null);
        console.log(JSON.stringify({case:allow?'approved action writes sentinel':'rejected action leaves no sentinel',passed:true}));
      } finally {clearTimeout(timer);session.dispose();}
    }
  } finally {provider.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
