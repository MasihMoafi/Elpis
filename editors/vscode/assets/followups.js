'use strict';
let followupBehavior='queue',showContextUsage=false,lastContextUsage;
function sendFollowup(mode) {
  const input=document.getElementById('prompt');if(!input.value.trim())return;
  api.postMessage({type:'followup',mode,text:input.value});input.value='';
}
function renderQueue(data) {
  document.getElementById('queued-panel').classList.toggle('hidden',!data.items.length);
  document.getElementById('queue-status').textContent=`${data.items.length} queued${data.paused?' · paused':''}`;
  document.getElementById('resume-queue').classList.toggle('hidden',!data.paused);
  const list=document.getElementById('queued-list');list.replaceChildren();
  for(const item of data.items) {
    const row=document.createElement('li');row.className='flex items-center gap-2 py-1';row.dataset.queued=item.id;
    const text=document.createElement('span');text.className='truncate flex-1 min-w-0';text.textContent=item.text;text.title=item.text;
    const remove=document.createElement('button');remove.type='button';remove.className='btn btn-xs btn-ghost';remove.textContent='×';remove.setAttribute('aria-label','Remove queued message');remove.onclick=()=>api.postMessage({type:'removeQueued',id:item.id});
    row.append(text,remove);list.append(row);
  }
}
document.getElementById('resume-queue').onclick=()=>api.postMessage({type:'resumeQueue'});
function renderContextUsage() {
  const node=document.getElementById('context-usage');node.classList.toggle('hidden',!showContextUsage);
  const used=Number(lastContextUsage?.last?.totalTokens),windowSize=Number(lastContextUsage?.modelContextWindow);
  if(!Number.isFinite(used) || !Number.isFinite(windowSize) || windowSize<=0){node.textContent='Context usage appears after a response';node.removeAttribute('title');return;}
  node.textContent=`Context: ${Math.round(Math.max(0,Math.min(1,used/windowSize))*100)}% used`;
  node.title=`Last reported context: ${used.toLocaleString()} tokens; model window: ${windowSize.toLocaleString()} tokens`;
}
