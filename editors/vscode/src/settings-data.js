const {withRuntime} = require('./runtime-query');
const editable = {
  web_search:['disabled','cached','live'],
  model_verbosity:['low','medium','high'],
  model_reasoning_summary:['auto','concise','detailed','none'],
  developer_instructions:'text',
};
async function readSettings(root, options, section) {
  if(section==='general')return {};
  return withRuntime(root, options, async rpc=>{
    if(['general','configuration','personalization'].includes(section)) {
      const data=await rpc.request('config/read',{cwd:root,includeLayers:true});
      const user=data.layers?.find(layer=>layer.name.type==='user' && !layer.name.profile);
      return {values:Object.fromEntries(Object.keys(editable).map(key=>[key,data.config[key] ?? ''])),version:user?.version,fields:editable};
    }
    if(section==='account') {
      const data=await rpc.request('account/read',{refreshToken:false});
      return {account:data.account};
    }
    if(section==='usage') return rpc.request('account/rateLimits/read',{});
    if(section==='mcp') {
      const servers=[],seen=new Set();let cursor;
      do {
        const page=await rpc.request('mcpServerStatus/list',{limit:100,...(cursor?{cursor}:{})});
        servers.push(...page.data.map(server=>({name:server.name,authStatus:server.authStatus,tools:Object.keys(server.tools || {}),resources:server.resources?.length || 0})));
        cursor=page.nextCursor;
        if(cursor && seen.has(cursor)) throw new Error('MCP server listing repeated a page.');
        seen.add(cursor);
      }while(cursor);
      return {servers};
    }
    if(section==='hooks') {
      const data=await rpc.request('hooks/list',{cwds:[root]});
      return {hooks:data.data.flatMap(entry=>entry.hooks.map(hook=>({key:hook.key,event:hook.eventName,enabled:hook.enabled,sourcePath:hook.sourcePath,trustStatus:hook.trustStatus}))),warnings:data.data.flatMap(entry=>entry.warnings)};
    }
    if(section==='plugins') {
      const data=await rpc.request('plugin/installed',{cwds:[root]});
      return {plugins:data.marketplaces.flatMap(market=>market.plugins.map(plugin=>({id:plugin.id,name:plugin.name,enabled:plugin.enabled,installed:plugin.installed,marketplace:market.name}))),errors:data.marketplaceLoadErrors};
    }
    throw new Error('Unknown settings section.');
  });
}
async function writeSetting(root,options,key,value,version) {
  if(!Object.hasOwn(editable,key)) throw new Error('This setting cannot be changed here.');
  const allowed=editable[key];
  if(allowed==='text' ? typeof value!=='string' : !allowed.includes(value)) throw new Error('Invalid setting value.');
  if(typeof version!=='string' || !version) throw new Error('Reload settings before saving.');
  return withRuntime(root,options,rpc=>rpc.request('config/value/write',{keyPath:key,value,mergeStrategy:'replace',expectedVersion:version}));
}
module.exports={readSettings,writeSetting};
