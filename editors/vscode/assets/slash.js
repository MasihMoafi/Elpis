'use strict';
const slashCommands=[
 ['model','Choose model and thinking level','model'],['permissions','Choose what Elpis may do','approval-mode'],
 ['new','Start a new conversation','reconnect'],['clear','Start a new conversation','reconnect'],['resume','Open saved conversations','history'],
 ['settings','Open Elpis settings','settings'],['compact','Summarize this conversation','compact'],['prune','Enable Smart Pruning for subsequent turns','prune'],['review','Review current changes','review'],
 ['copy','Copy the last prompt and response','copy'],['usage','View account usage and limits','usage'],['mcp','Inspect MCP servers','mcp'],['hooks','Inspect lifecycle hooks','hooks'],['plugins','Inspect plugins','plugins'],['debug-config','Open config.toml','open-config'],
];
const slashInput=document.getElementById('prompt');const slashMenu=document.getElementById('slash-menu');let slashIndex=0,slashMatches=[],slashDismissed=false;
slashInput.setAttribute('aria-controls','slash-menu');slashInput.setAttribute('aria-autocomplete','list');
function renderSlash(){
 const query=slashInput.value.match(/^\/([^\s]*)$/);slashMatches=query?slashCommands.filter(command=>command[0].startsWith(query[1].toLowerCase())):[];
 const visible=!!query&&!slashDismissed&&!runtimeBusy&&!connectionPending;
 slashMenu.classList.toggle('hidden',!visible);slashInput.setAttribute('aria-expanded',String(visible));slashMenu.replaceChildren();
 if(!visible){slashInput.removeAttribute('aria-activedescendant');return;}
 slashIndex=Math.max(0,Math.min(slashIndex,slashMatches.length-1));
 if(!slashMatches.length){const text=document.createElement('li');text.className='p-2 text-xs opacity-70';text.textContent='No matching commands';slashMenu.append(text);slashInput.removeAttribute('aria-activedescendant');return;}
 for(const [index,command] of slashMatches.entries()){
  const row=document.createElement('li');row.setAttribute('role','presentation');const button=document.createElement('button');button.type='button';button.id='slash-option-'+index;button.dataset.slash=command[0];button.setAttribute('role','option');button.setAttribute('aria-selected',String(index===slashIndex));button.className='block! w-full text-left py-2 '+(index===slashIndex?'menu-active':'');
  const title=document.createElement('span');title.className='block font-medium';title.textContent='/'+command[0];const detail=document.createElement('span');detail.className='block text-xs opacity-70 font-normal whitespace-normal';detail.textContent=command[1];button.append(title,detail);button.onclick=event=>{event.stopPropagation();runSlash(command);};row.append(button);slashMenu.append(row);
 }
 slashInput.setAttribute('aria-activedescendant','slash-option-'+slashIndex);
}
function runSlash(command){
 if(runtimeBusy||connectionPending)return;
 const text=slashInput.value;slashInput.value='';slashDismissed=true;renderSlash();
 const action=command[2];
 if(['compact','review','prune'].includes(action))assistant=undefined;
 if(['model','approval-mode'].includes(action)){document.getElementById(action).click();return;}
 if(['reconnect','history','prune','open-config'].includes(action)){document.getElementById(action).click();return;}
 if(action==='copy'){
  const rows=[...messages.querySelectorAll('.chat')];const last=rows.map(row=>({role:row.querySelector('.chat-header')?.textContent,text:row.querySelector('.chat-bubble')?.dataset.source||row.querySelector('.chat-bubble')?.textContent}));
  const reply=last.findLastIndex(row=>row.role==='Elpis');const prompt=last.slice(0,reply).findLast(row=>row.role==='You');
  if(reply<0){slashInput.value=text;document.getElementById('status').textContent='No response to copy yet.';return;}
  api.postMessage({type:'copy',id:0,text:[prompt&&`You\n\n${prompt.text}`,`Elpis\n\n${last[reply].text}`].filter(Boolean).join('\n\n')});document.getElementById('status').textContent='Copying last exchange…';return;
 }
 api.postMessage(['compact','review'].includes(action)?{type:action,text}:{type:'settings',section:action==='settings'?'general':action});
}
function submitSlash(event){if(!slashInput.value.startsWith('/'))return false;event.preventDefault();event.stopImmediatePropagation();
 if(runtimeBusy||connectionPending){document.getElementById('status').textContent='Finish or stop the response before running a command.';return true;}
 const command=slashCommands.find(command=>slashInput.value.trim()==='/'+command[0]);
 if(command)runSlash(command);else{document.getElementById('status').textContent='Unknown command or unsupported arguments. Type / to choose a command.';slashDismissed=false;renderSlash();}return true;
}
slashInput.addEventListener('input',()=>{slashIndex=0;slashDismissed=false;renderSlash();});
slashInput.addEventListener('keydown',event=>{
 if(event.isComposing)return;
 if(event.key==='Escape'&&!slashMenu.classList.contains('hidden')){event.preventDefault();event.stopImmediatePropagation();slashDismissed=true;renderSlash();return;}
 if(!slashMenu.classList.contains('hidden')&&['ArrowDown','ArrowUp'].includes(event.key)){event.preventDefault();event.stopImmediatePropagation();if(slashMatches.length)slashIndex=(slashIndex+(event.key==='ArrowDown'?1:-1)+slashMatches.length)%slashMatches.length;renderSlash();document.getElementById('slash-option-'+slashIndex)?.scrollIntoView({block:'nearest'});return;}
 if(!slashMenu.classList.contains('hidden')&&event.key==='Tab'&&slashMatches.length){event.preventDefault();event.stopImmediatePropagation();slashInput.value='/'+slashMatches[slashIndex][0];slashIndex=0;renderSlash();return;}
 if(event.key==='Enter'&&!event.shiftKey&&!event.altKey&&slashInput.value.startsWith('/')){
  if(!slashMenu.classList.contains('hidden')&&slashMatches.length&&!/\s/.test(slashInput.value)){event.preventDefault();event.stopImmediatePropagation();runSlash(slashMatches[slashIndex]);}else submitSlash(event);
 }
},true);
document.getElementById('composer').addEventListener('submit',submitSlash,true);
window.addEventListener('message',({data})=>{if(data.type==='busy'||data.type==='connectionReady')queueMicrotask(renderSlash);if(data.type==='copied'&&data.id===0)document.getElementById('status').textContent='Last exchange copied.';});
