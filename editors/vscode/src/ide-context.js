'use strict';
// Wire format matches codex-rs/tui/src/ide_context/ipc.rs: u32 LE + JSON.
const net=require('node:net');const fs=require('node:fs/promises');
const path=require('node:path');const {randomUUID}=require('node:crypto');
const limit=1024*1024;
function write(socket,value){const body=Buffer.from(JSON.stringify(value));const header=Buffer.alloc(4);header.writeUInt32LE(body.length);socket.write(Buffer.concat([header,body]));}
function receive(socket,callback){let buffer=Buffer.alloc(0);socket.on('data',chunk=>{buffer=Buffer.concat([buffer,chunk]);if(buffer.length>limit+4){socket.destroy();return;}if(buffer.length<4)return;const length=buffer.readUInt32LE();if(length>limit){socket.destroy();return;}if(buffer.length<length+4)return;try{const value=JSON.parse(buffer.subarray(4,length+4));buffer=Buffer.alloc(0);callback(value);}catch{socket.destroy();}});}
function requestContext(endpoint,workspaceRoot){return new Promise((resolve,reject)=>{const socket=net.createConnection(endpoint);let answered=false;socket.setTimeout(1500,()=>socket.destroy(Error('IDE context timeout')));socket.on('error',reject);socket.on('close',()=>{if(!answered)reject(Error('IDE context disconnected'));});receive(socket,value=>{answered=true;resolve(value);socket.end();});socket.on('connect',()=>write(socket,{type:'request',requestId:randomUUID(),sourceClientId:'codex-tui',version:0,method:'ide-context',params:{workspaceRoot}}));});}
function probe(endpoint){return new Promise((resolve,reject)=>{const socket=net.createConnection(endpoint);socket.setTimeout(500,()=>socket.destroy(Error('IDE socket probe timeout')));socket.once('error',reject);socket.once('connect',()=>{socket.end();resolve();});});}
async function listen(endpoint,read){
 const clients=new Set();const server=net.createServer(socket=>{clients.add(socket);socket.on('close',()=>clients.delete(socket));socket.on('error',()=>{});socket.setTimeout(5000,()=>socket.destroy());receive(socket,async request=>{
  if(request.type!=='request'||request.method!=='ide-context'||request.version!==0||typeof request.requestId!=='string'||typeof request.params?.workspaceRoot!=='string'){socket.destroy();return;}
  let result;try{result=await read(request.params.workspaceRoot);}catch{}
  write(socket,{type:'response',requestId:request.requestId,method:'ide-context',resultType:result?'success':'error',...(result?{result}:{error:'no-client-found'})});
 });});
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(endpoint,resolve);});await fs.chmod(endpoint,0o600);
 return async()=>{for(const client of clients)client.destroy();await new Promise(resolve=>server.close(resolve));};
}
async function startContextService({home,readContext}){
 const dir=path.join(home,'ipc');
 if(Buffer.byteLength(path.join(dir,'elpis-context-'+randomUUID()+'.sock'))>103)throw Error('Elpis home path is too long for IDE IPC; configure a shorter home path');
 await fs.mkdir(dir,{recursive:true,mode:0o700});
 const info=await fs.lstat(dir);if(info.isSymbolicLink()||!info.isDirectory()||info.uid!==process.getuid())throw Error('Elpis IPC directory must be owned by this user');await fs.chmod(dir,0o700);
 const privatePath=path.join(dir,`elpis-context-${randomUUID()}.sock`);const publicPath=path.join(dir,'ipc.sock');
 const stopPrivate=await listen(privatePath,readContext);let stopPublic,closed=false,claiming=false;
 async function route(root){
  const entries=(await fs.readdir(dir)).filter(name=>/^elpis-context-[\da-f-]+\.sock$/.test(name));
  const responses=await Promise.all(entries.map(async name=>{try{const endpoint=path.join(dir,name);const stat=await fs.lstat(endpoint);if(!stat.isSocket()||stat.uid!==process.getuid())return;const response=await requestContext(endpoint,root);return response.resultType==='success'?response.result:undefined;}catch{}}));
  const contexts=responses.filter(Boolean);return contexts.find(context=>context.focused)||contexts[0];
 }
 async function claim(){
  if(closed||stopPublic||claiming)return;claiming=true;
  try{stopPublic=await listen(publicPath,route);}catch(error){
   if(error.code!=='EADDRINUSE')throw error;
   // Recover only an owned, stale socket; never replace a live provider.
   const before=await fs.lstat(publicPath).catch(()=>null);
   if(before?.isSocket()&&before.uid===process.getuid()){
    try{await probe(publicPath);}catch(error){if(error.code==='ECONNREFUSED'){const after=await fs.lstat(publicPath).catch(()=>null);if(after?.ino===before.ino)await fs.unlink(publicPath).catch(()=>{});}}
   }
  }finally{claiming=false;}
 }
 try{await claim();}catch(error){await stopPrivate();throw error;}
 const timer=setInterval(()=>{void claim().catch(()=>{});},1000);timer.unref();
 return {async dispose(){closed=true;clearInterval(timer);while(claiming)await new Promise(resolve=>setTimeout(resolve,10));if(stopPublic)await stopPublic();await stopPrivate();}};
}
module.exports={startContextService,requestContext};
