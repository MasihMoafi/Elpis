'use strict';
const api=acquireVsCodeApi();
let section='general',requestId=0,version;
const content=document.getElementById('content'),notice=document.getElementById('notice');
function element(tag,text,cls=''){const e=document.createElement(tag);if(text!==undefined)e.textContent=text;e.className=cls;return e;}
function load(){notice.textContent='Loading…';content.replaceChildren();api.postMessage({type:'load',section,requestId:++requestId});}
for(const button of document.querySelectorAll('[data-section]'))button.onclick=()=>{section=button.dataset.section;document.getElementById('title').textContent=button.textContent;for(const other of document.querySelectorAll('[data-section]'))other.classList.toggle('menu-active',other===button);load();};
document.getElementById('refresh').onclick=load;
function row(title,description){const r=element('div',undefined,'border-b border-base-300 py-4');r.append(element('h3',title,'font-medium'));if(description)r.append(element('p',description,'text-sm opacity-70 mt-1 break-all'));content.append(r);return r;}
function action(label,id){const b=element('button',label,'btn btn-sm mt-3');b.type='button';b.onclick=()=>api.postMessage({type:'action',action:id});return b;}
function toggle(title,key,current,description){const r=row(title,description);const input=element('input',undefined,'toggle mt-3');input.type='checkbox';input.checked=current;input.setAttribute('aria-label',title);input.onchange=()=>api.postMessage({type:'preference',key,value:input.checked});r.append(input);}
function select(title,key,values,current,preference=false){const r=row(title);const input=element('select',undefined,'select select-sm w-full max-w-sm mt-2');input.setAttribute('aria-label',title);input.dataset.setting=key;
  if(!current){const o=element('option','Runtime default');o.value='';o.disabled=true;input.append(o);}
  for(const value of values){const o=element('option',value);o.value=value;input.append(o);}input.value=current || '';
  input.onchange=()=>{notice.textContent='Saving…';api.postMessage({type:preference?'preference':'save',key,value:input.value,version});};r.append(input);
}
window.addEventListener('message',({data})=>{
  if(data.type==='navigate'){document.querySelector(`[data-section="${data.section}"]`)?.click();return;}
  if(data.type==='error'){if(data.requestId && data.requestId!==requestId)return;notice.textContent=data.text;return;}
  if(data.type==='saved'){load();notice.textContent=data.text;return;}
  if(data.type==='refresh'){load();return;}
  if(data.type!=='data' || data.requestId!==requestId)return;
  notice.textContent='';version=data.data.version;content.replaceChildren();const value=data.data;
  if(section==='general'){
    select('Send shortcut','sendShortcut',['Enter','Ctrl+Enter'],data.preferences.sendShortcut,true);
    select('Follow-up behavior','followupBehavior',['queue','steer'],data.preferences.followupBehavior,true);
    toggle('Show context window usage','showContextUsage',data.preferences.showContextUsage,'Show the last reported context usage, not lifetime token spending.');
    toggle('IDE context','editorAccess',data.preferences.editorAccess,'Allow access to unsaved editor text, diagnostics and navigation.');
  }else if(section==='configuration'){
    row('Provider and model','Choose models from your provider or Elpis runtime.').append(action('Choose provider / model','provider'));
    row('Thinking level').append(action('Choose thinking level','thinking'));
    select('Web search','web_search',value.fields.web_search,value.values.web_search);
    select('Response length','model_verbosity',value.fields.model_verbosity,value.values.model_verbosity);
    select('Reasoning summaries','model_reasoning_summary',value.fields.model_reasoning_summary,value.values.model_reasoning_summary);
    row('Configuration file','Advanced settings in your Elpis home.').append(action('Open config.toml','config'),action('Choose runtime','runtime'));
  }else if(section==='personalization'){
    const r=row('Custom instructions','Instructions for new Elpis conversations.');const input=element('textarea',undefined,'textarea w-full min-h-48 mt-3');input.value=value.values.developer_instructions;input.setAttribute('aria-label','Custom instructions');const save=element('button','Save instructions','btn btn-sm mt-3');save.onclick=()=>api.postMessage({type:'save',key:'developer_instructions',value:input.value,version});r.append(input,save);
  }else if(section==='account'){
    select('Login source','accountSource',['elpis','codex'],data.preferences.accountSource,true);
    row('Use your existing login','Codex uses the ChatGPT login saved by Codex. Your Elpis configuration and conversations stay in Elpis. Explicit provider API keys take precedence.');
    const account=value.account;row('Connected account',account ? account.type==='chatgpt'?`${account.email || 'ChatGPT account'} · ${account.planType}`:account.type : 'No OpenAI account is connected in this Elpis home.');row('Provider credentials','Provider API keys are stored by VS Code.').append(action('Manage API key','key'),action('Choose provider','provider'));
  }else if(section==='usage'){
    const limits=value.rateLimitsByLimitId || {codex:value.rateLimits};for(const [name,limit] of Object.entries(limits)){for(const kind of ['primary','secondary']){const window=limit?.[kind];if(window)row(`${name} · ${kind}`,`${window.usedPercent}% used${window.resetsAt ? ' · resets '+new Date(window.resetsAt*1000).toLocaleString():''}`);}}
    if(!content.children.length)row('Usage','This account returned no usage windows.');
  }else if(section==='mcp'){
    for(const server of value.servers)row(server.name,`${server.tools.length} tools · ${server.resources} resources · ${server.authStatus}`);
    if(!value.servers.length)row('No MCP servers configured');row('Configure servers').append(action('Open config.toml','config'));
  }else if(section==='hooks'){
    for(const hook of value.hooks)row(hook.event,`${hook.enabled?'Enabled':'Disabled'} · ${hook.trustStatus} · ${hook.sourcePath}`);
    if(!value.hooks.length)row('No hooks configured');for(const warning of value.warnings || [])row('Warning',warning);row('Configure hooks').append(action('Open config.toml','config'));
  }else if(section==='plugins'){
    for(const plugin of value.plugins)row(plugin.name,`${plugin.marketplace} · ${plugin.installed?'Installed':'Available'} · ${plugin.enabled?'Enabled':'Disabled'}`);
    if(!value.plugins.length)row('No installed plugins');for(const error of value.errors || [])row('Marketplace error',error.message || String(error));row('Plugin configuration').append(action('Open config.toml','config'));
  }
});
api.postMessage({type:'ready'});
