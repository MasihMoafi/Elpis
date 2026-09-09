'use strict';
const ledgerElement=document.getElementById('context-ledger');
let ledgerState={},ledgerPending=false;
const ledgerText=(id,text)=>{document.getElementById(id).textContent=text;};
const ledgerNumber=value=>Number.isFinite(value)?value.toLocaleString():'—';
function ledgerRows(id,entries){const target=document.getElementById(id);target.replaceChildren();for(const [label,value] of entries){const row=document.createElement('div');row.className='flex justify-between gap-2';const term=document.createElement('dt'),detail=document.createElement('dd');term.textContent=label;detail.textContent=ledgerNumber(value);row.append(term,detail);target.append(row);}}
function renderLedger(){
 const state=ledgerState,toggle=document.getElementById('smart-pruning-toggle');
 ledgerText('ledger-context',state.used==null?'Context usage not yet reported.':`${ledgerNumber(state.used)} / ${ledgerNumber(state.window)} tokens${state.percent==null?'':` · ${state.percent}%`}`);
 ledgerText('smart-pruning-state',`Smart Pruning: ${state.enabled==null?'waiting for runtime':state.enabled?'on':'off'}`);
 toggle.textContent=state.enabled?'Disable':'Enable';toggle.disabled=ledgerPending||runtimeBusy||state.enabled==null;
 ledgerRows('ledger-pruning',[['Estimated tokens removed',state.saved],['Outputs compressed',state.admitted],['Optimizer tokens reported',state.optimizerTokens],['Optimizer calls',state.optimizerRequests],['Calls with usage reported',state.optimizerUsageReports],['Failed batches (originals retained)',state.failures]]);
 const names={systemInstructions:'System instructions',developerMessages:'Developer instructions',userMessages:'User messages',agentMessages:'Assistant messages',reasoning:'Reasoning',toolCalls:'Tool calls',toolResults:'Tool results',toolDefinitions:'Tool definitions',outputSchema:'Output schema',unrecognizedItems:'Other items',estimatedTotal:'Estimated total'};
 if(state.attribution)ledgerRows('ledger-attribution',Object.entries(names).map(([key,label])=>[label,state.attribution[key]]));else ledgerText('ledger-attribution','Not yet reported.');
 ledgerText('ledger-attempt',state.latestAttempt?`Latest attempt: ${state.latestAttempt.status} · ${state.latestAttempt.modelSlug} · ${ledgerNumber(state.latestAttempt.latencyMs)} ms`:'No optimizer attempt reported.');
 for(const id of ['goal-save','goal-clear'])document.getElementById(id).disabled=ledgerPending||runtimeBusy;
}
document.getElementById('ledger-open').onclick=()=>{ledgerElement.classList.remove('hidden');document.getElementById('settings').classList.add('hidden');document.getElementById('history-panel').classList.add('hidden');document.getElementById('ledger-open').setAttribute('aria-expanded','true');api.postMessage({type:'ledgerRefresh'});};
document.getElementById('ledger-close').onclick=()=>{ledgerElement.classList.add('hidden');document.getElementById('ledger-open').setAttribute('aria-expanded','false');};
document.getElementById('smart-pruning-toggle').onclick=()=>{if(ledgerState.enabled==null)return;ledgerPending=true;renderLedger();api.postMessage({type:'smartPruning',enabled:!ledgerState.enabled});};
document.getElementById('goal-save').onclick=()=>{const objective=document.getElementById('goal-objective').value.trim();if(!objective){ledgerText('ledger-status','Enter a goal objective.');return;}api.postMessage({type:'goalSet',objective});};
document.getElementById('goal-clear').onclick=()=>api.postMessage({type:'goalClear'});
window.addEventListener('message',({data})=>{
 if(data.type==='ledger'){ledgerState=data.state;ledgerPending=false;renderLedger();}
 if(data.type==='goal')ledgerText('ledger-goal',data.goal?`${data.goal.objective}\n${data.goal.status} · ${ledgerNumber(data.goal.tokensUsed)} tokens used`:'No active goal.');
 if(data.type==='ledgerStatus'){ledgerPending=false;ledgerText('ledger-status',data.text);renderLedger();}
 if(data.type==='reset'){ledgerState={};ledgerText('ledger-goal','No goal loaded.');renderLedger();}
 if(data.type==='busy')renderLedger();
});
