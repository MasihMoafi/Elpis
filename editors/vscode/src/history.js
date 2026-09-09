'use strict';
const path = require('node:path');
const { withRuntime } = require('./runtime-query');
const {toolView}=require('./tool-view');
const sameWorkspace = (thread, root) => typeof thread.cwd === 'string' && path.resolve(thread.cwd) === path.resolve(root);
async function listHistory(root, options, search = '', cursor, archived=false) {
  return withRuntime(root, options, async rpc => {
    const result = await rpc.request('thread/list', {cwd:root, sourceKinds:['vscode'], archived, limit:50, ...(search ? {searchTerm:search} : {}), ...(cursor ? {cursor} : {})}, 15000);
    return {threads:result.data.filter(t=>sameWorkspace(t,root)).map(t=>({id:t.id,title:t.name || t.preview || 'Untitled chat',updatedAt:t.updatedAt})), cursor:result.nextCursor};
  });
}
async function readHistory(root, options, id) {
  return withRuntime(root, options, async rpc => {
    const {thread} = await rpc.request('thread/read', {threadId:id,includeTurns:true}, 15000);
    if (!sameWorkspace(thread, root)) throw new Error('This chat belongs to a different workspace.');
    return thread;
  });
}
function transcript(thread) {
  return (thread.turns || []).flatMap(t=>(t.items || []).flatMap(item=>{
    if(item.type==='userMessage') return [{role:'You',text:(item.content || []).filter(p=>p.type==='text').map(p=>p.text).join('\n')}];
    if(item.type==='agentMessage') return [{role:'Elpis',text:item.text}];
    const tool=toolView(item);if(tool)return [tool];
    return [];
  }).concat(t.status==='failed' ? [{role:'Could not complete the request',text:t.error?.message || 'The runtime could not complete this request.'}] : []));
}
async function changeHistory(root,options,id,action,name) {
  const methods={rename:'thread/name/set',archive:'thread/archive',restore:'thread/unarchive'};
  if(!Object.hasOwn(methods,action))throw new Error('Unknown history action.');
  if(action==='rename' && (typeof name!=='string' || !name.trim()))throw new Error('Enter a conversation name.');
  return withRuntime(root,options,async rpc=>{
    const {thread}=await rpc.request('thread/read',{threadId:id,includeTurns:false});
    if(!sameWorkspace(thread,root))throw new Error('This chat belongs to a different workspace.');
    return rpc.request(methods[action],{threadId:id,...(action==='rename'?{name:name.trim()}:{})});
  });
}
module.exports = {listHistory, readHistory, transcript, changeHistory};
