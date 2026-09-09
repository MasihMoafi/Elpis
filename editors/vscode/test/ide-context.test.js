const test=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs/promises');const os=require('node:os');const path=require('node:path');
const {startContextService,requestContext}=require('../src/ide-context');
test('CLI framing routes to the matching IDE; unavailable projects and disabled context do not leak selection',async()=>{
 const home=await fs.mkdtemp(path.join(os.tmpdir(),'elpis-ide-context-'));let enabled=true;
 const first=await startContextService({home,readContext:async root=>root==='/one'?{ideContext:{openTabs:[],activeFile:null}}:null});
 const second=await startContextService({home,readContext:async root=>enabled&&root==='/two'?{ideContext:{openTabs:[],activeFile:{activeSelectionContent:'UNSAVED_IDE_SENTINEL'}}}:null});
 try{
  const socket=path.join(home,'ipc','ipc.sock');
  assert.equal((await requestContext(socket,'/two')).result.ideContext.activeFile.activeSelectionContent,'UNSAVED_IDE_SENTINEL');
  assert.equal((await requestContext(socket,'/one')).result.ideContext.activeFile,null);
  assert.equal((await requestContext(socket,'/foreign')).resultType,'error');
  enabled=false;assert.equal((await requestContext(socket,'/two')).resultType,'error');
  assert.equal((await fs.stat(socket)).mode&0o777,0o600);
  await first.dispose();enabled=true;let recovered;
  for(let i=0;i<30&&!recovered;i++){try{recovered=(await requestContext(socket,'/two')).resultType==='success';}catch{}if(!recovered)await new Promise(resolve=>setTimeout(resolve,100));}
  assert(recovered,'another IDE window takes over after the owner closes');
 }finally{await second.dispose();await first.dispose();await fs.rm(home,{recursive:true,force:true});}
});
test('overlong homes and symlinked IPC directories are rejected before serving context',async()=>{
 await assert.rejects(startContextService({home:'/tmp/'+ 'x'.repeat(110),readContext:async()=>null}),/too long/);
 const home=await fs.mkdtemp(path.join(os.tmpdir(),'elpis-ide-reject-'));const outside=await fs.mkdtemp(path.join(os.tmpdir(),'elpis-ide-outside-'));
 try{await fs.symlink(outside,path.join(home,'ipc'));await assert.rejects(startContextService({home,readContext:async()=>null}),/owned/);assert.deepEqual(await fs.readdir(outside),[]);}finally{await fs.rm(home,{recursive:true,force:true});await fs.rm(outside,{recursive:true,force:true});}
});
