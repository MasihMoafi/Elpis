import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { createInterface } from 'node:readline';
import { browserMcpConfig, handleMcp, callBrowser, tools } from './browser-mcp.mjs';
const { startBrowserAgentSocket } = createRequire(import.meta.url)('../desktop/browser-agent.cjs');

test('MCP lists typed tools and returns screenshots as images, failures as tool errors', async () => {
  assert.equal((await handleMcp(null,async()=>{})).error.code,-32600);
  const listed = await handleMcp({id:1,method:'tools/list'},async()=>{});
  assert.deepEqual(listed.result.tools.map(tool=>tool.name),tools.map(tool=>tool.name));
  assert.equal(tools.length,11);
  const image = {content:[{type:'image',mimeType:'image/jpeg',data:'anBlZw=='}]};
  const request={id:2,method:'tools/call',params:{name:'browser_screenshot',arguments:{tabId:'one'}}};
  assert.deepEqual((await handleMcp(request,async()=>image)).result,image);
  assert.equal((await handleMcp(request,async()=>{throw Error('taken over');})).result.isError,true);
  assert.equal((await handleMcp({id:3,method:'tools/call',params:{name:'unknown'}},async()=>{})).result.isError,true);
});

test('stdio MCP initializes, forwards tools over the socket, and fails closed when disconnected', async () => {
  const endpoint=await startBrowserAgentSocket();
  endpoint.setAgent({call:async(name,args)=>({name,args})});
  const config=browserMcpConfig(endpoint.path,process.execPath)['mcp_servers.elpis_browser'];
  assert.equal(config.command,process.execPath);assert.equal(config.env.ELPIS_BROWSER_SOCKET,endpoint.path);
  const child=spawn(config.command,config.args,{env:{...process.env,...config.env},stdio:['pipe','pipe','pipe']});
  const pending=new Map();let nextId=0;
  const lines=createInterface({input:child.stdout});
  lines.on('line',line=>{const value=JSON.parse(line);pending.get(value.id)?.(value);pending.delete(value.id);});
  const rpc=(method,params)=>new Promise(resolve=>{const id=++nextId;pending.set(id,resolve);child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');});
  try {
    const init=await rpc('initialize',{protocolVersion:'2024-11-05'});
    assert.equal(init.result.protocolVersion,'2024-11-05');
    assert.equal((await rpc('tools/list')).result.tools.length,11);
    const call=await rpc('tools/call',{name:'browser_open',arguments:{url:'https://example.com'}});
    assert.equal(JSON.parse(call.result.content[0].text).name,'browser_open');
    endpoint.setAgent(null);
    assert.equal((await rpc('tools/call',{name:'browser_tabs',arguments:{}})).result.isError,true);
  } finally {child.stdin.end();child.kill();lines.close();await endpoint.close();}
  await assert.rejects(callBrowser(endpoint.path,'browser_tabs',{}));
});
