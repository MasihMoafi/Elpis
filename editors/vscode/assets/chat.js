'use strict';
const api = acquireVsCodeApi();
const messages = document.getElementById('messages');
let connectionPending=false, runtimeBusy=false;
function updateSend() {
  const button=document.getElementById('send');
  button.disabled=connectionPending && !runtimeBusy;
  button.type=runtimeBusy?'button':'submit';
  document.getElementById('send-arrow').classList.toggle('hidden',runtimeBusy);
  document.getElementById('send-stop').classList.toggle('hidden',!runtimeBusy);
  button.title=runtimeBusy?'Stop response':'Send message';
  button.setAttribute('aria-label',button.title);
  const alternate=sendShortcut==='Enter'?'Ctrl+Enter':'Ctrl+Shift+Enter';
  document.getElementById('prompt').title=runtimeBusy?`${sendShortcut} to ${followupBehavior} · ${alternate} to ${followupBehavior==='queue'?'steer':'queue'}`:`${sendShortcut} to send · Shift+Enter for a new line`;
}
document.getElementById('send').onclick=()=>{if(runtimeBusy)api.postMessage({type:'cancel'});};
const permissionsPicker=document.getElementById('permissions-picker');
const thinkingPicker=document.getElementById('thinking-picker');
for(const button of document.querySelectorAll('[data-permission]'))button.onclick=()=>{permissionsPicker.open=false;changeConnection({type:'approvalMode',mode:button.dataset.permission});};
for(const menu of [permissionsPicker,thinkingPicker]) {
  menu.querySelector('summary').addEventListener('click',event=>{if(runtimeBusy||connectionPending)event.preventDefault();});
  menu.addEventListener('toggle',()=>{if(menu.open){for(const other of [permissionsPicker,thinkingPicker,picker])if(other!==menu)other.open=false;}});
  document.addEventListener('click',event=>{if(!menu.contains(event.target))menu.open=false;});
  document.addEventListener('keydown',event=>{if(event.key==='Escape'&&menu.open){menu.open=false;menu.querySelector('summary').focus();}});
}
thinkingPicker.addEventListener('toggle',()=>{if(thinkingPicker.open){document.getElementById('thinking-status').textContent='Loading thinking levels…';api.postMessage({type:'models',requestId:++modelRequest});}});
function changeConnection(message) {
  if(connectionPending || runtimeBusy) return;
  connectionPending=true;updateSend();
  document.getElementById('status').textContent='Updating model settings…';
  api.postMessage(message);
}
document.getElementById('more').onclick = () => {
  const settings = document.getElementById('settings');
  const open = !settings.classList.toggle('hidden');
  settings.classList.toggle('flex', open);
  document.getElementById('more').setAttribute('aria-expanded', String(open));
};
let assistant;
let sendShortcut = 'Enter';
document.getElementById('open-settings').onclick=()=>api.postMessage({type:'settings'});
document.getElementById('open-config').onclick=()=>api.postMessage({type:'config'});
document.getElementById('prompt').addEventListener('keydown', event=>{
  if(event.isComposing || event.key!=='Enter' || event.altKey)return;
  const modified=event.ctrlKey || event.metaKey;
  const opposite=runtimeBusy && modified && (sendShortcut==='Enter'?!event.shiftKey:event.shiftKey);
  if(event.shiftKey && !opposite)return;
  if(opposite || (sendShortcut==='Enter' && !modified) || (sendShortcut==='Ctrl+Enter' && modified)) {
    event.preventDefault();
    if(runtimeBusy)sendFollowup(opposite?(followupBehavior==='queue'?'steer':'queue'):followupBehavior);
    else if(!document.getElementById('send').disabled)document.getElementById('composer').requestSubmit();
  }
});
let catalog = [];
let modelRequest = 0;
let historyRequest = 0;
let historyCursor;
let historyTimer;
let historyArchived=false;
function requestHistory(cursor) {
  document.getElementById('history-status').textContent='Loading chats…';
  api.postMessage({type:'history',requestId:++historyRequest,search:document.getElementById('history-search').value,cursor,archived:historyArchived});
}
document.getElementById('history').onclick=()=>{document.getElementById('history-panel').classList.remove('hidden');requestHistory();};
document.getElementById('history-close').onclick=()=>document.getElementById('history-panel').classList.add('hidden');
document.getElementById('history-search').oninput=()=>{clearTimeout(historyTimer);historyTimer=setTimeout(()=>requestHistory(),250);};
document.getElementById('history-more').onclick=()=>requestHistory(historyCursor);
document.getElementById('history-archived').onclick=()=>{
  historyArchived=!historyArchived;const button=document.getElementById('history-archived');button.textContent=historyArchived?'Show active':'Show archived';button.setAttribute('aria-pressed',String(historyArchived));requestHistory();
};
const picker = document.getElementById('model-picker');
picker.addEventListener('toggle', () => {
  if (picker.open) {
    document.getElementById('model-status').textContent = 'Loading models…';
    document.getElementById('model-options').replaceChildren();
    document.getElementById('effort-label').classList.add('hidden');
    document.getElementById('model-search').value = '';
    api.postMessage({type:'models', requestId:++modelRequest});
  }
});
document.addEventListener('keydown', event => { if (event.key === 'Escape') { picker.open = false; document.getElementById('model').focus(); } });
document.addEventListener('click', event => { if (!picker.contains(event.target)) picker.open = false; });
for (const [id,type] of [['custom-model','customModel'],['menu-provider','provider']]) document.getElementById(id).onclick = () => { picker.open = false; api.postMessage({type}); };
document.getElementById('model-search').oninput = event => {
  for (const row of document.getElementById('model-options').children) row.hidden = !row.textContent.toLowerCase().includes(event.target.value.toLowerCase());
};
document.getElementById('effort').onchange = event => { changeConnection({type:'effort', effort:event.target.value}); picker.open = false; };
document.getElementById('effort').addEventListener('change',()=>{thinkingPicker.open=false;});
function bubble(role, text) {
  document.getElementById('welcome').classList.add('hidden');
  const row = document.createElement('div');
  row.className = `chat ${role === 'You' ? 'chat-end' : 'chat-start'}`;
  const label = document.createElement('div'); label.className = 'chat-header'; label.textContent = role;
  const body = document.createElement('div'); body.className = 'chat-bubble whitespace-pre-wrap break-words'; body.textContent = text;
  if(role==='Elpis')renderAssistant(body,text);
  row.append(label, body); messages.append(row); return body;
}
document.getElementById('composer').addEventListener('submit', event => {
  event.preventDefault();
  if(runtimeBusy || document.getElementById('send').disabled) return;
  const input = document.getElementById('prompt');
  if (!input.value.trim()) return;
  api.postMessage({ type: 'send', text: input.value }); input.value = '';
});
for (const type of ['reconnect', 'prune', 'provider', 'key', 'runtime']) document.getElementById(type).addEventListener('click', () => api.postMessage({ type }));
window.addEventListener('message', ({ data }) => {
  if(data.type==='approvalRequest') {
    document.getElementById('welcome').classList.add('hidden');
    const card=document.createElement('section');card.className='card card-border bg-base-200 my-3';card.dataset.approval=data.id;card.setAttribute('aria-label','Runtime approval');
    const body=document.createElement('div');body.className='card-body p-3 gap-2';
    const title=document.createElement('h3');title.className='card-title text-sm';title.textContent=data.title;
    const detail=document.createElement('pre');detail.className='text-xs whitespace-pre-wrap break-all max-h-60 overflow-auto';detail.textContent=data.detail;
    const actions=document.createElement('div');actions.className='card-actions justify-end';
    for(const [label,allow] of [['Reject',false],['Allow once',true]]){const button=document.createElement('button');button.type='button';button.className='btn btn-sm '+(allow?'btn-neutral':'btn-ghost');button.textContent=label;button.dataset.allow=String(allow);button.onclick=()=>{for(const sibling of actions.children)sibling.disabled=true;api.postMessage({type:'approvalResponse',id:data.id,allow});};actions.append(button);}
    body.append(title,detail,actions);card.append(body);messages.append(card);document.getElementById('conversation').scrollTop=messages.scrollHeight;
  }
  if(data.type==='approvalResolved') {
    const card=[...messages.querySelectorAll('[data-approval]')].find(card=>card.dataset.approval===data.id);
    if(card){const actions=card.querySelector('.card-actions');actions.replaceChildren();actions.textContent=data.allowed?'Allowed once':'Not allowed';}
  }
  if(data.type==='connectionReady') {connectionPending=false;updateSend();}
  if(data.type==='failure') {bubble('Could not complete the request',data.text);assistant=undefined;}
  if(data.type==='copied') {const button=document.querySelector(`[data-copy-id="${Number(data.id)}"]`);if(button)button.textContent='Copied';}
  if(data.type==='approvalMode') {
    const button=document.getElementById('approval-mode');button.title=`Permissions: ${data.mode.short} — ${data.mode.description}`;button.setAttribute('aria-label',`Permissions: ${data.mode.short}`);
    for(const option of document.querySelectorAll('[data-permission]')){option.setAttribute('aria-pressed',String(option.dataset.permission===data.mode.id));option.classList.toggle('bg-base-200',option.dataset.permission===data.mode.id);}
    document.getElementById('review-policy').textContent=data.mode.reviewEdits?'Review before edits':data.mode.id==='full'?'Full access':'Workspace edits allowed';
  }
  if(data.type==='selection') {const thinking=document.getElementById('thinking');thinking.title=`Thinking: ${data.effort || 'Default'}`;thinking.setAttribute('aria-label',thinking.title);}
  if(data.type==='openThinking')thinkingPicker.open=true;
  const conversation = document.getElementById('conversation');
  const follow = conversation.scrollHeight - conversation.scrollTop - conversation.clientHeight < 80;
  if (data.type === 'user') { bubble('You', data.text); assistant = undefined; }
  if (data.type === 'delta') { if (!assistant) assistant = bubble('Elpis', ''); renderAssistant(assistant,(assistant.dataset.source || '')+data.text); }
  if (data.type === 'status') document.getElementById('status').textContent = data.text;
  if(data.type==='preferences') {sendShortcut=data.sendShortcut;followupBehavior=data.followupBehavior || 'queue';showContextUsage=!!data.showContextUsage;renderContextUsage();updateSend();}
  if(data.type==='queue')renderQueue(data);
  if(data.type==='contextUsage'){lastContextUsage=data.usage;renderContextUsage();}
  if (data.type === 'history' && data.requestId === historyRequest) {
    const list=document.getElementById('history-list');if(!data.append)list.replaceChildren();
    for(const thread of data.threads) {
      const row=document.createElement('li');row.className='flex flex-row min-w-0';
      const actions=()=>api.postMessage({type:'historyAction',threadId:thread.id,title:thread.title,archived:historyArchived});
      const button=document.createElement('button');button.type='button';button.dataset.thread=thread.id;button.className='block flex-1 min-w-0 truncate';button.textContent=thread.title;button.title=thread.title;
      button.onclick=()=>{if(historyArchived)return actions();document.getElementById('history-status').textContent='Opening chat…';api.postMessage({type:'resume',threadId:thread.id});};
      const more=document.createElement('button');more.type='button';more.className='btn btn-xs btn-ghost';more.textContent='⋯';more.dataset.historyActions=thread.id;more.setAttribute('aria-label','Actions for '+thread.title);more.onclick=actions;
      row.append(button,more);list.append(row);
    }
    historyCursor=data.cursor;document.getElementById('history-more').classList.toggle('hidden',!historyCursor);
    document.getElementById('history-status').textContent=data.error || (list.children.length ? 'Chats saved by Elpis in this project' : 'No matching chats');
  }
  if(data.type==='historyError') document.getElementById('history-status').textContent=data.text;
  if(data.type==='historyChanged'){document.getElementById('history-panel').classList.remove('hidden');requestHistory();}
  if (data.type === 'transcript') { for(const message of data.messages) {if(message.role==='Tool')toolMessage(message);else bubble(message.role,message.text);} conversation.scrollTop=conversation.scrollHeight; }
  if (data.type === 'selection') { const label=catalog.find(m=>m.model===data.model)?.label || data.model; document.getElementById('model').textContent = `${label}${data.effort ? ' · '+data.effort : ''} ▾`; document.getElementById('model').title = `${data.provider} · ${data.model}`; }
  if (data.type === 'models' && data.requestId === modelRequest) {
    catalog = data.models;
    document.getElementById('model-status').textContent = data.error || (catalog.length ? '' : 'No models returned. Use a custom ID or change provider.');
    const list = document.getElementById('model-options'); list.replaceChildren();
    for (const model of catalog) {
      const row=document.createElement('li'); const button=document.createElement('button');
      button.type='button'; button.dataset.model=model.model; button.textContent=model.label; button.title=model.model;
      button.setAttribute('aria-pressed', String(model.model===data.current));
      if(model.model===data.current) { button.className='menu-active'; const check=document.createElement('span');check.textContent='✓';check.className='ml-auto';button.append(check); }
      button.onclick=()=>{picker.open=false;changeConnection({type:'chooseModel',model:model.model});};
      row.append(button);list.append(row);
    }
    const selected=catalog.find(m=>m.model===data.current);
    const effort=document.getElementById('effort');effort.replaceChildren();
    for(const value of ['',...(selected?.efforts || [])]) { const option=document.createElement('option');option.value=value;option.textContent=value || 'Default';option.selected=value===(data.effort || '');effort.append(option); }
    document.getElementById('effort-label').classList.toggle('hidden', !selected?.efforts?.length);
    document.getElementById('thinking-status').textContent=data.error || (selected?.efforts?.length?'':'This model uses its default thinking level.');
  }
  if (data.type === 'tool') { toolMessage(data); assistant = undefined; }
  if (data.type === 'identity') document.getElementById('identity').textContent = data.text;
  if (data.type === 'reset') { messages.replaceChildren(); assistant = undefined; document.getElementById('welcome').classList.remove('hidden'); document.getElementById('history-panel').classList.add('hidden'); }
  if (data.type === 'busy') { runtimeBusy=data.busy;updateSend();for (const id of ['provider', 'key', 'runtime']) document.getElementById(id).disabled = data.busy;for(const menu of [permissionsPicker,thinkingPicker,picker]){menu.querySelector('summary').setAttribute('aria-disabled',String(data.busy));if(data.busy)menu.open=false;} }
  if (data.type === 'restoreDraft') {const input=document.getElementById('prompt');if(!input.value)input.value=data.text;else if(input.value!==data.text && !input.value.startsWith(data.text+'\n\n'))input.value=data.text+'\n\n'+input.value;}
  if (data.type === 'user' || (follow && ['delta', 'tool'].includes(data.type))) conversation.scrollTop = conversation.scrollHeight;
});
api.postMessage({ type: 'ready' });
