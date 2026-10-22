import net from 'node:net';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import browserAgent from '../desktop/browser-agent.cjs';
export const tools=browserAgent.tools;

// Thread-local override only: never writes the user's MCP configuration.
export function browserMcpConfig(socketPath,node=process.env.ELPIS_NODE_BIN||'node',capability,connectionFile) {
  return {'mcp_servers.elpis_browser':{command:node,args:[fileURLToPath(import.meta.url)],env:{ELPIS_BROWSER_SOCKET:socketPath,...(capability?{ELPIS_BROWSER_CAPABILITY:capability}:{}),...(connectionFile?{ELPIS_BROWSER_CONNECTION:connectionFile}:{})},startup_timeout_sec:10,tool_timeout_sec:35,default_tools_approval_mode:'approve',tools:{browser_open:{approval_mode:'auto'}}}};
}

export function callBrowser(socketPath,name,args,capability,sessionId) {
  return new Promise((resolve,reject)=>{
    if(!socketPath)return reject(Error('No desktop browser is connected.'));
    const socket=net.createConnection(socketPath);let buffer='';
    socket.setEncoding('utf8');
    const fail=error=>{socket.destroy();reject(error);};
    socket.setTimeout(34000,()=>fail(Error('The desktop browser did not respond.')));
    socket.on('error',fail);
    socket.on('connect',()=>socket.write(JSON.stringify({name,arguments:args,capability,sessionId})+'\n'));
    socket.on('data',data=>{
      buffer+=data.toString('utf8');if(Buffer.byteLength(buffer)>12*1024*1024)return fail(Error('Browser result is too large.'));
      if(!buffer.includes('\n'))return;
      try{const value=JSON.parse(buffer.slice(0,buffer.indexOf('\n')));socket.destroy();if(value.error)reject(Error(value.error));else resolve(value.result);}catch(error){fail(error);}
    });
    socket.on('end',()=>{if(!buffer.includes('\n'))fail(Error('The desktop browser disconnected.'));});
  });
}

export async function handleMcp(request,call) {
  if(!request||typeof request!=='object'||Array.isArray(request)||typeof request.method!=='string')return {jsonrpc:'2.0',id:null,error:{code:-32600,message:'Invalid MCP request'}};
  if(request.id===undefined)return null;
  const reply=result=>({jsonrpc:'2.0',id:request.id,result});
  if(request.method==='initialize')return reply({protocolVersion:request.params?.protocolVersion||'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'elpis-browser',version:'1.0.0'}});
  if(request.method==='ping')return reply({});
  if(request.method==='tools/list')return reply({tools});
  if(request.method==='tools/call'){
    try{
      const {name,arguments:args={}}=request.params||{};
      if(!tools.some(tool=>tool.name===name))throw Error('Unknown browser tool.');
      const result=await call(name,args,request.params?._meta);
      return reply(result?.content?result:{content:[{type:'text',text:JSON.stringify(result)}]});
    }catch(error){return reply({isError:true,content:[{type:'text',text:error.message}]});}
  }
  return {jsonrpc:'2.0',id:request.id,error:{code:-32601,message:'Unknown MCP method'}};
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const lines=createInterface({input:process.stdin,crlfDelay:Infinity});
  lines.on('line',line=>{
    void (async()=>{
      let request;
      try{if(Buffer.byteLength(line)>65536)throw Error('Request too large');request=JSON.parse(line);}
      catch{process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:null,error:{code:-32700,message:'Invalid JSON request'}})+'\n');return;}
      const response=await handleMcp(request,async(name,args,meta)=>{
        // A Claude session's MCP calls carry no _meta; its host names the thread in the environment (A37).
        const threadId=typeof meta?.threadId==='string'?meta.threadId:process.env.ELPIS_THREAD_ID;
        if(typeof threadId!=='string')throw Error('The browser requires host-owned session metadata.');
        const socketPath=process.env.ELPIS_BROWSER_CONNECTION?JSON.parse(await fs.readFile(process.env.ELPIS_BROWSER_CONNECTION,'utf8')).socketPath:process.env.ELPIS_BROWSER_SOCKET;
        return callBrowser(socketPath,name,args,process.env.ELPIS_BROWSER_CAPABILITY,threadId);
      });
      if(response)process.stdout.write(JSON.stringify(response)+'\n');
    })();
  });
}
